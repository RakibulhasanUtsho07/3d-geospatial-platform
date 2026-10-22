import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";

import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import { loadFloorPlanRasterTrace, traceFloorPlanImageSource } from "../src/core/building-generation/floor-plan-raster-trace-job.mjs";
import { generateFloorPlanCandidateFromRasterTrace } from "../src/core/building-generation/floor-plan-raster-generation.mjs";
import { loadFloorPlanModelCandidate } from "../src/core/building-generation/floor-plan-model-job.mjs";

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="#f5f5f5"/>
  <g fill="none" stroke="#141414" stroke-width="5" stroke-linecap="square">
    <path d="M30 30H290 M30 120H290 M30 210H290"/>
    <path d="M30 30V210 M160 30V210 M290 30V210"/>
  </g>
</svg>`, "utf8");
const png = await sharp(svg).png().toBuffer();

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "floor-plan-raster-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  await writeFile(path.join(root, "uploads", "plan.png"), png);
  const source = await ingestMediaFile({
    workspaceRoot: root,
    sourcePath: "uploads/plan.png",
    buildingId: "dhaka-demo",
    sourceId: "plan-image",
    kind: "floor-plan",
    licence: "CC BY 4.0",
    usageStatus: "unreviewed",
  });
  const trace = await traceFloorPlanImageSource({
    workspaceRoot: root,
    buildingId: "dhaka-demo",
    sourceId: "plan-image",
    options: {
      maxEdge: 512,
      threshold: 180,
      minLineLengthPx: 50,
      minRoomSidePx: 40,
      lineMergeTolerancePx: 4,
    },
  });
  return { root, source, trace };
}

function conversion(trace) {
  return {
    confirmTraceReview: true,
    planId: "ground-floor",
    name: "Dhaka Demo Ground Floor",
    reviewNotes: "I compared the selected orthogonal wall and room candidates with the original drawing.",
    origin: { longitude: 90.406, latitude: 23.709, heightM: 3.5, headingDegrees: 0 },
    originPixel: [30, 30],
    calibration: { startPx: [30, 30], endPx: [290, 30], distanceM: 26 },
    level: { elevationM: 0, wallHeightM: 3, wallThicknessM: 0.15, floorThicknessM: 0.12 },
    confirmedLineIds: [
      ...trace.candidates.horizontalWalls.map((line) => line.id),
      ...trace.candidates.verticalWalls.map((line) => line.id),
    ],
    confirmedRoomIds: trace.candidates.rooms.map((room) => room.id),
  };
}

test("turns a reviewed/calibrated private raster trace into a GLB candidate bound to trace evidence", async (t) => {
  const state = await setup(t);
  const trace = await loadFloorPlanRasterTrace({
    workspaceRoot: state.root,
    buildingId: "dhaka-demo",
    traceId: state.trace.traceId,
  });
  const selected = conversion(trace);
  const result = await generateFloorPlanCandidateFromRasterTrace({
    workspaceRoot: state.root,
    buildingId: "dhaka-demo",
    traceId: state.trace.traceId,
    conversion: selected,
  });

  assert.equal(result.status, "candidate-requires-human-review");
  assert.equal(result.sourceSha256, state.source.record.sha256);
  assert.equal(result.sourceUsageStatus, "unreviewed");
  assert.equal(result.report.input.rasterTrace.traceId, state.trace.traceId);
  assert.match(result.report.input.rasterTrace.traceSha256, /^[a-f0-9]{64}$/);
  assert.match(result.report.input.rasterTrace.transformationSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.report.input.rasterTrace.confirmedLineCount, result.transformationAudit.confirmedLineIds.length);
  assert.equal(result.report.input.rasterTrace.confirmedRoomCount, result.transformationAudit.confirmedRoomIds.length);
  assert.equal(result.report.input.rasterTrace.metresPerSourcePixel, 0.1);
  assert.equal(result.transformationAudit.status, "measured-draft-needs-independent-QA");
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);

  const candidate = await loadFloorPlanModelCandidate({
    workspaceRoot: state.root,
    buildingId: "dhaka-demo",
    candidateId: result.candidateId,
  });
  assert.equal(candidate.plan.evidence.sha256, state.source.record.sha256);
  assert.equal(candidate.traceReview.traceId, state.trace.traceId);
  assert.equal(candidate.traceReview.traceSha256, result.transformationAudit.traceSha256);
  assert.deepEqual(candidate.traceReview.confirmedRoomIds, selected.confirmedRoomIds);

  const candidateDirectory = path.join(
    state.root, ".building-engine", "floor-plan-candidates", "dhaka-demo", result.candidateId,
  );
  const reportOnDisk = JSON.parse(await readFile(path.join(candidateDirectory, "report.json"), "utf8"));
  const transformationBytes = await readFile(path.join(candidateDirectory, "trace-review.json"));
  assert.equal(
    reportOnDisk.input.rasterTrace.transformationSha256,
    createHash("sha256").update(transformationBytes).digest("hex"),
  );
  assert.equal(candidate.report.output.sha256, result.modelSha256);
});

test("refuses a room selection when its boundary wall was not confirmed", async (t) => {
  const state = await setup(t);
  const trace = await loadFloorPlanRasterTrace({
    workspaceRoot: state.root,
    buildingId: "dhaka-demo",
    traceId: state.trace.traceId,
  });
  const input = conversion(trace);
  input.confirmedLineIds = input.confirmedLineIds.filter((id) => id !== trace.candidates.verticalWalls[1].id);
  await assert.rejects(
    generateFloorPlanCandidateFromRasterTrace({
      workspaceRoot: state.root,
      buildingId: "dhaka-demo",
      traceId: state.trace.traceId,
      conversion: input,
    }),
    /all four of its boundary wall candidates/,
  );
  await assert.rejects(
    readFile(path.join(state.root, ".building-engine", "floor-plan-candidates", "dhaka-demo")),
    { code: "ENOENT" },
  );
});

test("candidate retrieval detects tampering with persisted trace transformation audit", async (t) => {
  const state = await setup(t);
  const { loadFloorPlanRasterTrace } = await import("../src/core/building-generation/floor-plan-raster-trace-job.mjs");
  const trace = await loadFloorPlanRasterTrace({
    workspaceRoot: state.root,
    buildingId: "dhaka-demo",
    traceId: state.trace.traceId,
  });
  const result = await generateFloorPlanCandidateFromRasterTrace({
    workspaceRoot: state.root,
    buildingId: "dhaka-demo",
    traceId: state.trace.traceId,
    conversion: conversion(trace),
  });
  const auditPath = path.join(
    state.root, ".building-engine", "floor-plan-candidates", "dhaka-demo", result.candidateId, "trace-review.json",
  );
  await writeFile(auditPath, "{}\n");
  await assert.rejects(
    loadFloorPlanModelCandidate({
      workspaceRoot: state.root,
      buildingId: "dhaka-demo",
      candidateId: result.candidateId,
    }),
    /transformation checksum does not match/,
  );
});
