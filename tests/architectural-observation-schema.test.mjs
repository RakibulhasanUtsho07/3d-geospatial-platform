import assert from "node:assert/strict";
import test from "node:test";
import { appendArchitecturalObservationReview, normalizeArchitecturalObservationBatch } from "../src/core/building-generation/architectural-observation-schema.mjs";

const hash = (n) => n.toString(16).padStart(64, "0");
function fixture(overrides = {}) {
  return {
    schemaVersion: "1.0.0", batchId: "batch-front-a", buildingId: "building-a", viewId: "front",
    createdAt: "2026-10-26T11:00:00Z",
    source: { id: "source-front", sha256: hash(1), width: 100, height: 80 },
    mask: { sha256: hash(2), width: 100, height: 80 },
    observations: [{
      id: "roofline-1", category: "roofline-segment", sourceId: "source-front",
      sourceSha256: hash(1), viewId: "front",
      geometry: { type: "LineString", coordinates: [[10, 12], [90, 14]] },
      confidence: 0.64, method: "mask-top-envelope", status: "proposed", visibility: "visible",
      evidence: { maskSha256: hash(2), edgeMapSha256: hash(3) },
    }],
    ...overrides,
  };
}

test("normalizes evidence-linked per-view proposals with valid image pixel coordinates", () => {
  const batch = normalizeArchitecturalObservationBatch(fixture());
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].sourceSha256, hash(1));
  assert.equal(batch.observations[0].viewId, "front");
  assert.equal(batch.coordinateConvention, "source-image-pixel-origin-top-left");
  assert.equal(batch.policy.publicationEligible, false);
});

test("rejects out-of-image coordinates, dangling sources and invalid confidence", () => {
  const outside = fixture();
  outside.observations[0].geometry.coordinates[1][0] = 101;
  assert.throws(() => normalizeArchitecturalObservationBatch(outside), /outside the source image/);

  const dangling = fixture();
  dangling.observations[0].sourceId = "missing-source";
  assert.throws(() => normalizeArchitecturalObservationBatch(dangling), /mismatched source\/view provenance/);

  const confidence = fixture();
  confidence.observations[0].confidence = 1.1;
  assert.throws(() => normalizeArchitecturalObservationBatch(confidence), /between 0 and 1/);
});

test("keeps not-visible and not-detected states separate and does not require invented geometry", () => {
  const input = fixture();
  input.observations = [
    { id: "back-hidden", category: "facade-region", sourceId: "source-front", sourceSha256: hash(1),
      viewId: "front", confidence: 0, method: "human-review", status: "proposed", visibility: "not-visible", geometry: null },
    { id: "window-missed", category: "window-candidate", sourceId: "source-front", sourceSha256: hash(1),
      viewId: "front", confidence: 0, method: "masked-edge-component", status: "proposed", visibility: "not-detected", geometry: null },
  ];
  const batch = normalizeArchitecturalObservationBatch(input);
  assert.equal(batch.observations[0].visibility, "not-visible");
  assert.equal(batch.observations[1].visibility, "not-detected");
  assert.equal(batch.observations[1].geometry, null);
});

test("rejects dangling mask hash, invalid polygon rings and reviewed rows without reviewer metadata", () => {
  const wrongMask = fixture();
  wrongMask.observations[0].evidence.maskSha256 = hash(9);
  assert.throws(() => normalizeArchitecturalObservationBatch(wrongMask), /mask evidence does not match/);

  const polygon = fixture();
  polygon.observations[0].geometry = { type: "Polygon", coordinates: [[[1,1],[10,1],[10,10],[1,5]]] };
  assert.throws(() => normalizeArchitecturalObservationBatch(polygon), /rings must be closed/);

  const reviewed = fixture();
  reviewed.observations[0].status = "reviewed";
  assert.throws(() => normalizeArchitecturalObservationBatch(reviewed), /needs reviewer and timestamp/);
});

test("review append preserves the proposal and records an append-only audit history", () => {
  const original = normalizeArchitecturalObservationBatch(fixture()).observations[0];
  const reviewed = appendArchitecturalObservationReview(original, {
    decision: "reviewed", reviewerId: "architect-a", reviewedAt: "2026-10-26T12:00:00Z", notes: "Roof edge confirmed in this photo.",
  });
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.originalProposal.geometry.coordinates[0][0], 10);
  assert.equal(reviewed.reviews.length, 1);
  const rejected = appendArchitecturalObservationReview(reviewed, {
    decision: "rejected", reviewerId: "architect-b", reviewedAt: "2026-10-26T12:30:00Z", notes: "Perspective edge was misleading.",
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.originalProposal.geometry.coordinates[0][0], 10);
  assert.equal(rejected.reviews.length, 2);
  assert.equal(rejected.reviews[0].reviewerId, "architect-a");

  const restored = normalizeArchitecturalObservationBatch({
    ...fixture(),
    observations: [rejected],
  });
  const normalized = restored.observations[0];
  assert.equal(normalized.status, "rejected");
  assert.equal(normalized.reviewedBy, "architect-b");
  assert.equal(normalized.originalProposal.geometry.coordinates[0][0], 10);
  assert.equal(normalized.reviews.length, 2);
  assert.deepEqual(normalized.reviews.map((event) => event.decision), ["reviewed", "rejected"]);
  assert.equal(normalized.reviews[0].notes, "Roof edge confirmed in this photo.");
  assert.equal(normalized.reviews[1].reviewerId, "architect-b");
});

test("preserves a prior review trail when an observation is re-opened as proposed", () => {
  const original = normalizeArchitecturalObservationBatch(fixture()).observations[0];
  const reviewed = appendArchitecturalObservationReview(original, {
    decision: "reviewed", reviewerId: "architect-a", reviewedAt: "2026-10-26T12:00:00Z",
  });
  const reopened = {
    ...reviewed,
    status: "proposed",
    reviewedBy: undefined,
    reviewedAt: undefined,
    confidence: 0.7,
    geometry: { type: "LineString", coordinates: [[12, 13], [88, 16]] },
  };
  const normalized = normalizeArchitecturalObservationBatch({
    ...fixture(), observations: [reopened],
  }).observations[0];
  assert.equal(normalized.status, "proposed");
  assert.equal(normalized.geometry.coordinates[0][0], 12);
  assert.equal(normalized.originalProposal.geometry.coordinates[0][0], 10);
  assert.equal(normalized.reviews.length, 1);
  assert.equal(normalized.reviews[0].decision, "reviewed");
  assert.equal("reviewedBy" in normalized, false);
});

test("rejects tampered review history and invalid audit notes", () => {
  const original = normalizeArchitecturalObservationBatch(fixture()).observations[0];
  const reviewed = appendArchitecturalObservationReview(original, {
    decision: "reviewed", reviewerId: "architect-a", reviewedAt: "2026-10-26T12:00:00Z",
    notes: "Roofline confirmed.",
  });

  const tamperedReviewer = structuredClone(reviewed);
  tamperedReviewer.reviews[0].reviewerId = "different-reviewer";
  assert.throws(() => normalizeArchitecturalObservationBatch({
    ...fixture(), observations: [tamperedReviewer],
  }), /latest append-only review event/);

  const oversizedNotes = structuredClone(reviewed);
  oversizedNotes.reviews[0].notes = "x".repeat(2001);
  assert.throws(() => normalizeArchitecturalObservationBatch({
    ...fixture(), observations: [oversizedNotes],
  }), /at most 2000 characters/);

  const missingSnapshot = structuredClone(reviewed);
  delete missingSnapshot.originalProposal;
  assert.throws(() => normalizeArchitecturalObservationBatch({
    ...fixture(), observations: [missingSnapshot],
  }), /originalProposal is required/);
});
