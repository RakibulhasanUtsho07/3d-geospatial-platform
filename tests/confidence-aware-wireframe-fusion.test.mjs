import assert from "node:assert/strict";
import test from "node:test";
import { fuseReviewedObservationsIntoWireframe } from "../src/core/building-generation/confidence-aware-wireframe-fusion.mjs";
import { projectPoint } from "../src/core/building-generation/multi-view-wireframe-registration.mjs";

const REVIEWED_AT = "2026-10-26T08:00:00.000Z";
function cameraAt(id, cx, calibrationStatus = "verified") {
  return {
    id,
    projection: [[100, 0, 0, 220 - 100 * cx], [0, 100, 0, 200], [0, 0, 1, 0]],
    imageSize: { width: 256, height: 256 },
    coordinateFrame: "building-local-metric",
    calibrationStatus,
    ...(calibrationStatus === "verified" ? {
      calibrationEvidence: { sourceId: "calibration-" + id, sha256: "f".repeat(64) },
    } : {}),
  };
}
function makeInput({ points = { cornerA: [0.3, 0.2, 5], cornerB: [0.8, 0.2, 5] },
  cameraStatus = "verified", includeFacades = true } = {}) {
  const cameras = [cameraAt("v0", 0, cameraStatus), cameraAt("v1", 0.5, cameraStatus), cameraAt("v2", 1, cameraStatus)];
  const observationsByView = cameras.map((camera, index) => {
    const observations = Object.entries(points).map(([featureId, point]) => {
      const pixel = projectPoint(camera, point);
      const id = featureId + "-obs-v" + index;
      const sourceSha256 = String(index + 1).repeat(64);
      return {
        id, category: "outer-corner", sourceId: "source-v" + index, sourceSha256,
        viewId: camera.id, geometry: { type: "Point", coordinates: [pixel.x, pixel.y] },
        confidence: 0.9, method: "human-review", status: "reviewed", visibility: "visible",
        reviewedBy: "reviewer-1", reviewedAt: REVIEWED_AT, evidence: {},
      };
    });
    return {
      schemaVersion: "1.0.0", batchId: "batch-v" + index, buildingId: "sample-building",
      viewId: camera.id, createdAt: REVIEWED_AT,
      source: { id: "source-v" + index, sha256: String(index + 1).repeat(64), width: 256, height: 256 },
      mask: null, observations,
    };
  });
  const correspondences = Object.keys(points).map((featureId) => ({
    id: featureId, status: "accepted", confidence: 0.95, reviewedBy: "reviewer-1", reviewedAt: REVIEWED_AT,
    observationRefs: observationsByView.map((batch) => ({ batchId: batch.batchId,
      observationId: batch.observations.find((item) => item.id.startsWith(featureId + "-")).id })),
  }));
  const facadeInventory = includeFacades ? ["front", "rear", "left", "right", "roof"] : [];
  return {
    buildingId: "sample-building", cameras, observationBatches: observationsByView, correspondences,
    edgeProposals: [{
      id: "front-edge-A-B", fromCorrespondenceId: "cornerA", toCorrespondenceId: "cornerB",
      status: "reviewed", confidence: 0.9, reviewedBy: "reviewer-1", reviewedAt: REVIEWED_AT,
      sourceViewIds: ["v0", "v1"],
    }],
    facadeInventory,
    facadeCoverage: includeFacades ? [{
      facadeId: "front", visibility: "observed", status: "reviewed", reviewedBy: "reviewer-1",
      reviewedAt: REVIEWED_AT, sourceViewIds: ["v0", "v1"],
    }, {
      facadeId: "rear", visibility: "not-visible", status: "reviewed", reviewedBy: "reviewer-1",
      reviewedAt: REVIEWED_AT, sourceViewIds: ["v0"],
    }, {
      facadeId: "roof", visibility: "inferred", status: "reviewed", reviewedBy: "reviewer-1",
      reviewedAt: REVIEWED_AT, sourceViewIds: ["v1"], reason: "partial upper-edge evidence only",
    }] : [],
  };
}

test("fuses accepted cross-view corners with pixel provenance and reprojection evidence", () => {
  const graph = fuseReviewedObservationsIntoWireframe(makeInput());
  assert.equal(graph.engine, "confidence-aware-wireframe-fusion-v1");
  assert.equal(graph.vertices.length, 2);
  const vertex = graph.vertices.find((item) => item.id === "cornerA");
  assert.equal(vertex.reviewState, "accepted");
  assert.ok(Math.abs(vertex.point[0] - 0.3) < 1e-6);
  assert.equal(vertex.sourceObservations.length, 3);
  assert.deepEqual(vertex.sourceObservations[0].sourcePixel.length, 2);
  assert.match(vertex.sourceObservations[0].sourceSha256, /^[a-f0-9]{64}$/i);
  assert.equal(vertex.sourceObservations[0].reprojection.classification, "inlier-candidate");
  assert.equal(vertex.reprojectionEvidence.perObservation.length, 3);
  assert.equal(vertex.confidence.semantics, "heuristic-confidence-score-not-a-calibrated-probability");
  assert.ok(vertex.confidence.score > 0);
  assert.equal(graph.publicationEligible, false);
});

test("only explicitly reviewed edges with accepted endpoints become accepted graph edges", () => {
  const input = makeInput();
  const graph = fuseReviewedObservationsIntoWireframe(input);
  const edge = graph.edges[0];
  assert.equal(edge.reviewState, "accepted");
  assert.deepEqual(edge.sourceViewIds, ["v0", "v1"]);
  assert.equal(edge.sourceObservationRefs.length, 4);
  const proposed = structuredClone(input);
  proposed.edgeProposals[0].status = "proposed";
  const proposedGraph = fuseReviewedObservationsIntoWireframe(proposed);
  assert.equal(proposedGraph.edges[0].reviewState, "review-required");
});

test("an observation assigned to two correspondence groups is flagged, not duplicated", () => {
  const input = makeInput();
  const duplicated = structuredClone(input.correspondences[0]);
  duplicated.id = "cornerA-conflict";
  input.correspondences.push(duplicated);
  const graph = fuseReviewedObservationsIntoWireframe(input);
  assert.equal(graph.vertices.some((vertex) => vertex.id === "cornerA"), false);
  assert.equal(graph.vertices.some((vertex) => vertex.id === "cornerA-conflict"), false);
  assert.equal(graph.issues.filter((issue) => issue.type === "correspondence-conflict").length, 2);
  assert.ok(graph.correspondences.filter((item) => ["cornerA", "cornerA-conflict"].includes(item.correspondenceId)).every((item) => item.status === "review-required"));
  assert.equal(graph.correspondences.find((item) => item.correspondenceId === "cornerB").status, "accepted");
});

test("a two-view group remains review-required because outlier rejection is underdetermined", () => {
  const input = makeInput();
  input.cameras = input.cameras.slice(0, 2);
  input.observationBatches = input.observationBatches.slice(0, 2);
  input.correspondences = input.correspondences.map((group) => ({
    ...group, observationRefs: group.observationRefs.slice(0, 2),
  }));
  input.edgeProposals = [];
  const graph = fuseReviewedObservationsIntoWireframe(input);
  assert.ok(graph.vertices.every((vertex) => vertex.reviewState === "review-required"));
  assert.ok(graph.vertices.every((vertex) => vertex.review.geometryReason === "insufficient-views-for-outlier-rejection"));
  assert.equal(graph.publicationEligible, false);
});

test("unverified camera calibration lowers confidence and prevents accepted vertices", () => {
  const graph = fuseReviewedObservationsIntoWireframe(makeInput({ cameraStatus: "unaudited" }));
  assert.equal(graph.cameraEvidence.status, "review-required");
  assert.ok(graph.vertices.every((vertex) => vertex.reviewState === "review-required"));
  assert.ok(graph.vertices.every((vertex) => vertex.confidence.components.calibrationQuality === 0.6));
});

test("unseen and inferred facades stay explicitly unknown or inferred", () => {
  const graph = fuseReviewedObservationsIntoWireframe(makeInput());
  const byId = new Map(graph.facades.map((facade) => [facade.id, facade]));
  assert.equal(byId.get("front").status, "observed");
  assert.equal(byId.get("rear").status, "unknown");
  assert.equal(byId.get("roof").status, "inferred");
  assert.deepEqual(graph.unknownFacadeIds.sort(), ["left", "rear", "right", "roof"]);
  assert.equal(graph.policy.incompleteFacadesAreNotAssumedAbsent, true);
});

test("facade inventory absence does not imply coverage or full-building completeness", () => {
  const graph = fuseReviewedObservationsIntoWireframe(makeInput({ includeFacades: false }));
  assert.deepEqual(graph.facades, []);
  assert.equal(graph.geometryCompleteness, "sparse-wireframe-only");
  assert.equal(graph.publicationEligible, false);
  assert.equal(graph.status, "review-required");
});

test("source dimensions must agree with the mapped camera and image provenance", () => {
  const input = makeInput();
  input.cameras[0].imageSize.width = 512;
  assert.throws(() => fuseReviewedObservationsIntoWireframe(input), /camera imageSize must match/);
});

test("proposed per-view observations cannot be silently accepted as a 3D vertex", () => {
  const input = makeInput();
  input.observationBatches[0].observations[0].status = "proposed";
  delete input.observationBatches[0].observations[0].reviewedBy;
  delete input.observationBatches[0].observations[0].reviewedAt;
  const graph = fuseReviewedObservationsIntoWireframe(input);
  assert.equal(graph.vertices.some((vertex) => vertex.id === "cornerA"), false);
  assert.ok(graph.issues.some((issue) => issue.type === "correspondence-observation-not-ready" &&
    issue.correspondenceId === "cornerA"));
});
