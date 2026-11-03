import assert from "node:assert/strict";
import test from "node:test";

import { convertFloorPlanTraceToVectorPlan } from "../src/core/building-generation/floor-plan-trace-to-vector.mjs";

const SOURCE_HASH = "a".repeat(64);
const TRACE_HASH = "b".repeat(64);

function traceFixture() {
  const line = (id, orientation, positionPx, startPx, endPx) => ({
    id, orientation, positionPx, startPx, endPx,
    lengthPx: endPx - startPx + 1,
    estimatedThicknessPx: 5,
    detectorScore: 0.9,
    reviewStatus: "unreviewed",
  });
  return {
    schemaVersion: "1.0.0",
    engine: "orthogonal-floor-plan-raster-trace-v1",
    status: "needs-human-trace-review",
    traceId: "trace-demo",
    buildingId: "dhaka-demo",
    sourceId: "plan-image",
    source: { sha256: SOURCE_HASH, width: 320, height: 240, pixelFormat: "8-bit-grayscale" },
    sourceEvidence: { sha256: SOURCE_HASH, mimeType: "image/png", byteSize: 1234, usageStatus: "approved", licence: "CC BY 4.0" },
    artifactSha256: TRACE_HASH,
    coordinateSystem: "oriented-raster-pixels",
    scale: { metresPerPixel: null, status: "unknown-until-calibrated" },
    raster: {
      orientedSourceWidth: 320,
      orientedSourceHeight: 240,
      analysisWidth: 320,
      analysisHeight: 240,
      sourcePixelsPerAnalysisPixelX: 1,
      sourcePixelsPerAnalysisPixelY: 1,
      reductionApplied: false,
    },
    candidates: {
      horizontalWalls: [
        line("h-001", "horizontal", 20, 20, 220),
        line("h-002", "horizontal", 120, 20, 220),
        line("h-003", "horizontal", 220, 20, 220),
      ],
      verticalWalls: [
        line("v-001", "vertical", 20, 20, 220),
        line("v-002", "vertical", 120, 20, 220),
        line("v-003", "vertical", 220, 20, 220),
      ],
      rooms: [
        { id: "room-001", polygonPx: [[20,20],[120,20],[120,120],[20,120]], boundaryLineIds: ["h-001","v-002","h-002","v-001"], reviewStatus: "unreviewed" },
        { id: "room-002", polygonPx: [[120,20],[220,20],[220,120],[120,120]], boundaryLineIds: ["h-001","v-003","h-002","v-002"], reviewStatus: "unreviewed" },
      ],
    },
    summary: { horizontalWallCandidates: 3, verticalWallCandidates: 3, roomCandidates: 2, totalWallCandidates: 6 },
    mapReady: false,
    publicationEligible: false,
  };
}

function input(trace = traceFixture()) {
  return {
    trace,
    confirmTraceReview: true,
    planId: "ground-floor",
    name: "Dhaka Demo Ground Floor",
    reviewNotes: "I checked each selected wall and room candidate against the original plan.",
    origin: { longitude: 90.406, latitude: 23.709, heightM: 3.5, headingDegrees: 0 },
    originPixel: [20, 20],
    calibration: { startPx: [20, 20], endPx: [120, 20], distanceM: 10 },
    level: { elevationM: 0, wallHeightM: 3, wallThicknessM: 0.15, floorThicknessM: 0.12 },
    confirmedLineIds: ["h-001","h-002","h-003","v-001","v-002","v-003"],
    confirmedRoomIds: ["room-001"],
  };
}

test("converts only explicitly selected raster candidates into metric floor-plan vectors", () => {
  const result = convertFloorPlanTraceToVectorPlan(input());
  assert.equal(result.floorPlan.id, "ground-floor");
  assert.equal(result.floorPlan.buildingId, "dhaka-demo");
  assert.equal(result.floorPlan.source.sourceId, "plan-image");
  assert.equal(result.floorPlan.source.sha256, SOURCE_HASH);
  assert.equal(result.floorPlan.units, "m");
  assert.equal(result.floorPlan.walls.length, 6);
  assert.equal(result.floorPlan.rooms.length, 1);
  assert.equal(result.transformation.method, "operator-confirmed-orthogonal-raster-trace-to-metric-vectors-v1");
  assert.equal(result.transformation.traceSha256, TRACE_HASH);
  assert.equal(result.transformation.calibration.metresPerSourcePixel, 0.1);
  assert.deepEqual(result.floorPlan.rooms[0].polygon, [[0,0],[10,0],[10,10],[0,10]]);
  assert.equal(result.transformation.status, "measured-draft-needs-independent-QA");
  assert.equal(result.transformation.mapReady, false);
  assert.equal(result.transformation.publicationEligible, false);
});

test("requires explicit human confirmation, scale calibration, surveyed origin and review notes", () => {
  assert.throws(() => convertFloorPlanTraceToVectorPlan({ ...input(), confirmTraceReview: false }), /confirmTraceReview must be true/);
  assert.throws(() => convertFloorPlanTraceToVectorPlan({ ...input(), calibration: undefined }), /known-distance calibration segment/);
  assert.throws(() => convertFloorPlanTraceToVectorPlan({ ...input(), origin: { longitude: 999, latitude: 23, heightM: 0, headingDegrees: 0 } }), /origin.longitude/);
  assert.throws(() => convertFloorPlanTraceToVectorPlan({ ...input(), reviewNotes: "ok" }), /12 to 2000 characters/);
  assert.throws(() => convertFloorPlanTraceToVectorPlan({ ...input(), calibration: { startPx: [20,20], endPx: [21,20], distanceM: 10 } }), /at least 5 source pixels/);
});

test("rejects room candidates if any boundary line was not explicitly selected", () => {
  const candidate = input();
  candidate.confirmedLineIds = candidate.confirmedLineIds.filter((value) => value !== "v-002");
  assert.throws(() => convertFloorPlanTraceToVectorPlan(candidate), /all four of its boundary wall candidates/);
});

test("rejects IDs outside the trace and impossible scale", () => {
  assert.throws(() => convertFloorPlanTraceToVectorPlan({ ...input(), confirmedLineIds: ["h-001","h-002","h-003","fake"] }), /line not present in this trace/);
  assert.throws(() => convertFloorPlanTraceToVectorPlan({ ...input(), calibration: { startPx: [20,20], endPx: [120,20], distanceM: 1000 } }), /metres-per-source-pixel falls outside/);
});
