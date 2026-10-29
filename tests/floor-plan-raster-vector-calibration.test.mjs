import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  calibrateFloorPlanRasterVectors,
  hashFloorPlanRasterProposalReport,
} from "../src/core/building-generation/floor-plan-raster-vector-calibration.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const sourceBytes = Buffer.from("verified raster source bytes for calibration test", "utf8");
  const candidates = [
    { id: "line-0001", orientation: "horizontal", start: { x: 100, y: 100 }, end: { x: 300, y: 100 }, semanticClass: "ambiguous-line-candidate" },
    { id: "line-0002", orientation: "vertical", start: { x: 300, y: 100 }, end: { x: 300, y: 300 }, semanticClass: "ambiguous-line-candidate" },
    { id: "line-0003", orientation: "horizontal", start: { x: 100, y: 300 }, end: { x: 300, y: 300 }, semanticClass: "ambiguous-line-candidate" },
    { id: "line-0004", orientation: "vertical", start: { x: 100, y: 100 }, end: { x: 100, y: 300 }, semanticClass: "ambiguous-line-candidate" },
  ];
  const proposalReport = {
    schemaVersion: "1.0.0",
    engine: "floor-plan-raster-line-proposals-v1",
    status: "review-required-not-scaled",
    source: { sha256: sha256(sourceBytes), mimeType: "image/png", byteSize: sourceBytes.length },
    raster: { width: 400, height: 400, originalWidth: 800, originalHeight: 800, pixelUnits: "px" },
    calibration: { status: "not-calibrated", metresPerPixel: null, pixelsPerMetre: null, units: "pixel" },
    summary: { candidateCount: candidates.length },
    candidates,
    warnings: ["Test only."],
    mapReady: false,
    publicationEligible: false,
  };
  const review = {
    schemaVersion: "1.0.0",
    sourceSha256: proposalReport.source.sha256,
    proposalReportSha256: hashFloorPlanRasterProposalReport(proposalReport),
    confirmedAgainstSource: true,
    reviewer: "test-reviewer",
    reviewedAt: "2026-10-29T06:00:00.000Z",
    notes: "Fixture lines were explicitly compared with the test source raster.",
    sourceId: "floor-plan-source",
    buildingId: "building-demo",
    floorPlanId: "floor-plan-demo",
    floorPlanName: "Reviewed demo ground floor",
    originPixel: [100, 100],
    calibration: {
      pointA: [100, 100],
      pointB: [300, 100],
      distanceM: 10,
      evidenceDescription: "Dimension annotation from the source plan: 10.00 m between the selected endpoints.",
    },
    placement: { longitude: 90.406, latitude: 23.709, heightM: 3.5, headingDegrees: 0 },
    level: { elevationM: 0, wallHeightM: 3, wallThicknessM: 0.15, floorThicknessM: 0.12 },
    topologyToleranceM: 0.1,
    candidateDecisions: candidates.map((candidate) => ({ proposalId: candidate.id, decision: "accept-wall" })),
    rooms: [{
      id: "living-room",
      name: "Living Room",
      decision: "accept",
      reviewed: true,
      polygonPx: [[100, 100], [300, 100], [300, 300], [100, 300]],
    }],
    walls: candidates.map((candidate, index) => ({
      id: ["north-wall", "east-wall", "south-wall", "west-wall"][index],
      proposalId: candidate.id,
      decision: "accept",
      semanticClass: "wall",
      reviewed: true,
      startPx: [candidate.start.x, candidate.start.y],
      endPx: [candidate.end.x, candidate.end.y],
      openings: [],
    })),
  };
  return { sourceBytes, proposalReport, review };
}

test("converts reviewed pixels to metre-space vectors, checks closed-room boundaries and keeps release gates off", () => {
  const input = fixture();
  const result = calibrateFloorPlanRasterVectors(input);
  assert.equal(result.status, "review-required-calibrated-vector-draft");
  assert.deepEqual(result.floorPlan.rooms[0].polygon, [[0, 0], [10, 0], [10, -10], [0, -10]]);
  assert.equal(result.floorPlan.source.sha256, input.proposalReport.source.sha256);
  assert.equal(result.floorPlan.walls.length, 4);
  assert.equal(result.audit.source.bytesVerified, true);
  assert.equal(result.audit.calibration.status, "human-attested-scale-not-independently-survey-verified");
  assert.equal(result.audit.calibration.metresPerPixel, 0.05);
  assert.equal(result.audit.vector.allRoomBoundariesCovered, true);
  assert.equal(result.audit.vector.roomBoundaryEdgeCount, 4);
  assert.match(result.audit.vector.generatedPreviewGlbSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.audit.vector.previewWrittenToDisk, false);
  assert.deepEqual(result.audit.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
});

test("is deterministic for identical source, report and review inputs", () => {
  const input = fixture();
  assert.deepEqual(calibrateFloorPlanRasterVectors(input), calibrateFloorPlanRasterVectors(input));
});

test("rejects changed original source bytes", () => {
  const input = fixture();
  input.sourceBytes = Buffer.concat([input.sourceBytes, Buffer.from("tampered")]);
  assert.throws(() => calibrateFloorPlanRasterVectors(input), (error) => error.code === "SOURCE_SIZE_MISMATCH");
});

test("rejects a review tied to a stale or modified proposal report", () => {
  const input = fixture();
  input.proposalReport.candidates[0].confidenceScore = 0.99;
  assert.throws(() => calibrateFloorPlanRasterVectors(input), (error) => error.code === "REVIEW_PROPOSAL_MISMATCH");
});

test("requires an explicit decision for every detected candidate", () => {
  const input = fixture();
  input.review.candidateDecisions.pop();
  assert.throws(() => calibrateFloorPlanRasterVectors(input), (error) => error.code === "INCOMPLETE_CANDIDATE_REVIEW");
});

test("requires a reason when a detected segment is manually extended by more than 25 pixels", () => {
  const input = fixture();
  input.proposalReport.candidates[0].start.x = 160;
  input.proposalReport.candidates[0].end.x = 240;
  input.review.proposalReportSha256 = hashFloorPlanRasterProposalReport(input.proposalReport);
  assert.throws(() => calibrateFloorPlanRasterVectors(input), (error) => error.code === "WALL_CORRECTION_REASON_REQUIRED");
});

test("allows a reasoned manual correction and keeps a complete room boundary", () => {
  const input = fixture();
  input.proposalReport.candidates[0].start.x = 160;
  input.proposalReport.candidates[0].end.x = 240;
  input.review.proposalReportSha256 = hashFloorPlanRasterProposalReport(input.proposalReport);
  input.review.walls[0].correctionReason = "Extended to the reviewed room corners visible on the source plan.";
  const result = calibrateFloorPlanRasterVectors(input);
  assert.equal(result.audit.vector.allRoomBoundariesCovered, true);
  assert.ok(result.audit.vector.roomBoundaryChecks.every((check) => check.covered));
  assert.equal(result.audit.proposal.canonicalSha256, input.review.proposalReportSha256);
});

test("rejects a room whose boundary is missing a reviewed wall centre-line", () => {
  const input = fixture();
  input.review.candidateDecisions[3] = {
    proposalId: "line-0004",
    decision: "reject",
    reason: "False line in the source drawing.",
  };
  input.review.walls.pop();
  assert.throws(() => calibrateFloorPlanRasterVectors(input), (error) => error.code === "ROOM_BOUNDARY_NOT_COVERED");
});

test("rejects implausible scale and unreviewed room semantics", () => {
  const scale = fixture();
  scale.review.calibration.distanceM = 10000;
  assert.throws(() => calibrateFloorPlanRasterVectors(scale), (error) => error.code === "IMPLAUSIBLE_SCALE");
  const room = fixture();
  room.review.rooms[0].reviewed = false;
  assert.throws(() => calibrateFloorPlanRasterVectors(room), (error) => error.code === "ROOM_REVIEW_REQUIRED");
});

test("converts reviewed pixel opening intervals to metres and delegates opening fit to model validation", () => {
  const input = fixture();
  input.review.walls[0].openings = [{
    id: "main-door",
    type: "door",
    offsetPx: 50,
    widthPx: 20,
    heightM: 2.1,
    sillHeightM: 0,
  }];
  const result = calibrateFloorPlanRasterVectors(input);
  assert.equal(result.floorPlan.walls[0].openings[0].offsetM, 2.5);
  assert.equal(result.floorPlan.walls[0].openings[0].widthM, 1);
  assert.equal(result.audit.vector.openingCount, 1);
});
