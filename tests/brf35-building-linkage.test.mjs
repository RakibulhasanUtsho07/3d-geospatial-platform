import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateBrf35BuildingLinkage } from "../src/core/building-generation/brf35-building-linkage.mjs";

const manifestTemplate = JSON.parse(readFileSync("benchmarks/building-reconstruction/brf-35-candidate-linkage.json", "utf8"));
const sourceReport = JSON.parse(readFileSync("benchmarks/building-reconstruction/brf-33-citygml-candidate-geometry.json", "utf8"));
const FLAGS = { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false };
const sha = (digit) => digit.repeat(64);
const reviewedAt = "2026-10-28T00:00:00Z";
const rights = (value) => ({
  status: "approved", assetSha256: value, evidenceUrl: "https://example.test/rights",
  attributionText: "Synthetic fixture only; not a real rights approval.",
  reviewedBy: "synthetic-reviewer", reviewedAt,
  scopeDescription: "Synthetic-only rights record used for validator tests."
});
const makeAsset = (assetId, hashValue, extras = {}) => ({
  assetId, sha256: hashValue, bytes: 1024,
  sourceUri: "https://example.test/source/" + assetId, rights: rights(hashValue), ...extras
});
function completeSyntheticManifest() {
  const source = sourceReport.source, bytes = sourceReport.byteVerification, geom = sourceReport.geometry;
  const model = {
    assetId: "citygml-source", sourceProject: source.project, sourceCommit: source.commit,
    sourcePath: source.path, repositoryBlobId: source.repositoryBlobId,
    sha256: bytes.actualSha256, bytes: bytes.actualBytes, buildingGmlId: geom.buildingGmlIds[0],
    sourceCrs: "EPSG:25832", verticalCrs: "EPSG:7837", rights: rights(bytes.actualSha256),
    coordinateFrameReview: {
      status: "reviewed", reviewedBy: "synthetic-reviewer", reviewedAt, evidenceSha256: sha("6"),
      horizontalAxisOrder: ["E", "N"], verticalAxis: "H", horizontalUnit: "m", verticalUnit: "m"
    }
  };
  const image = makeAsset("image-front-01", sha("1"), { view: "front", width: 1600, height: 1200 });
  const uls = makeAsset("uls-crop-01", sha("2"), {
    pointCount: 2000, horizontalCrs: "EPSG:32632", verticalCrs: "EPSG:7837",
    evaluationFrameId: "synthetic-evaluation-frame"
  });
  const survey = makeAsset("survey-controls-01", sha("3"), { surveyProvider: "synthetic-test" });
  const candidate = {
    status: "generated", assetId: "platform-candidate-glb", role: "platform-reconstruction-candidate",
    path: "private-review/platform-candidate.glb", sha256: sha("4"),
    pipeline: "platform-reconstruction-pipeline", generationProvenanceSha256: sha("5")
  };
  const horizontal = {
    status: "approved", operationId: "synthetic-horizontal-operation", name: "Synthetic test operation",
    definition: "synthetic-only-not-for-real-coordinates", accuracyM: 1, areaOfUse: "synthetic test area",
    software: { name: "PROJ", version: "test-version" }, reviewedBy: "synthetic-reviewer", reviewedAt,
    evidenceSha256: sha("7")
  };
  const vertical = {
    ...horizontal, operationId: "synthetic-vertical-operation", sourceCrs: "EPSG:7837",
    targetCrs: "EPSG:7837", sameDatumEvidenceSha256: sha("8")
  };
  const checkpoints = [0, 1, 2].map((i) => ({
    id: "checkpoint-" + i, sourceAssetId: survey.assetId, sourceSha256: survey.sha256,
    coordinateFrameId: "synthetic-evaluation-frame", xyz: [100 + i, 200 + i, 10 + i],
    uncertaintyM: 0.02, independentOfFit: true
  }));
  return {
    schemaVersion: "1.0.0", evaluationId: "brf35-synthetic-complete-fixture",
    candidateStatus: "unverified", sourceModel: model,
    assets: { imageFrames: [image], ulsCrop: uls, surveyControls: [survey] },
    identity: {
      status: "reviewed", samePhysicalBuildingConfirmed: true,
      reviewer: "synthetic-reviewer", reviewedAt,
      method: "synthetic three-way correspondence review", decisionEvidenceSha256: sha("9"),
      evidenceRefs: [
        { assetId: model.assetId, sha256: model.sha256, role: "citygml" },
        { assetId: image.assetId, sha256: image.sha256, role: "image" },
        { assetId: uls.assetId, sha256: uls.sha256, role: "uls" }
      ]
    },
    coordinateOperation: {
      status: "approved", sourceHorizontalCrs: "EPSG:25832", targetHorizontalCrs: "EPSG:32632",
      evaluationFrameId: "synthetic-evaluation-frame", horizontal, vertical
    },
    candidateGlb: candidate,
    accuracy: {
      status: "reviewed", candidateGlbSha256: candidate.sha256, referenceSourceSha256: model.sha256,
      evaluationReportSha256: sha("a"), thresholdPolicyId: "synthetic-policy-v1",
      reviewer: "synthetic-reviewer", reviewedAt, heldOutCheckpoints: checkpoints
    },
    visualReview: {
      status: "approved", reviewer: "synthetic-reviewer", reviewedAt, renderManifestSha256: sha("b")
    },
    releaseFlags: { ...FLAGS }
  };
}

test("real candidate template remains blocked and every release flag is false", () => {
  const report = validateBrf35BuildingLinkage(manifestTemplate, sourceReport);
  assert.equal(report.status, "blocked-missing-or-invalid-evidence");
  assert.ok(report.blockingCount > 0);
  for (const id of ["citygml-source-rights", "image-frames-present", "same-building-linkage-reviewed",
    "horizontal-operation-approved", "vertical-frame-operation-approved", "platform-candidate-glb-present",
    "held-out-checkpoints-independent"]) assert.ok(report.blockers.includes(id), id);
  assert.deepEqual(report.releaseFlags, FLAGS);
  assert.equal(report.candidateSelected, false);
  assert.equal(report.accuracyPassed, false);
});

test("complete synthetic cross-modal evidence still requires human release review", () => {
  const report = validateBrf35BuildingLinkage(completeSyntheticManifest(), sourceReport);
  assert.equal(report.blockingCount, 0, JSON.stringify(report.blockers));
  assert.equal(report.status, "evidence-complete-human-release-review-required");
  assert.deepEqual(report.releaseFlags, FLAGS);
  assert.equal(report.candidateSelected, false);
  assert.equal(report.accuracyPassed, false);
});

test("source asset IDs must be globally unique across CityGML, image, ULS and survey roles", () => {
  const manifest = completeSyntheticManifest();
  manifest.assets.ulsCrop.assetId = manifest.assets.imageFrames[0].assetId;
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  assert.ok(report.blockers.includes("source-asset-ids-globally-unique"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("candidate GLB identity and bytes must be distinct from every source role", () => {
  const duplicateIds = completeSyntheticManifest();
  duplicateIds.candidateGlb.assetId = duplicateIds.assets.imageFrames[0].assetId;
  const idReport = validateBrf35BuildingLinkage(duplicateIds, sourceReport);
  assert.ok(idReport.blockers.includes("candidate-glb-distinct-from-all-source-assets"));
  assert.deepEqual(idReport.releaseFlags, FLAGS);

  for (const sourceAsset of [
    completeSyntheticManifest().assets.imageFrames[0],
    completeSyntheticManifest().assets.ulsCrop,
    completeSyntheticManifest().assets.surveyControls[0],
  ]) {
    const manifest = completeSyntheticManifest();
    manifest.candidateGlb.sha256 = sourceAsset.sha256;
    manifest.accuracy.candidateGlbSha256 = sourceAsset.sha256;
    const report = validateBrf35BuildingLinkage(manifest, sourceReport);
    assert.ok(report.blockers.includes("candidate-glb-distinct-from-all-source-assets"));
    assert.deepEqual(report.releaseFlags, FLAGS);
  }
});

test("wrong in-file Building GML ID is rejected", () => {
  const manifest = completeSyntheticManifest();
  manifest.sourceModel.buildingGmlId = "DEBY_LOD3_4959323";
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  assert.ok(report.blockers.includes("source-model-pins-match-brf33"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("stale image-rights hash is rejected", () => {
  const manifest = completeSyntheticManifest();
  manifest.assets.imageFrames[0].rights.assetSha256 = sha("f");
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  assert.ok(report.blockers.includes("image-frame-image-front-01-rights"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("unreviewed identity cannot be replaced with a caller claim", () => {
  const manifest = completeSyntheticManifest();
  manifest.identity.status = "unverified";
  manifest.identity.samePhysicalBuildingConfirmed = false;
  manifest.identity.evidenceRefs = [];
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  assert.ok(report.blockers.includes("same-building-linkage-reviewed"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("unknown vertical frame or missing vertical transform blocks evaluation", () => {
  const manifest = completeSyntheticManifest();
  manifest.sourceModel.verticalCrs = null;
  manifest.coordinateOperation.vertical.status = "pending";
  manifest.coordinateOperation.vertical.sourceCrs = null;
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  assert.ok(report.blockers.includes("vertical-frame-operation-approved"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("control points reused for fitting are rejected", () => {
  const manifest = completeSyntheticManifest();
  manifest.accuracy.heldOutCheckpoints[1].independentOfFit = false;
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  assert.ok(report.blockers.includes("held-out-checkpoints-independent"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("source-reference GLB cannot satisfy the platform-candidate requirement", () => {
  const manifest = completeSyntheticManifest();
  manifest.candidateGlb.role = "source-reference-geometry-not-platform-reconstruction";
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  assert.ok(report.blockers.includes("platform-candidate-glb-present"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});

test("input cannot enable release flags", () => {
  const manifest = completeSyntheticManifest();
  manifest.releaseFlags.mapReady = true;
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  assert.ok(report.blockers.includes("release-flags-remain-disabled"));
  assert.deepEqual(report.releaseFlags, FLAGS);
});
