import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(new URL("../scripts/build-brf26-evidence-bundle.mjs", import.meta.url));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const flags = { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false };

async function setup(t, { mode = "synthetic-test", pendingVisual = false, staleCandidatePin = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf26-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "workspace/output"), { recursive: true });
  await mkdir(path.join(root, "evidence"), { recursive: true });
  await mkdir(path.join(root, "artifacts/brf25/run-01"), { recursive: true });
  await mkdir(path.join(root, "artifacts/visual"), { recursive: true });

  const candidateBytes = Buffer.from("synthetic-only-candidate-glb-bytes");
  await writeFile(path.join(root, "workspace/output/candidate.glb"), candidateBytes);
  const candidateSha = sha(candidateBytes);
  const referenceBytes = Buffer.from(JSON.stringify({ sourceId: "synthetic-survey-reference", sourceDescription: "Synthetic fixture only", evidenceBasis: "surveyed" }) + "\n");
  await writeFile(path.join(root, "evidence/reference.json"), referenceBytes);
  const referenceSha = sha(referenceBytes);

  const sourceReview = {
    schemaVersion: "1.0.0", recordType: "brf-21-human-review-decision", sampleId: "sample-01",
    overallDisposition: "continue-to-reconstruction-preflight",
    reviewer: { name: "Synthetic Test Reviewer", identifier: "synthetic-reviewer-01" },
    reviewedAtUtc: "2026-10-28T00:00:00Z",
    sameBuildingIdentity: { decision: "confirmed", rationale: "Synthetic test only." },
    coverageAssessment: { decision: "adequate", rationale: "Synthetic test only." },
    sourceUpAxis: { decision: "confirmed", axis: "Z", positiveDirection: "positive" },
    assetRights: { decision: "approved-for-this-use", termsSourceUrl: "https://example.invalid/terms" },
    ...flags,
  };
  const sourceReviewBytes = Buffer.from(JSON.stringify(sourceReview, null, 2) + "\n");
  await writeFile(path.join(root, "evidence/source-review.json"), sourceReviewBytes);
  const reviewSha = sha(sourceReviewBytes);

  const authorization = {
    schemaVersion: "1.0.0", recordType: "brf-24-colmap-execution-authorization",
    status: "candidate-generated-requires-review", candidateGlbGenerated: true,
    candidateGlb: { sha256: candidateSha, relativePath: "output/candidate.glb", byteSize: candidateBytes.byteLength },
    humanDecision: { filename: "decision.json", sha256: reviewSha,
      reviewer: sourceReview.reviewer, reviewedAtUtc: sourceReview.reviewedAtUtc,
      overallDisposition: sourceReview.overallDisposition },
    toolchain: { name: "COLMAP", version: "4.2.1" },
    candidateGeometryValidated: false, independentReferenceVerified: false,
    heldOutCheckpointAccuracyVerified: false, ...flags,
  };
  const authorizationBytes = Buffer.from(JSON.stringify(authorization, null, 2) + "\n");
  await writeFile(path.join(root, "evidence/authorization.json"), authorizationBytes);

  const prepared = {
    schemaVersion: "1.0.0",
    preparation: { exactCandidateGlbSha256: candidateSha, exactReferenceSourceSha256: referenceSha, extractedHeldOutCheckPointCount: 1 },
  };
  const preparedBytes = Buffer.from(JSON.stringify(prepared, null, 2) + "\n");
  await writeFile(path.join(root, "artifacts/brf25/run-01/prepared-manifest.json"), preparedBytes);
  const evaluation = {
    schemaVersion: "1.0.0", status: "benchmark-review-required",
    candidate: { glbSha256: candidateSha },
    reference: {
      sourceId: "synthetic-survey-reference", sourceSha256: referenceSha, evidenceBasis: "surveyed",
      reviewedBy: "Synthetic curator", reviewedAt: "2026-10-28T00:00:00Z", independentlyAuthenticated: false,
    },
    metrics: { checkPoints: { matchedPointCount: 1 } },
    checks: [{ id: "check-points-excluded-from-fit", status: "passed" }],
    counts: { failures: 0, warnings: 0 }, failures: [], policy: { ...flags },
  };
  const evaluationBytes = Buffer.from(JSON.stringify(evaluation, null, 2) + "\n");
  await writeFile(path.join(root, "artifacts/brf25/run-01/evaluation-report.json"), evaluationBytes);

  const geometry = {
    schemaVersion: "1.0.0", recordType: "brf-25-geometry-validation",
    status: "geometry-evaluated-review-required",
    binding: { candidateGlbSha256: candidateSha },
    artifacts: {
      preparedManifest: { path: "artifacts/brf25/run-01/prepared-manifest.json", sha256: sha(preparedBytes), candidateGlbSha256: candidateSha },
      evaluationReport: { path: "artifacts/brf25/run-01/evaluation-report.json", sha256: sha(evaluationBytes) },
    },
    policy: { ...flags },
  };
  await writeFile(path.join(root, "artifacts/brf25/geometry-validation.json"), JSON.stringify(geometry, null, 2) + "\n");

  const sourceCamera = { schemaVersion: "1.0.0", recordType: "synthetic-source-camera-evidence", candidateGlbSha256: candidateSha };
  const sourceCameraBytes = Buffer.from(JSON.stringify(sourceCamera, null, 2) + "\n");
  await writeFile(path.join(root, "artifacts/visual/source-camera-report.json"), sourceCameraBytes);
  const renderManifest = { schemaVersion: "1.0.0", recordType: "synthetic-render-manifest", candidateGlbSha256: candidateSha };
  const renderBytes = Buffer.from(JSON.stringify(renderManifest, null, 2) + "\n");
  await writeFile(path.join(root, "artifacts/visual/render-manifest.json"), renderBytes);

  const visualDecision = {
    schemaVersion: "1.0.0", recordType: "brf-26-visual-review-decision",
    status: pendingVisual ? "pending-human-review" : "human-review-complete",
    buildingId: "building-01", candidateGlbSha256: candidateSha,
    sourceCameraReportSha256: sha(sourceCameraBytes), renderManifestSha256: sha(renderBytes),
    reviewer: pendingVisual ? { name: "", identifier: "" } : { name: "Synthetic Visual Reviewer", identifier: "synthetic-visual-01" },
    reviewedAtUtc: pendingVisual ? null : "2026-10-28T00:00:00Z",
    overallDisposition: pendingVisual ? "pending" : "pass",
    views: [{ viewId: "view-01", disposition: pendingVisual ? "pending" : "pass",
      rationale: pendingVisual ? "" : "Synthetic fixture only; not a real visual review." }],
    ...flags,
  };
  await writeFile(path.join(root, "artifacts/visual/visual-review-decision.json"), JSON.stringify(visualDecision, null, 2) + "\n");

  const entries = {
    sourceReviewDecision: ["evidence/source-review.json", sha(sourceReviewBytes)],
    authorizationRecord: ["evidence/authorization.json", sha(authorizationBytes)],
    candidateGlb: ["workspace/output/candidate.glb", staleCandidatePin ? sha(Buffer.from("stale")) : candidateSha],
    geometryValidationReport: ["artifacts/brf25/geometry-validation.json", null],
    preparedManifest: ["artifacts/brf25/run-01/prepared-manifest.json", sha(preparedBytes)],
    evaluationReport: ["artifacts/brf25/run-01/evaluation-report.json", sha(evaluationBytes)],
    independentReference: ["evidence/reference.json", referenceSha],
    sourceCameraReport: ["artifacts/visual/source-camera-report.json", sha(sourceCameraBytes)],
    renderManifest: ["artifacts/visual/render-manifest.json", sha(renderBytes)],
    visualReviewDecision: ["artifacts/visual/visual-review-decision.json", null],
  };
  for (const [key, [relative]] of Object.entries(entries)) {
    if (key === "geometryValidationReport" || key === "visualReviewDecision") {
      const bytes = await readFile(path.join(root, relative));
      entries[key][1] = sha(bytes);
    }
  }
  const manifest = {
    schemaVersion: "1.0.0", recordType: "brf-26-evidence-bundle-manifest",
    bundleId: "bundle-01", buildingId: "building-01", sampleId: "sample-01",
    evidenceMode: mode, workspaceRoot: "workspace",
    artifacts: Object.fromEntries(Object.entries(entries).map(([key, [relative, expected]]) =>
      [key, { path: relative, sha256: expected }])),
  };
  await writeFile(path.join(root, "artifacts/bundle-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { root };
}
function run(root, output = "artifacts/bundle-report.json") {
  return spawnSync(process.execPath, [runner,
    "artifacts/bundle-manifest.json", output, "--root=" + root, "--workspace=workspace"],
  { cwd: root, encoding: "utf8", timeout: 20_000 });
}

test("BRF-26 CLI help is available", () => {
  const result = spawnSync(process.execPath, [runner, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/build-brf26-evidence-bundle\.mjs/);
});

test("a fully cross-linked synthetic chain remains BLOCKED and never grants approval", async (t) => {
  const { root } = await setup(t, { mode: "synthetic-test" });
  const result = run(root);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/bundle-report.json"), "utf8"));
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout + "\n" +
    JSON.stringify({ failed: report.checks.filter((item) => item.status === "failed"), blockers: report.blockers }, null, 2));
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.evidenceMode, "synthetic-test");
  assert.ok(report.checks.some((item) => item.id === "real-evidence-mode" && item.status === "blocked"));
  assert.equal(report.policy.acceptanceEligible, false);
  assert.equal(report.policy.publicationEligible, false);
  assert.equal(report.policy.mapReady, false);
  assert.equal(report.policy.automaticApproval, false);
  assert.equal(report.artifacts.candidateGlb.integrity, "verified");
});

test("pending visual review blocks a real-evidence manifest even when file hashes agree", async (t) => {
  const { root } = await setup(t, { mode: "real-evidence", pendingVisual: true });
  const result = run(root);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/bundle-report.json"), "utf8"));
  assert.equal(result.status, 2, result.stderr + "\n" + result.stdout + "\n" +
    JSON.stringify({ failed: report.checks.filter((item) => item.status === "failed"), blockers: report.blockers }, null, 2));
  assert.equal(report.status, "BLOCKED");
  assert.ok(report.blockers.some((item) => item.id === "visual-review-disposition"));
  assert.ok(report.blockers.some((item) => item.id === "visual-review-reviewer"));
});

test("stale manifest SHA-256 is a validation failure and report remains review-only", async (t) => {
  const { root } = await setup(t, { mode: "synthetic-test", staleCandidatePin: true });
  const result = run(root);
  assert.equal(result.status, 1, result.stderr + "\n" + result.stdout);
  const report = JSON.parse(await readFile(path.join(root, "artifacts/bundle-report.json"), "utf8"));
  assert.equal(report.status, "VALIDATION_FAILED");
  assert.ok(report.failures.some((item) => item.id === "artifact-hash-pinned-candidateGlb"));
  assert.equal(report.policy.acceptanceEligible, false);
});
