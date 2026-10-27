import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MODEL_TO_EVALUATION, createBuildingGlb, surveyGeometryDocument } from "./fixtures/glb-geometry-fixture.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runnerSource = fileURLToPath(new URL("../scripts/run-brf25-geometry-validation.mjs", import.meta.url));
const copyMap = [
  ["scripts/prepare-independent-building-truth-manifest.mjs", "../scripts/prepare-independent-building-truth-manifest.mjs"],
  ["scripts/evaluate-independent-building-truth.mjs", "../scripts/evaluate-independent-building-truth.mjs"],
  ["src/core/building-generation/glb-geometry-extraction.mjs", "../src/core/building-generation/glb-geometry-extraction.mjs"],
  ["src/core/building-generation/independent-reference-geometry-adapter.mjs", "../src/core/building-generation/independent-reference-geometry-adapter.mjs"],
  ["src/core/building-generation/geometry-extraction-provenance.mjs", "../src/core/building-generation/geometry-extraction-provenance.mjs"],
  ["src/core/building-generation/independent-building-truth-evaluator.mjs", "../src/core/building-generation/independent-building-truth-evaluator.mjs"],
];

async function setup(t, { staleConfigHash = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf25-geometry-chain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of [
    "scripts", "src/core/building-generation", "evidence", "configs",
    "workspace/output", "workspace/.building-engine/authorizations/building-01",
  ]) await mkdir(path.join(root, dir), { recursive: true });
  for (const [target, source] of copyMap) {
    await writeFile(path.join(root, target), await readFile(fileURLToPath(new URL(source, import.meta.url))));
  }

  const glb = createBuildingGlb();
  const reference = Buffer.from(JSON.stringify(
    surveyGeometryDocument({ coordinateFrameId: "survey-local-frame-v1", localCoordinates: true }), null, 2) + "\n");
  await writeFile(path.join(root, "workspace/output/candidate.glb"), glb);
  await writeFile(path.join(root, "evidence/survey.json"), reference);

  const candidateHash = hash(glb);
  const config = {
    schemaVersion: "1.0.0",
    evaluationId: "brf25-synthetic-test-01",
    buildingId: "brf25-synthetic-building-01",
    generatedAt: "2026-10-27T09:00:00.000Z",
    extractorCommitSha: "1234567890abcdef1234567890abcdef12345678",
    candidate: {
      glbPath: "workspace/output/candidate.glb",
      expectedGlbSha256: staleConfigHash ? hash(Buffer.from("stale")) : candidateHash,
      coordinateFrameId: "test-building-frame-y-up-v1",
      units: "m",
      modelCoordinateFrameId: "synthetic-unit-test-frame",
      modelToEvaluationFrameMatrix4x4: MODEL_TO_EVALUATION,
      checkPointBindings: [
        { id: "survey-check-01", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 0 },
        { id: "survey-check-02", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 1 },
        { id: "survey-check-03", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 6 },
      ],
    },
    reference: {
      sourcePath: "evidence/survey.json",
      expectedSourceSha256: hash(reference),
      sourceCoordinateFrameId: "survey-local-frame-v1",
      sourceToEvaluationFrameMatrix4x4: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 11, 1, 22, 1],
    },
    tolerances: {
      footprintAreaRelativeErrorPercent: 5, footprintBoundaryP95M: 0.1, footprintBoundaryMaxM: 0.2,
      dimensionRelativeErrorPercent: 5, checkPointRmseM: 0.1, checkPointMaxM: 0.2,
      surfaceDistanceP95M: 0.1, surfaceDistanceMaxM: 0.2,
    },
  };
  await writeFile(path.join(root, "configs/evaluation.json"), JSON.stringify(config, null, 2) + "\n");
  const authorization = {
    schemaVersion: "1.0.0",
    recordType: "brf-24-colmap-execution-authorization",
    status: "candidate-generated-requires-review",
    candidateGlbGenerated: true,
    candidateGlb: { sha256: candidateHash, relativePath: "output/candidate.glb", byteSize: glb.byteLength },
    humanDecision: {
      overallDisposition: "continue-to-reconstruction-preflight",
      reviewer: "synthetic-fixture-reviewer",
      sha256: hash(Buffer.from("synthetic-review-only")),
    },
    preflightReport: { sha256: hash(Buffer.from("synthetic-preflight-only")) },
    profile: { sha256: hash(Buffer.from("synthetic-profile-only")) },
    toolchain: { name: "COLMAP", version: "4.2.1", versionRecheckedImmediatelyBeforeRun: true },
    coordinateFrame: { policy: "local-only-unscaled-not-georeferenced", registrationToGps: false },
    scaleCalibration: { status: "not-calibrated" },
    selectedSourceImages: [{ sha256: hash(Buffer.from("view-1")) }, { sha256: hash(Buffer.from("view-2")) }, { sha256: hash(Buffer.from("view-3")) }],
    candidateGeometryValidated: false,
    independentReferenceVerified: false,
    heldOutCheckpointAccuracyVerified: false,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  };
  await writeFile(path.join(root, "workspace/.building-engine/authorizations/building-01/job-01.json"),
    JSON.stringify(authorization, null, 2) + "\n");
  return { root, glb, candidateHash };
}

function run(root, output = "artifacts/brf25/run-01") {
  return spawnSync(process.execPath, [
    runnerSource,
    "workspace/.building-engine/authorizations/building-01/job-01.json",
    "configs/evaluation.json",
    output,
    "--workspace=workspace",
    "--root=" + root,
  ], { cwd: root, encoding: "utf8", timeout: 120000 });
}

test("runs actual-GLB extraction then independent truth evaluation, and stays review-only (synthetic fixture)", async (t) => {
  const { root, candidateHash } = await setup(t);
  const result = run(root);
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/brf25/run-01/brf25-geometry-validation.json"), "utf8"));
  assert.equal(report.status, "geometry-evaluated-review-required");
  assert.equal(report.binding.candidateGlbSha256, candidateHash);
  assert.equal(report.artifacts.preparedManifest.candidateGlbSha256, candidateHash);
  assert.equal(report.evaluation.status, "benchmark-review-required");
  assert.equal(report.visualReview.status, "pending-human-review");
  assert.equal(report.policy.acceptanceEligible, false);
  assert.equal(report.policy.publicationEligible, false);
  assert.equal(report.policy.mapReady, false);
  assert.equal(report.policy.automaticApproval, false);
  assert.equal(report.artifacts.preparedManifest.extractedHeldOutCheckpointCount, 3);
  const metrics = JSON.parse(await readFile(path.join(root, "artifacts/brf25/run-01/evaluation-report.json"), "utf8"));
  assert.equal(metrics.candidate.glbSha256, candidateHash);
  assert.equal(metrics.metrics.checkPoints.matchedPointCount, 3);
  const prepared = JSON.parse(await readFile(path.join(root, "artifacts/brf25/run-01/prepared-manifest.json"), "utf8"));
  assert.match(prepared.reference.sourceDescription, /Synthetic fixture/);
});

test("blocks stale truth-config candidate hashes before extraction (synthetic fixture)", async (t) => {
  const { root } = await setup(t, { staleConfigHash: true });
  const result = run(root, "artifacts/brf25/stale-run");
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/brf25/stale-run/brf25-geometry-validation.json"), "utf8"));
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some((item) => item.id === "config-candidate-sha256"));
  await assert.rejects(readFile(path.join(root, "artifacts/brf25/stale-run/prepared-manifest.json")));
});
