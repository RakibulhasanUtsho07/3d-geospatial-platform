import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import {
  createFloorPlanModelCandidate,
  loadFloorPlanModelCandidate,
} from "../src/core/building-generation/floor-plan-model-job.mjs";

const basePlan = JSON.parse(await readFile(new URL("./fixtures/demo-floor-plan-geometry.json", import.meta.url), "utf8"));
const PDF_BYTES = Buffer.from("%PDF-1.7\nprivate floor plan test fixture\n", "utf8");

async function makeWorkspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "floor-plan-model-job-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  await writeFile(path.join(root, "uploads", "floor-plan.pdf"), PDF_BYTES);
  const source = await ingestMediaFile({
    workspaceRoot: root,
    sourcePath: "uploads/floor-plan.pdf",
    buildingId: "dhaka-demo",
    sourceId: "measured-plan-pdf",
    kind: "floor-plan",
    licence: "CC BY 4.0",
    usageStatus: "unreviewed",
  });
  return { root, source };
}

function planFrom(source) {
  return {
    ...structuredClone(basePlan),
    source: { sourceId: source.record.id, sha256: source.record.sha256 },
  };
}

test("builds a private floor-plan candidate from an uploaded source and verifies the GLB on retrieval", async (t) => {
  const { root, source } = await makeWorkspace(t);
  const result = await createFloorPlanModelCandidate({
    workspaceRoot: root,
    floorPlan: planFrom(source),
  });
  assert.equal(result.status, "candidate-requires-human-review");
  assert.equal(result.sourceId, "measured-plan-pdf");
  assert.equal(result.sourceSha256, source.record.sha256);
  assert.equal(result.report.input.sourceEvidenceVerified, true);
  assert.equal(result.report.input.verifiedSourceSha256, source.record.sha256);
  assert.equal(result.report.input.sourceUsageStatus, "unreviewed");
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
  assert.match(result.candidateUrl, /^\/api\/building-generation\/floor-plan-models\/dhaka-demo\/floorplan-/);
  assert.match(result.modelUrl, /\/model$/);
  assert.ok(result.report.warnings.some((warning) => warning.includes("Source reuse rights are not marked approved")));

  const candidateRoot = path.join(root, ".building-engine", "floor-plan-candidates", "dhaka-demo", result.candidateId);
  const [savedPlan, savedModel, savedReport, loaded] = await Promise.all([
    readFile(path.join(candidateRoot, "floor-plan.json"), "utf8"),
    readFile(path.join(candidateRoot, "model.glb")),
    readFile(path.join(candidateRoot, "report.json"), "utf8"),
    loadFloorPlanModelCandidate({ workspaceRoot: root, buildingId: "dhaka-demo", candidateId: result.candidateId }),
  ]);
  assert.equal(JSON.parse(savedPlan).id, "ground-floor");
  assert.equal(savedModel.readUInt32LE(0), 0x46546c67);
  assert.equal(loaded.modelSha256, result.modelSha256);
  assert.equal(loaded.report.input.sourceEvidenceVerified, true);
  assert.equal(JSON.parse(savedReport).output.sha256, result.modelSha256);
  assert.equal((await stat(path.join(candidateRoot, "model.glb"))).mode & 0o777, 0o600);
});

test("refuses a source checksum mismatch without creating a candidate", async (t) => {
  const { root, source } = await makeWorkspace(t);
  const plan = planFrom(source);
  plan.source.sha256 = "0".repeat(64);
  await assert.rejects(
    createFloorPlanModelCandidate({ workspaceRoot: root, floorPlan: plan }),
    /does not match the verified uploaded source bytes/,
  );
  await assert.rejects(
    stat(path.join(root, ".building-engine", "floor-plan-candidates", "dhaka-demo")),
    { code: "ENOENT" },
  );
});

test("requires an uploaded source explicitly classified as a floor plan", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "floor-plan-wrong-kind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  await writeFile(path.join(root, "uploads", "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const image = await ingestMediaFile({
    workspaceRoot: root,
    sourcePath: "uploads/image.png",
    buildingId: "dhaka-demo",
    sourceId: "not-a-plan",
    kind: "image",
    licence: "CC BY 4.0",
  });
  const plan = planFrom({ record: { ...image.record, id: "not-a-plan", sha256: image.record.sha256 } });
  await assert.rejects(
    createFloorPlanModelCandidate({ workspaceRoot: root, floorPlan: plan }),
    /uploaded with kind=floor-plan/,
  );
});

test("detects candidate GLB tampering before returning a model", async (t) => {
  const { root, source } = await makeWorkspace(t);
  const result = await createFloorPlanModelCandidate({ workspaceRoot: root, floorPlan: planFrom(source) });
  const modelPath = path.join(
    root, ".building-engine", "floor-plan-candidates", "dhaka-demo", result.candidateId, "model.glb",
  );
  const modelBytes = await readFile(modelPath);
  modelBytes[modelBytes.length - 1] ^= 0xff;
  await writeFile(modelPath, modelBytes);
  await assert.rejects(
    loadFloorPlanModelCandidate({ workspaceRoot: root, buildingId: "dhaka-demo", candidateId: result.candidateId }),
    /checksum does not match/,
  );
});
