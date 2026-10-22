import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimNextGenerationJob, completeGenerationJob, enqueueGenerationJob, getGenerationJob } from "../src/core/building-generation/generation-job-queue.mjs";
import { reviewGenerationJob, REQUIRED_GENERATION_REVIEW_CHECKS } from "../src/core/building-generation/generation-job-review.mjs";
import { publishApprovedGenerationJob } from "../src/core/building-generation/publish-approved-generation-job.mjs";
import { getActivePublishedModels, validatePublishedModelCatalog } from "../src/core/building-generation/published-model-catalog-reader.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function makeGlb(seed = "publish-test") {
  const payload = Buffer.from(JSON.stringify({ asset: { version: "2.0", generator: seed } }));
  const paddedLength = Math.ceil(payload.length / 4) * 4;
  const chunk = Buffer.alloc(paddedLength, 0x20);
  payload.copy(chunk);
  const glb = Buffer.alloc(20 + chunk.length);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(chunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  chunk.copy(glb, 20);
  return glb;
}

async function makeApprovedJob(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "publish-approved-generation-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const queued = await enqueueGenerationJob({ workspaceRoot, input: { buildingSpec: fixture, strategy: "procedural", sources: [] } });
  await claimNextGenerationJob({ workspaceRoot, workerId: "publish-test-worker" });
  const workflowRelative = path.posix.join(".building-engine", "jobs", fixture.id, queued.jobId + "-workflow");
  const workflowDirectory = path.join(workspaceRoot, ...workflowRelative.split("/"));
  await mkdir(workflowDirectory, { recursive: true });
  const modelBytes = makeGlb();
  const modelPath = path.posix.join(workflowRelative, "model.glb");
  const reportPath = path.posix.join(workflowRelative, "workflow-report.json");
  await writeFile(path.join(workflowDirectory, "model.glb"), modelBytes);
  const report = {
    status: "completed-requires-review",
    output: { modelSha256: hash(modelBytes), modelBytes: modelBytes.length },
    mapReady: false,
    publicationEligible: false,
  };
  await writeFile(path.join(workflowDirectory, "workflow-report.json"), JSON.stringify(report, null, 2));
  await completeGenerationJob({
    workspaceRoot,
    jobId: queued.jobId,
    result: { status: "completed-requires-review", modelPath, reportPath, modelSha256: hash(modelBytes), modelBytes: modelBytes.length, mapReady: false, publicationEligible: false },
  });
  const checks = Object.fromEntries(REQUIRED_GENERATION_REVIEW_CHECKS.map((key) => [key, true]));
  const reviewed = await reviewGenerationJob({
    workspaceRoot,
    jobId: queued.jobId,
    input: {
      decision: "approved",
      reviewer: "independent-operator",
      notes: "Reviewed reference imagery, dimensions, scale, georeference and generated QA report.",
      checks,
    },
  });
  return { workspaceRoot, jobId: queued.jobId, modelBytes, reviewed };
}

const placement = {
  position: { longitude: 90.406, latitude: 23.7086, height: 0 },
  headingDegrees: 0,
  pitchDegrees: 0,
  rollDegrees: 0,
  scale: 1,
  upAxis: "Y",
  forwardAxis: "Z",
};

test("publishes only an approved, hash-matching review with explicit map placement", async (t) => {
  const setup = await makeApprovedJob(t);
  const result = await publishApprovedGenerationJob({ ...setup, placement });
  assert.equal(result.jobId, setup.jobId);
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
  assert.equal(result.placement.longitude, placement.position.longitude);
  assert.match(result.assetUrl, /^\/models\/generated\//);
  const manifestPath = path.join(setup.workspaceRoot, "public", "models", "generated", "manifest.json");
  const catalog = validatePublishedModelCatalog(JSON.parse(await readFile(manifestPath, "utf8")));
  assert.equal(catalog.models.length, 1);
  const active = getActivePublishedModels(catalog)[0];
  assert.equal(active.definition.id, fixture.id);
  assert.equal(active.sha256, result.modelSha256);
  assert.equal(active.review.reviewer, "independent-operator");
  const asset = await readFile(path.join(setup.workspaceRoot, "public", result.assetUrl.slice(1)));
  assert.equal(hash(asset), result.modelSha256);
  const unchangedJob = await getGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: setup.jobId });
  assert.equal(unchangedJob.review.decision, "approved");
  assert.equal(unchangedJob.mapReady, false);
  assert.equal(unchangedJob.publicationEligible, false);
});

test("refuses publication without placement or without an approved review", async (t) => {
  const setup = await makeApprovedJob(t);
  await assert.rejects(publishApprovedGenerationJob({ ...setup, placement: {} }), /Explicit model placement/);
  const queued = await enqueueGenerationJob({ workspaceRoot: setup.workspaceRoot, input: { buildingSpec: fixture, strategy: "procedural", sources: [] } });
  await assert.rejects(publishApprovedGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: queued.jobId, placement }), /Only completed generation jobs/);
});

test("refuses publication when the approved model or review evidence changes", async (t) => {
  const setup = await makeApprovedJob(t);
  const recordPath = path.join(setup.workspaceRoot, setup.review.job.review.recordPath);
  await writeFile(recordPath, JSON.stringify({ tampered: true }));
  await assert.rejects(publishApprovedGenerationJob({ ...setup, placement }), /review record checksum mismatch/);
});

test("refuses publication if QA report changed since review", async (t) => {
  const setup = await makeApprovedJob(t);
  const job = await getGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: setup.jobId });
  await writeFile(path.join(setup.workspaceRoot, job.result.reportPath), JSON.stringify({ status: "completed-requires-review", mapReady: false, publicationEligible: false, output: { modelSha256: job.result.modelSha256 } }));
  await assert.rejects(publishApprovedGenerationJob({ ...setup, placement }), /QA report changed after approval/);
});
