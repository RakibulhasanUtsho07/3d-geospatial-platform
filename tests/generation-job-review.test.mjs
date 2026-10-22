import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimNextGenerationJob, completeGenerationJob, enqueueGenerationJob, getGenerationJob } from "../src/core/building-generation/generation-job-queue.mjs";
import { reviewGenerationJob, REQUIRED_GENERATION_REVIEW_CHECKS } from "../src/core/building-generation/generation-job-review.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
const HASH = (bytes) => createHash("sha256").update(bytes).digest("hex");

function makeGlb(seed = "review-test") {
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

async function setupCompletedJob(t) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "generation-review-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const queued = await enqueueGenerationJob({
    workspaceRoot,
    input: { buildingSpec: fixture, strategy: "procedural", sources: [] },
  });
  await claimNextGenerationJob({ workspaceRoot, workerId: "review-test-worker" });
  const workflowRelative = path.posix.join(".building-engine", "jobs", fixture.id, queued.jobId + "-workflow");
  const workflowDirectory = path.join(workspaceRoot, ...workflowRelative.split("/"));
  await mkdir(workflowDirectory, { recursive: true });
  const modelBytes = makeGlb();
  const modelPath = path.posix.join(workflowRelative, "model.glb");
  const reportPath = path.posix.join(workflowRelative, "workflow-report.json");
  await writeFile(path.join(workflowDirectory, "model.glb"), modelBytes);
  const report = {
    status: "completed-requires-review",
    output: { modelSha256: HASH(modelBytes), modelBytes: modelBytes.length },
    mapReady: false,
    publicationEligible: false,
  };
  await writeFile(path.join(workflowDirectory, "workflow-report.json"), JSON.stringify(report, null, 2));
  await completeGenerationJob({
    workspaceRoot,
    jobId: queued.jobId,
    result: {
      status: "completed-requires-review",
      modelPath,
      reportPath,
      modelSha256: HASH(modelBytes),
      modelBytes: modelBytes.length,
      mapReady: false,
      publicationEligible: false,
    },
  });
  return { workspaceRoot, jobId: queued.jobId, modelPath, reportPath, modelBytes };
}

function reviewInput(overrides = {}) {
  const checks = Object.fromEntries(REQUIRED_GENERATION_REVIEW_CHECKS.map((key) => [key, true]));
  return {
    decision: "approved",
    reviewer: "local-reviewer",
    notes: "Reviewed candidate, QA report, rights, dimensions and georeferencing evidence.",
    checks,
    ...overrides,
  };
}

test("records an approval only after matching GLB and QA hashes; still blocks publication", async (t) => {
  const setup = await setupCompletedJob(t);
  const result = await reviewGenerationJob({ ...setup, input: reviewInput() });
  assert.equal(result.review.decision, "approved");
  assert.equal(result.review.candidate.modelSha256, HASH(setup.modelBytes));
  assert.equal(result.job.review.decision, "approved");
  assert.equal(result.job.mapReady, false);
  assert.equal(result.job.publicationEligible, false);
  assert.equal(result.review.publicationAction, "not-performed");
  const evidence = JSON.parse(await readFile(path.join(setup.workspaceRoot, result.job.review.recordPath), "utf8"));
  assert.equal(evidence.reviewId, result.review.reviewId);
  assert.equal(HASH(Buffer.from(JSON.stringify(evidence, null, 2) + "\n")), result.job.review.recordSha256);
  await assert.rejects(reviewGenerationJob({ ...setup, input: reviewInput() }), /immutable/);
});

test("refuses approval when any mandatory review checklist item is false", async (t) => {
  const setup = await setupCompletedJob(t);
  const checks = Object.fromEntries(REQUIRED_GENERATION_REVIEW_CHECKS.map((key) => [key, true]));
  checks.horizontalGeoreferenceVerified = false;
  await assert.rejects(reviewGenerationJob({ ...setup, input: reviewInput({ checks }) }), /every review check/);
  assert.equal((await getGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: setup.jobId })).review, undefined);
});

test("refuses review if model bytes or report do not match the completed job", async (t) => {
  const setup = await setupCompletedJob(t);
  await writeFile(path.join(setup.workspaceRoot, setup.modelPath), makeGlb("tampered-after-completion"));
  await assert.rejects(reviewGenerationJob({ ...setup, input: reviewInput() }), /SHA-256 mismatch/);
  assert.equal((await getGenerationJob({ workspaceRoot: setup.workspaceRoot, jobId: setup.jobId })).review, undefined);
});

test("allows a recorded rejection with explicit notes but keeps publication disabled", async (t) => {
  const setup = await setupCompletedJob(t);
  const checks = Object.fromEntries(REQUIRED_GENERATION_REVIEW_CHECKS.map((key) => [key, false]));
  const result = await reviewGenerationJob({
    ...setup,
    input: reviewInput({
      decision: "rejected",
      notes: "Facade details and ground-control evidence do not match the reference.",
      checks,
    }),
  });
  assert.equal(result.job.review.decision, "rejected");
  assert.equal(result.job.publicationEligible, false);
  assert.ok(result.job.review.recordPath);
});

test("will not review queued jobs or accept malformed review identities/checklists", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "generation-review-queued-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const queued = await enqueueGenerationJob({ workspaceRoot, input: { buildingSpec: fixture, strategy: "procedural", sources: [] } });
  await assert.rejects(reviewGenerationJob({
    workspaceRoot, jobId: queued.jobId, input: reviewInput(),
  }), /Only completed/);
  await assert.rejects(reviewGenerationJob({
    workspaceRoot, jobId: queued.jobId, input: reviewInput({ reviewer: " " }),
  }), /reviewer is required/);
});
