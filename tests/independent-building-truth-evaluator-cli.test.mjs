import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractGlbGeometry } from "../src/core/building-generation/glb-geometry-extraction.mjs";
import { adaptIndependentReferenceGeometry } from "../src/core/building-generation/independent-reference-geometry-adapter.mjs";
import { geometryPayloadSha256 } from "../src/core/building-generation/geometry-extraction-provenance.mjs";
import { createD3m01dSignedReviewFixture } from "./fixtures/d3m01d-signed-review-fixture.mjs";
import {
  createBuildingGlb,
  MODEL_TO_EVALUATION,
  surveyGeometryDocument,
} from "./fixtures/glb-geometry-fixture.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reviewedAt = "2026-10-26T10:00:00Z";
const frameId = "site-local-enu-01";
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const candidateBindings = [
  { id: "survey-check-01", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 0 },
  { id: "survey-check-02", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 1 },
  { id: "survey-check-03", nodeIndex: 1, primitiveIndex: 0, vertexIndex: 6 },
];
const candidateBytes = createBuildingGlb();
const candidateSha = hash(candidateBytes);
const candidateExtracted = extractGlbGeometry(candidateBytes, {
  coordinateFrameId: frameId,
  units: "m",
  modelToEvaluationFrameMatrix4x4: MODEL_TO_EVALUATION,
  checkPointBindings: candidateBindings,
});
const referenceDocument = surveyGeometryDocument({ coordinateFrameId: frameId, localCoordinates: false });
const referenceBytes = Buffer.from(JSON.stringify(referenceDocument, null, 2) + "\n");
const referenceSha = hash(referenceBytes);
const adaptedReference = adaptIndependentReferenceGeometry(referenceDocument, {
  sourceCoordinateFrameId: frameId,
  evaluationCoordinateFrameId: frameId,
  sourceToEvaluationFrameMatrix4x4: identity,
});
const extractorBytes = Buffer.from("reproducible geometry extractor source fixture");
const adapterBytes = Buffer.from("reproducible reference adapter source fixture");
const extractorConfigBytes = Buffer.from(JSON.stringify({
  schemaVersion: "1.0.0",
  evaluationId: "cli-site-eval-01",
  buildingId: "cli-site-building",
  generatedAt: "2026-10-27T08:00:00Z",
  extractorCommitSha: "1234567890abcdef1234567890abcdef12345678",
  candidate: {
    glbPath: "evidence/candidate.glb",
    expectedGlbSha256: candidateSha,
    coordinateFrameId: frameId,
    units: "m",
    modelCoordinateFrameId: "candidate-local-frame-v1",
    modelToEvaluationFrameMatrix4x4: MODEL_TO_EVALUATION,
    checkPointBindings: candidateBindings,
  },
  reference: {
    sourcePath: "evidence/survey.json",
    expectedSourceSha256: referenceSha,
    sourceCoordinateFrameId: frameId,
    sourceToEvaluationFrameMatrix4x4: identity,
  },
  tolerances: {
    footprintAreaRelativeErrorPercent: 5,
    footprintBoundaryP95M: 0.1,
    footprintBoundaryMaxM: 0.2,
    dimensionRelativeErrorPercent: 5,
    checkPointRmseM: 0.1,
    checkPointMaxM: 0.2,
    surfaceDistanceP95M: 0.1,
    surfaceDistanceMaxM: 0.2,
  },
}, null, 2) + "\n");

function candidatePayload() {
  return {
    glbPath: "evidence/candidate.glb",
    glbSha256: candidateSha,
    geometrySourceGlbSha256: candidateSha,
    coordinateFrameId: frameId,
    units: "m",
    footprint: candidateExtracted.footprint.map((point) => ({ ...point })),
    dimensionsM: { ...candidateExtracted.dimensionsM },
    checkPoints: candidateExtracted.checkPoints.map((point) => ({ ...point })),
    surfaceMesh: {
      sourceGlbSha256: candidateSha,
      vertices: candidateExtracted.surfaceMesh.vertices.map((vertex) => [...vertex]),
      triangles: candidateExtracted.surfaceMesh.triangles.map((triangle) => [...triangle]),
    },
    geometryExtractionSummary: candidateExtracted.extractionSummary,
    modelCoordinateFrameId: "candidate-local-frame-v1",
    modelToEvaluationFrameMatrix4x4: MODEL_TO_EVALUATION,
    checkPointBindings: candidateBindings,
  };
}

function referencePayload() {
  return {
    sourcePath: "evidence/survey.json",
    sourceId: referenceDocument.sourceId,
    sourceSha256: referenceSha,
    geometrySourceSha256: referenceSha,
    evidenceBasis: referenceDocument.evidenceBasis,
    sourceDescription: referenceDocument.sourceDescription,
    reviewedBy: referenceDocument.reviewedBy,
    reviewedAt: referenceDocument.reviewedAt,
    coordinateFrameId: adaptedReference.coordinateFrameId,
    units: "m",
    footprint: adaptedReference.footprint.map((point) => ({ ...point })),
    dimensionsM: { ...adaptedReference.dimensionsM },
    checkPoints: adaptedReference.checkPoints.map((point) => ({ ...point })),
    surfaceMesh: {
      sha256: referenceSha,
      vertices: adaptedReference.surfaceMesh.vertices.map((vertex) => [...vertex]),
      triangles: adaptedReference.surfaceMesh.triangles.map((triangle) => [...triangle]),
    },
    inputHashPinned: true,
    geometryExtractionSummary: {
      method: "reviewed-independent-reference-json-import-v1",
      exactSourceSha256: referenceSha,
      sourceCoordinateFrameId: referenceDocument.coordinateFrameId,
      coordinateFrameId: frameId,
      units: "m",
      frameTransform: adaptedReference.frameTransform,
    },
  };
}

function makeManifest() {
  const candidate = candidatePayload();
  const reference = referencePayload();
  for (const [role, geometry, sourceHash] of [
    ["candidate", candidate, candidateSha],
    ["reference", reference, referenceSha],
  ]) {
    geometry.geometryExtractionProvenance = {
      schemaVersion: "1.0.0",
      extractionRunId: role + "-extract-run-01",
      method: role === "candidate"
        ? "glb-2.0-position-index-and-node-transform-v1"
        : "reviewed-independent-reference-json-import-v1",
      extractedAt: reviewedAt,
      inputArtifactSha256: sourceHash,
      outputGeometrySha256: geometryPayloadSha256(geometry),
      coordinateFrameId: geometry.coordinateFrameId,
      units: geometry.units,
      extractor: {
        id: role === "candidate" ? "fixture-geometry-extractor" : "fixture-reference-adapter",
        version: "1.0.0",
        commitSha: "1234567890abcdef1234567890abcdef12345678",
        artifactPath: role === "candidate"
          ? "tools/geometry-extractor.mjs"
          : "tools/reference-adapter.mjs",
        artifactSha256: hash(role === "candidate" ? extractorBytes : adapterBytes),
        configurationPath: "configs/geometry-extractor.json",
        configurationSha256: hash(extractorConfigBytes),
      },
    };
  }
  return {
    schemaVersion: "1.0.0",
    evaluationId: "cli-site-eval-01",
    buildingId: "cli-site-building",
    generatedAt: "2026-10-27T08:00:00Z",
    candidate,
    reference,
    preparation: {
      method: "brf-09-actual-glb-and-independent-reference-adapter-v1",
      configPath: "configs/geometry-extractor.json",
      configSha256: hash(extractorConfigBytes),
      candidateModelToEvaluationTransform: MODEL_TO_EVALUATION,
      referenceSourceCoordinateFrameId: frameId,
      referenceSourceToEvaluationFrameMatrix4x4: identity,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
    tolerances: {
      footprintAreaRelativeErrorPercent: 5,
      footprintBoundaryP95M: 0.1,
      footprintBoundaryMaxM: 0.2,
      dimensionRelativeErrorPercent: 5,
      checkPointRmseM: 0.1,
      checkPointMaxM: 0.2,
      surfaceDistanceP95M: 0.1,
      surfaceDistanceMaxM: 0.2,
    },
  };
}

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "independent-building-truth-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "evidence"));
  await mkdir(path.join(root, "tools"));
  await mkdir(path.join(root, "configs"));
  await writeFile(path.join(root, "evidence/candidate.glb"), candidateBytes);
  await writeFile(path.join(root, "evidence/survey.json"), referenceBytes);
  await writeFile(path.join(root, "tools/geometry-extractor.mjs"), extractorBytes);
  await writeFile(path.join(root, "tools/reference-adapter.mjs"), adapterBytes);
  await writeFile(path.join(root, "configs/geometry-extractor.json"), extractorConfigBytes);
  await writeFile(path.join(root, "evaluation.json"), JSON.stringify(makeManifest(), null, 2));
  const review = await createD3m01dSignedReviewFixture({
    workspaceRoot: root,
    buildingId: "cli-site-building",
    candidatePath: "evidence/candidate.glb",
  });
  await writeFile(path.join(root, "review-fixture.json"), JSON.stringify(review, null, 2));
  return { root, review };
}
function run(root, output, options = {}) {
  const stored = JSON.parse(readFileSync(path.join(root, "review-fixture.json"), "utf8"));
  const review = options.review ?? stored;
  const args = [
    fileURLToPath(new URL("../scripts/evaluate-independent-building-truth.mjs", import.meta.url)),
    "evaluation.json", output, "--root=" + root,
  ];
  if (!options.omitReceipt) {
    args.push(
      "--workspace=" + root,
      "--building-id=" + (options.buildingId ?? review.buildingId),
      "--review-job-id=" + (options.reviewJobId ?? review.reviewJobId),
    );
  }
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON: options.registryJson ?? review.registryJson ?? "",
    },
  });
}

test("replays exact candidate GLB and independent source bytes before producing a review-required report", async (t) => {
  const { root } = await setup(t);
  const execution = run(root, "report.json");
  assert.equal(execution.status, 0, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
  assert.equal(report.status, "benchmark-review-required");
  assert.equal(report.authenticatedReview.status, "cryptographically-reverified");
  assert.equal(report.authenticatedReview.decision, "continue-to-independent-validation");
  assert.equal(report.authenticatedReview.candidateGlbSha256, candidateSha);
  assert.ok(report.checks.some((check) => check.id === "authenticated-review-receipt" && check.status === "passed"));
  assert.equal(report.metricComputation.status, "computed-after-source-replay");
  assert.ok(report.metrics, "metrics are only present after source bytes and both replays pass");
  assert.equal(report.assetIntegrity.filter((item) => item.status !== "passed").length, 0);
  assert.equal(report.geometryExtractionProvenance.candidate.status, "passed");
  assert.equal(report.geometryExtractionProvenance.reference.status, "passed");
  assert.equal(report.geometryReplay.candidate.status, "passed");
  assert.equal(report.geometryReplay.reference.status, "passed");
  assert.ok(report.checks.some((check) => check.id === "candidate-geometry-replay-from-source-bytes" && check.status === "passed"));
  assert.ok(report.checks.some((check) => check.id === "reference-geometry-replay-from-source-bytes" && check.status === "passed"));
  assert.ok(report.checks.some((check) => check.id === "candidate-extractor-artifact-byte-integrity" && check.status === "passed"));
  assert.ok(report.checks.some((check) => check.id === "reference-extractor-configuration-byte-integrity" && check.status === "passed"));
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

test("rejects a symlinked report directory instead of writing outside the project root", async (t) => {
  const { root } = await setup(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "independent-building-truth-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await symlink(external, path.join(root, "escape"), "dir");
  const execution = run(root, "escape/report.json");
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /Report output must not traverse symbolic links/);
  await assert.rejects(readFile(path.join(external, "report.json")), { code: "ENOENT" });
});

test("fails when extractor source bytes no longer match the pinned provenance digest", async (t) => {
  const { root } = await setup(t);
  await writeFile(path.join(root, "tools/geometry-extractor.mjs"), "changed extractor source");
  const execution = run(root, "extractor-stale-report.json");
  assert.equal(execution.status, 1, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "extractor-stale-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.ok(report.failures.some((check) => check.id === "candidate-extractor-artifact-byte-integrity"));
});

test("replay catches a caller changing candidate geometry even after refreshing its declared geometry digest", async (t) => {
  const { root } = await setup(t);
  const manifest = makeManifest();
  manifest.candidate.footprint = manifest.candidate.footprint.map((point) => ({ ...point, x: point.x + 0.25 }));
  manifest.candidate.geometryExtractionProvenance.outputGeometrySha256 = geometryPayloadSha256(manifest.candidate);
  await writeFile(path.join(root, "evaluation.json"), JSON.stringify(manifest, null, 2));
  const execution = run(root, "geometry-replay-failed-report.json");
  assert.equal(execution.status, 1, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "geometry-replay-failed-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.equal(report.geometryExtractionProvenance.candidate.status, "passed");
  assert.equal(report.geometryReplay.candidate.status, "failed");
  assert.equal(report.metrics, null);
  assert.equal(report.metricComputation.status, "withheld");
  assert.ok(report.failures.some((check) => check.id === "geometry-metrics-withheld-until-source-replay-passes"));
  assert.ok(report.failures.some((check) => check.id === "candidate-geometry-replay-from-source-bytes"));
});

test("replay catches a changed registration transform before accepting candidate metrics", async (t) => {
  const { root } = await setup(t);
  const manifest = makeManifest();
  manifest.candidate.modelToEvaluationFrameMatrix4x4 = [
    ...MODEL_TO_EVALUATION.slice(0, 12),
    MODEL_TO_EVALUATION[12] + 0.5,
    MODEL_TO_EVALUATION[13],
    MODEL_TO_EVALUATION[14],
    MODEL_TO_EVALUATION[15],
  ];
  await writeFile(path.join(root, "evaluation.json"), JSON.stringify(manifest, null, 2));
  const execution = run(root, "matrix-replay-failed-report.json");
  assert.equal(execution.status, 1, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "matrix-replay-failed-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.equal(report.geometryReplay.candidate.status, "failed");
  assert.equal(report.metrics, null);
  assert.equal(report.metricComputation.status, "withheld");
  assert.ok(report.failures.some((check) => check.id === "geometry-metrics-withheld-until-source-replay-passes"));
  assert.ok(report.failures.some((check) => check.id === "candidate-geometry-replay-from-source-bytes"));
});

test("replay catches altered independent-reference coordinates even after refreshing its declared geometry digest", async (t) => {
  const { root } = await setup(t);
  const manifest = makeManifest();
  manifest.reference.dimensionsM.widthM += 0.5;
  manifest.reference.geometryExtractionProvenance.outputGeometrySha256 = geometryPayloadSha256(manifest.reference);
  await writeFile(path.join(root, "evaluation.json"), JSON.stringify(manifest, null, 2));
  const execution = run(root, "reference-replay-failed-report.json");
  assert.equal(execution.status, 1, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "reference-replay-failed-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.equal(report.geometryExtractionProvenance.reference.status, "passed");
  assert.equal(report.geometryReplay.reference.status, "failed");
  assert.equal(report.metrics, null);
  assert.equal(report.metricComputation.status, "withheld");
  assert.ok(report.failures.some((check) => check.id === "geometry-metrics-withheld-until-source-replay-passes"));
  assert.ok(report.failures.some((check) => check.id === "reference-geometry-replay-from-source-bytes"));
});

test("fails when extractor registration metadata is missing instead of silently trusting inline geometry", async (t) => {
  const { root } = await setup(t);
  const manifest = makeManifest();
  delete manifest.candidate.modelToEvaluationFrameMatrix4x4;
  await writeFile(path.join(root, "evaluation.json"), JSON.stringify(manifest, null, 2));
  const execution = run(root, "missing-replay-config-report.json");
  assert.equal(execution.status, 1, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "missing-replay-config-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.equal(report.geometryReplay.candidate.status, "failed");
  assert.equal(report.metrics, null);
  assert.equal(report.metricComputation.status, "withheld");
  assert.ok(report.failures.some((check) => check.id === "geometry-metrics-withheld-until-source-replay-passes"));
  assert.ok(report.failures.some((check) => check.id === "candidate-geometry-replay-from-source-bytes"));
});

test("keeps an unprovenanced geometry source incomplete rather than silently passing", async (t) => {
  const { root } = await setup(t);
  const manifest = makeManifest();
  delete manifest.reference.geometryExtractionProvenance;
  await writeFile(path.join(root, "evaluation.json"), JSON.stringify(manifest, null, 2));
  const execution = run(root, "missing-provenance-report.json");
  const report = JSON.parse(await readFile(path.join(root, "missing-provenance-report.json"), "utf8"));
  assert.equal(execution.status, 2, JSON.stringify({
    stderr: execution.stderr,
    stdout: execution.stdout,
    reportStatus: report.status,
    failures: report.failures,
    warnings: report.warnings,
    geometryReplay: report.geometryReplay,
    preparationConfig: report.assetIntegrity?.find((item) => item.kind === "preparation-config"),
  }, null, 2));
  assert.equal(report.status, "benchmark-incomplete");
  assert.ok(report.warnings.some((check) => check.id === "reference-extraction-provenance-present"));
});

test("withholds metrics when candidate GLB bytes differ from the pinned source hash", async (t) => {
  const { root } = await setup(t);
  await writeFile(path.join(root, "evidence/candidate.glb"), Buffer.from("tampered candidate GLB bytes"));
  const execution = run(root, "candidate-hash-failed-report.json");
  assert.equal(execution.status, 2, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "candidate-hash-failed-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-incomplete");
  assert.equal(report.authenticatedReview.status, "blocked");
  assert.equal(report.metrics, null);
  assert.equal(report.metricComputation.status, "withheld");
  assert.match(report.authenticatedReview.reason, /Candidate GLB bytes no longer match the immutable hand-off identity/);
  assert.ok(report.failures.some((check) =>
    check.id === "authenticated-review-required-before-metrics"));
  assert.ok(Object.values(report.policy).every((value) => value === false));
});

test("withholds metrics when preparation config bytes differ from the pinned SHA-256", async (t) => {
  const { root } = await setup(t);
  await writeFile(path.join(root, "configs/geometry-extractor.json"), Buffer.from("tampered preparation configuration"));
  const execution = run(root, "config-hash-failed-report.json");
  assert.equal(execution.status, 1, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "config-hash-failed-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.equal(report.metrics, null);
  assert.equal(report.metricComputation.status, "withheld");
  assert.ok(report.metricComputation.prerequisites.some((item) =>
    item.id === "preparation-config-byte-integrity" && item.status === "failed"));
  assert.ok(report.failures.some((check) =>
    check.id === "geometry-metrics-withheld-until-source-replay-passes"));
  assert.ok(Object.values(report.policy).every((value) => value === false));
});

test("reports an exact-byte mismatch as failed instead of trusting stale reference metrics", async (t) => {
  const { root } = await setup(t);
  await writeFile(path.join(root, "evidence/survey.json"), JSON.stringify({ schemaVersion: "1.0.0", coordinateFrameId: frameId, units: "m" }));
  const execution = run(root, "report-failed.json");
  assert.equal(execution.status, 1, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "report-failed.json"), "utf8"));
  assert.equal(report.status, "benchmark-failed");
  assert.equal(report.metrics, null);
  assert.equal(report.metricComputation.status, "withheld");
  assert.ok(report.failures.some((check) => check.id === "geometry-metrics-withheld-until-source-replay-passes"));
  assert.ok(report.failures.some((check) => check.id === "reference-source-byte-integrity"));
  assert.equal(report.policy.acceptanceEligible, false);
});


test("blocks the standalone evaluator CLI when no D3M-01.D signed receipt is supplied", async (t) => {
  const { root } = await setup(t);
  const execution = run(root, "missing-review-report.json", { omitReceipt: true });
  assert.equal(execution.status, 2, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "missing-review-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-incomplete");
  assert.equal(report.authenticatedReview.status, "blocked");
  assert.equal(report.metrics, null);
  assert.equal(report.metricComputation.status, "withheld");
  assert.ok(report.failures.some((check) => check.id === "authenticated-review-required-before-metrics"));
});

test("blocks the standalone evaluator CLI when its current trusted reviewer key is rotated", async (t) => {
  const { root } = await setup(t);
  const replacement = generateKeyPairSync("ed25519");
  const replacementPem = replacement.publicKey.export({ type: "spki", format: "pem" }).toString();
  const registryJson = JSON.stringify([{ reviewerId: "reviewer-fixture", publicKeyPem: replacementPem }]);
  const execution = run(root, "rotated-reviewer-key-report.json", { registryJson });
  assert.equal(execution.status, 2, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "rotated-reviewer-key-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-incomplete");
  assert.equal(report.authenticatedReview.status, "blocked");
  assert.equal(report.metrics, null);
  assert.match(report.authenticatedReview.reason, /signature is invalid/);
});

test("blocks the standalone evaluator CLI when manifest and signed-review building IDs differ", async (t) => {
  const { root } = await setup(t);
  const execution = run(root, "wrong-building-report.json", { buildingId: "another-building" });
  assert.equal(execution.status, 2, execution.stderr);
  const report = JSON.parse(await readFile(path.join(root, "wrong-building-report.json"), "utf8"));
  assert.equal(report.status, "benchmark-incomplete");
  assert.equal(report.authenticatedReview.status, "blocked");
  assert.equal(report.metrics, null);
  assert.match(report.authenticatedReview.reason, /manifest buildingId must match/);
});
