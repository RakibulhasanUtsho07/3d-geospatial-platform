import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reviewedAt = "2026-10-26T10:00:00Z";
const candidateBytes = Buffer.from("candidate GLB byte-integrity fixture; structural QA is a separate check");
const referenceBytes = Buffer.from("independent survey source byte-integrity fixture");

function polygon() {
  return [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }];
}
function checkPoints() {
  return [
    { id: "gcp-check-01", x: 0, y: 0, z: 0 },
    { id: "gcp-check-02", x: 2, y: 0, z: 0 },
    { id: "gcp-check-03", x: 2, y: 0, z: 2 },
  ];
}
function makeManifest() {
  const glbSha256 = hash(candidateBytes);
  const sourceSha256 = hash(referenceBytes);
  return {
    schemaVersion: "1.0.0", evaluationId: "cli-site-eval-01", buildingId: "cli-site-building",
    generatedAt: "2026-10-27T08:00:00Z",
    candidate: {
      glbPath: "evidence/candidate.glb", glbSha256, geometrySourceGlbSha256: glbSha256,
      coordinateFrameId: "site-local-enu-01", units: "m", footprint: polygon(),
      dimensionsM: { widthM: 2, depthM: 2, heightM: 3 }, checkPoints: checkPoints(),
    },
    reference: {
      sourcePath: "evidence/survey.json", sourceId: "site-survey-01",
      sourceSha256, geometrySourceSha256: sourceSha256, evidenceBasis: "surveyed",
      sourceDescription: "Independent survey source fixture.", reviewedBy: "reviewer-a", reviewedAt,
      coordinateFrameId: "site-local-enu-01", units: "m", footprint: polygon(),
      dimensionsM: { widthM: 2, depthM: 2, heightM: 3 },
      checkPoints: checkPoints().map((point) => ({ ...point, independentOfFit: true })),
    },
    tolerances: {
      footprintAreaRelativeErrorPercent: 5, footprintBoundaryP95M: 0.1, footprintBoundaryMaxM: 0.2,
      dimensionRelativeErrorPercent: 5, checkPointRmseM: 0.1, checkPointMaxM: 0.2,
    },
  };
}
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "independent-building-truth-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "evidence"));
  await writeFile(path.join(root, "evidence/candidate.glb"), candidateBytes);
  await writeFile(path.join(root, "evidence/survey.json"), referenceBytes);
  await writeFile(path.join(root, "evaluation.json"), JSON.stringify(makeManifest(), null, 2));
  return { root };
}
function run(root, output) {
  return spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/evaluate-independent-building-truth.mjs", import.meta.url)),
    "evaluation.json", output, "--root=" + root,
  ], { cwd: root, encoding: "utf8" });
}

test("verifies exact candidate/reference bytes and writes a review-required report", async (t) => {
  const { root } = await setup(t);
  const execution = run(root, "report.json");
  assert.equal(execution.status, 0, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
  assert.equal(report.status, "benchmark-review-required");
  assert.equal(report.assetIntegrity.every((item) => item.status === "passed"), true);
  assert.equal(report.policy.acceptanceEligible, false);
  assert.equal(report.policy.publicationEligible, false);
  assert.equal(report.policy.mapReady, false);
});


test("rejects Windows backslash paths before reading evidence", async (t) => {
  const { root } = await setup(t);
  const manifest = makeManifest();
  manifest.candidate.glbPath = "evidence\\candidate.glb";
  await writeFile(path.join(root, "evaluation.json"), JSON.stringify(manifest, null, 2));
  const execution = run(root, "unsafe-path-report.json");
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /safe project-relative path/);
});

test("reports an exact-byte mismatch as failed instead of trusting stale reference metrics", async (t) => {
  const { root } = await setup(t);
  await writeFile(path.join(root, "evidence/survey.json"), "changed after measurement review");
  const execution = run(root, "report-failed.json");
  assert.equal(execution.status, 1, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "report-failed.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.failures.some((check) => check.id === "reference-source-byte-integrity"));
  assert.equal(report.policy.acceptanceEligible, false);
});
