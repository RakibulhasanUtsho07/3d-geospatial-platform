import assert from "node:assert/strict";
import test from "node:test";
import { assessBuildingBenchmarkReadiness } from "../src/core/building-generation/building-benchmark-readiness.mjs";

const HASH = (char) => char.repeat(64);
const FRAME = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

function asset(id, role, filename) {
  return {
    id, role, buildingId: "sample-building-01",
    sourceUrl: "https://data.example.org/sample/" + filename,
    filename, byteSize: 4096, sha256: HASH("a"),
    license: {
      reviewStatus: "approved",
      name: "CC BY 4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
      attribution: "Sample Dataset authors",
      reviewedBy: "independent-reviewer",
      reviewedAt: "2026-10-27T10:00:00.000Z",
    },
  };
}

function validManifest() {
  return {
    schemaVersion: "1.0.0",
    evaluationId: "brf10-sample-eval-01",
    building: {
      id: "sample-building-01",
      name: "Sample Building",
      identityEvidence: "Stable building ID matched across an orthophoto and a separately captured survey point cloud.",
    },
    evaluation: { coordinateFrameId: "sample-site-enu-v1", units: "m" },
    assets: [
      asset("image-front", "candidate-image", "front.jpg"),
      asset("image-oblique", "candidate-image", "oblique.jpg"),
      asset("reference-model", "reference-model", "reference.gml"),
      asset("independent-surface", "independent-surface", "survey.laz"),
      asset("control-survey", "independent-control", "control-points.csv"),
    ],
    candidate: {
      buildingId: "sample-building-01",
      generator: "engine-multiview-reconstruction",
      generatedByPlatform: true,
      groundTruthModelImported: false,
      glbPath: "artifacts/brf10/candidate.glb",
      glbSha256: HASH("b"),
      sourceAssetIds: ["image-front", "image-oblique"],
      modelCoordinateFrameId: "candidate-local-y-up-v1",
      evaluationCoordinateFrameId: "sample-site-enu-v1",
      modelToEvaluationFrameMatrix4x4: FRAME,
    },
    reference: {
      buildingId: "sample-building-01",
      sourceAssetIds: ["reference-model", "independent-surface"],
      sourceCoordinateFrameId: "sample-survey-enu-v1",
      coordinateFrameId: "sample-site-enu-v1",
      units: "m",
      crs: "EPSG:32632",
      verticalDatum: "documented-local-survey-datum",
      frameRegistrationEvidence: "Survey report v1.0, independently reviewed control registration.",
      sourceToEvaluationFrameMatrix4x4: FRAME,
    },
    controls: {
      fitControls: [0,1,2].map((i) => ({
        id: "fit-" + i,
        sourceAssetId: "control-survey",
        x: i, y: 0, z: i * 2,
        uncertaintyM: 0.02,
        coordinateFrameId: "sample-site-enu-v1",
      })),
      heldOutCheckpoints: [0,1,2,3,4,5].map((i) => ({
        id: "holdout-" + i,
        sourceAssetId: "control-survey",
        x: i + 10, y: 3, z: i * 1.5,
        uncertaintyM: 0.03,
        coordinateFrameId: "sample-site-enu-v1",
        independentOfFit: true,
        candidateVertexBinding: { nodeIndex: 1, primitiveIndex: 0, vertexIndex: i },
      })),
    },
  };
}

test("marks a complete, separated, rights-reviewed manifest complete for further byte-level review only", () => {
  const report = assessBuildingBenchmarkReadiness(validManifest());
  assert.equal(report.status, "manifest-complete");
  assert.equal(report.blockers.length, 0);
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.mapReady, false);
  assert.equal(report.automaticApproval, false);
});

test("blocks a missing source and unreviewed licence rather than assuming permission", () => {
  const manifest = validManifest();
  manifest.assets[0].license.reviewStatus = "pending";
  delete manifest.assets[1].sha256;
  const report = assessBuildingBenchmarkReadiness(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-image-front-license-review"));
  assert.ok(report.blockers.includes("asset-image-oblique-source"));
});

test("blocks candidate/reference reuse and imported benchmark ground truth", () => {
  const manifest = validManifest();
  manifest.candidate.sourceAssetIds = ["reference-model"];
  manifest.candidate.groundTruthModelImported = true;
  const report = assessBuildingBenchmarkReadiness(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("candidate-image-inputs"));
  assert.ok(report.blockers.includes("candidate-engine-generated"));
  assert.ok(report.blockers.includes("candidate-reference-separation"));
});

test("blocks absent or non-metric frame registration", () => {
  const manifest = validManifest();
  manifest.reference.crs = "";
  manifest.reference.sourceToEvaluationFrameMatrix4x4[0] = 2;
  const report = assessBuildingBenchmarkReadiness(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("reference-frame-registration"));
});

test("blocks holdout leakage, unbound points, and fewer than six independent checkpoints", () => {
  const manifest = validManifest();
  manifest.controls.heldOutCheckpoints = manifest.controls.heldOutCheckpoints.slice(0, 5);
  manifest.controls.heldOutCheckpoints[0].id = "fit-0";
  manifest.controls.heldOutCheckpoints[1].candidateVertexBinding = undefined;
  const report = assessBuildingBenchmarkReadiness(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("held-out-checkpoints"));
});

test("blocks assets that cannot be linked to the same evaluated building", () => {
  const manifest = validManifest();
  manifest.assets[3].buildingId = "another-building";
  const report = assessBuildingBenchmarkReadiness(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("asset-independent-surface-identity"));
});

test("returns a fail-closed invalid result for a non-object manifest", () => {
  const report = assessBuildingBenchmarkReadiness(null);
  assert.equal(report.status, "invalid");
  assert.deepEqual(report.blockers, ["manifest-object"]);
  assert.equal(report.mapReady, false);
});
