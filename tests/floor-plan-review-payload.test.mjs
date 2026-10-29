import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalFloorPlanReviewJson,
  buildFloorPlanRasterReviewPayload,
} from "../src/core/building-generation/floor-plan-review-payload.mjs";
import { hashFloorPlanRasterProposalReport } from "../src/core/building-generation/floor-plan-raster-vector-calibration.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const sourceBytes = Buffer.from("local review UI fixture source");
  const candidates = [
    { id: "line-0001", orientation: "horizontal", start: { x: 100, y: 100 }, end: { x: 300, y: 100 }, semanticClass: "ambiguous-line-candidate" },
    { id: "line-0002", orientation: "vertical", start: { x: 300, y: 100 }, end: { x: 300, y: 300 }, semanticClass: "ambiguous-line-candidate" },
    { id: "line-0003", orientation: "horizontal", start: { x: 100, y: 300 }, end: { x: 300, y: 300 }, semanticClass: "ambiguous-line-candidate" },
    { id: "line-0004", orientation: "vertical", start: { x: 100, y: 100 }, end: { x: 100, y: 300 }, semanticClass: "ambiguous-line-candidate" },
    { id: "line-0005", orientation: "horizontal", start: { x: 20, y: 30 }, end: { x: 90, y: 30 }, semanticClass: "ambiguous-line-candidate" },
  ];
  const proposalReport = {
    schemaVersion: "1.0.0",
    engine: "floor-plan-raster-line-proposals-v1",
    status: "review-required-not-scaled",
    source: { sha256: hash(sourceBytes), mimeType: "image/png", byteSize: sourceBytes.length },
    raster: { width: 400, height: 400, pixelUnits: "px" },
    candidates,
    calibration: { status: "not-calibrated", metresPerPixel: null },
    mapReady: false,
    publicationEligible: false,
  };
  const candidateReviews = candidates.map((candidate, index) => ({
    proposalId: candidate.id,
    decision: index === 4 ? "reject" : "accept-wall",
    wallId: ["north-wall", "east-wall", "south-wall", "west-wall"][index] ?? "unused-wall",
    reason: index === 4 ? "False line from a dimension annotation." : "",
    startPx: [candidate.start.x, candidate.start.y],
    endPx: [candidate.end.x, candidate.end.y],
    openings: [],
  }));
  const args = {
    proposalReport,
    sourceSha256: proposalReport.source.sha256,
    proposalReportSha256: hashFloorPlanRasterProposalReport(proposalReport),
    reviewer: "test-reviewer",
    reviewedAt: "2026-10-29T06:30:00.000Z",
    notes: "Reviewed fixture against the exact source bytes.",
    sourceId: "floor-plan-source",
    buildingId: "building-demo",
    floorPlanId: "floor-plan-demo",
    floorPlanName: "Demo floor plan",
    confirmedAgainstSource: true,
    originPixel: [100, 100],
    calibration: {
      pointA: [100, 100],
      pointB: [300, 100],
      distanceM: 10,
      evidenceDescription: "The exact source plan labels the selected dimension as 10 metres.",
    },
    placement: { longitude: 90.406, latitude: 23.709, heightM: 3.5, headingDegrees: 0 },
    level: { elevationM: 0, wallHeightM: 3, wallThicknessM: 0.15, floorThicknessM: 0.12 },
    topologyToleranceM: 0.1,
    candidateReviews,
    rooms: [{
      id: "living-room",
      name: "Living Room",
      decision: "accept",
      reviewed: true,
      polygonPx: [[100, 100], [300, 100], [300, 300], [100, 300]],
    }],
  };
  return { sourceBytes, ...args };
}

test("creates the exact calibrated-vector review contract and matching canonical proposal hash", () => {
  const input = fixture();
  const payload = buildFloorPlanRasterReviewPayload(input);
  assert.equal(payload.schemaVersion, "1.0.0");
  assert.equal(payload.sourceSha256, input.proposalReport.source.sha256);
  assert.equal(payload.proposalReportSha256, input.proposalReportSha256);
  assert.equal(payload.confirmedAgainstSource, true);
  assert.equal(payload.candidateDecisions.length, 5);
  assert.equal(payload.walls.length, 4);
  assert.equal(payload.walls[0].id, "north-wall");
  assert.deepEqual(payload.walls[0].startPx, [100, 100]);
  assert.equal(payload.rooms[0].decision, "accept");
  assert.equal(payload.rooms[0].reviewed, true);
  assert.equal(payload.reviewedAt, "2026-10-29T06:30:00.000Z");
  assert.equal(hashFloorPlanRasterProposalReport(input.proposalReport), payload.proposalReportSha256);
});

test("canonical review input is stable regardless of object key insertion order", () => {
  assert.equal(canonicalFloorPlanReviewJson({ z: 1, a: { y: 2, x: 3 } }), canonicalFloorPlanReviewJson({ a: { x: 3, y: 2 }, z: 1 }));
});

test("blocks missing decisions and requires explicit rejection reasons", () => {
  const missing = fixture();
  missing.candidateReviews.pop();
  assert.throws(() => buildFloorPlanRasterReviewPayload(missing), (error) => error.code === "INCOMPLETE_CANDIDATE_REVIEW");
  const noReason = fixture();
  noReason.candidateReviews[2] = { proposalId: "line-0003", decision: "reject", reason: "" };
  assert.throws(() => buildFloorPlanRasterReviewPayload(noReason), /rejection reason/);
});

test("rejects a source hash mismatch, unconfirmed review and incomplete room", () => {
  const source = fixture();
  source.sourceSha256 = "0".repeat(64);
  assert.throws(() => buildFloorPlanRasterReviewPayload(source), (error) => error.code === "SOURCE_CHECKSUM_MISMATCH");
  const unconfirmed = fixture();
  unconfirmed.confirmedAgainstSource = false;
  assert.throws(() => buildFloorPlanRasterReviewPayload(unconfirmed), (error) => error.code === "SOURCE_REVIEW_REQUIRED");
  const room = fixture();
  room.rooms[0].reviewed = false;
  assert.throws(() => buildFloorPlanRasterReviewPayload(room), (error) => error.code === "ROOM_REVIEW_REQUIRED");
});

test("requires a reasoned endpoint correction and enforces closed-world opening bounds", () => {
  const correction = fixture();
  correction.candidateReviews[0].startPx = [160, 100];
  correction.candidateReviews[0].endPx = [300, 100];
  assert.throws(() => buildFloorPlanRasterReviewPayload(correction), (error) => error.code === "WALL_CORRECTION_REASON_REQUIRED");
  correction.candidateReviews[0].correctionReason = "Extended to the room corner after source inspection.";
  correction.candidateReviews[0].openings = [{
    id: "front-door", type: "door", offsetPx: 140, widthPx: 30, heightM: 2.1, sillHeightM: 0,
  }];
  assert.throws(() => buildFloorPlanRasterReviewPayload(correction), /extends past wall/);
});

test("converts candidate review decisions and retains explicit door/window dimensions in pixel and metric fields", () => {
  const input = fixture();
  input.candidateReviews[0].openings = [{
    id: "front-door", type: "door", offsetPx: 50, widthPx: 20, heightM: 2.1, sillHeightM: 0,
  }];
  const payload = buildFloorPlanRasterReviewPayload(input);
  assert.deepEqual(payload.candidateDecisions[4], {
    proposalId: "line-0005", decision: "reject", reason: "False line from a dimension annotation.",
  });
  assert.equal(payload.walls.length, 4);
  assert.deepEqual(payload.walls[0].openings[0], {
    id: "front-door", type: "door", offsetPx: 50, widthPx: 20, heightM: 2.1, sillHeightM: 0,
  });
});

test("rejects a room boundary with no reviewed wall vector along one edge", () => {
  const input = fixture();
  input.candidateReviews[3] = {
    proposalId: "line-0004",
    decision: "reject",
    reason: "False line from a dimension annotation.",
  };
  assert.throws(() => buildFloorPlanRasterReviewPayload(input), (error) => error.code === "ROOM_BOUNDARY_NOT_COVERED");
});

test("rejects malformed proposal hashes and implausible calibration", () => {
  const stale = fixture();
  stale.proposalReportSha256 = "not-a-sha256";
  assert.throws(() => buildFloorPlanRasterReviewPayload(stale), (error) => error.code === "INVALID_REVIEW");
  const implausible = fixture();
  implausible.calibration.distanceM = 10000;
  assert.throws(() => buildFloorPlanRasterReviewPayload(implausible), (error) => error.code === "IMPLAUSIBLE_SCALE");
});
