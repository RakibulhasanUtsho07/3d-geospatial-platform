import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { hashFloorPlanRasterProposalReport } from "../src/core/building-generation/floor-plan-raster-vector-calibration.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inputs() {
  const sourceBytes = Buffer.from("CLI verified source image bytes");
  const points = [
    [[100, 100], [300, 100]],
    [[300, 100], [300, 300]],
    [[100, 300], [300, 300]],
    [[100, 100], [100, 300]],
  ];
  const candidates = points.map(([a, b], index) => ({
    id: "line-" + String(index + 1).padStart(4, "0"),
    orientation: index % 2 === 0 ? "horizontal" : "vertical",
    start: { x: a[0], y: a[1] },
    end: { x: b[0], y: b[1] },
  }));
  const proposalReport = {
    schemaVersion: "1.0.0",
    engine: "floor-plan-raster-line-proposals-v1",
    status: "review-required-not-scaled",
    source: { sha256: hash(sourceBytes), mimeType: "image/png", byteSize: sourceBytes.length },
    raster: { width: 400, height: 400, pixelUnits: "px" },
    candidates,
    mapReady: false,
    publicationEligible: false,
  };
  const review = {
    schemaVersion: "1.0.0",
    sourceSha256: proposalReport.source.sha256,
    proposalReportSha256: hashFloorPlanRasterProposalReport(proposalReport),
    confirmedAgainstSource: true,
    reviewer: "cli-reviewer",
    reviewedAt: "2026-10-29T06:10:00Z",
    notes: "Reviewed CLI fixture against the exact source.",
    sourceId: "source-plan",
    buildingId: "building-cli",
    floorPlanId: "ground-floor-cli",
    floorPlanName: "CLI Ground Floor",
    originPixel: [100, 100],
    calibration: {
      pointA: [100, 100], pointB: [300, 100], distanceM: 10,
      evidenceDescription: "Dimension annotation on the fixture.",
    },
    placement: { longitude: 90.406, latitude: 23.709, heightM: 3.5, headingDegrees: 0 },
    level: { elevationM: 0, wallHeightM: 3, wallThicknessM: 0.15, floorThicknessM: 0.12 },
    candidateDecisions: candidates.map((candidate) => ({ proposalId: candidate.id, decision: "accept-wall" })),
    rooms: [{ id: "room-cli", name: "Room", decision: "accept", reviewed: true, polygonPx: [[100, 100], [300, 100], [300, 300], [100, 300]] }],
    walls: candidates.map((candidate, index) => ({
      id: ["wall-north", "wall-east", "wall-south", "wall-west"][index],
      proposalId: candidate.id,
      decision: "accept",
      semanticClass: "wall",
      reviewed: true,
      startPx: [candidate.start.x, candidate.start.y],
      endPx: [candidate.end.x, candidate.end.y],
    })),
  };
  return { sourceBytes, proposalReport, review };
}

test("CLI binds source bytes and writes private vector and audit JSON without overwriting", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "floor-plan-vector-calibration-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = inputs();
  const proposalPath = path.join(root, "proposal.json");
  const reviewPath = path.join(root, "review.json");
  const sourcePath = path.join(root, "source.png");
  const geometryPath = path.join(root, "geometry.json");
  const auditPath = path.join(root, "audit.json");
  await Promise.all([
    writeFile(proposalPath, JSON.stringify(files.proposalReport)),
    writeFile(reviewPath, JSON.stringify(files.review)),
    writeFile(sourcePath, files.sourceBytes),
  ]);
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/calibrate-floor-plan-raster-vectors.mjs");
  const run = spawnSync(process.execPath, [scriptPath, proposalPath, reviewPath, sourcePath, geometryPath, auditPath], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const geometry = JSON.parse(await readFile(geometryPath, "utf8"));
  const audit = JSON.parse(await readFile(auditPath, "utf8"));
  assert.equal(geometry.rooms.length, 1);
  assert.equal(geometry.walls.length, 4);
  assert.equal(audit.source.bytesVerified, true);
  assert.equal(audit.vector.allRoomBoundariesCovered, true);
  assert.deepEqual(audit.releaseFlags, {
    acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false,
  });
  assert.equal((await stat(geometryPath)).mode & 0o777, 0o600);
  assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  assert.equal(hash(Buffer.from(JSON.stringify(geometry, null, 2) + "\n")), hash(await readFile(geometryPath)));
  const secondRun = spawnSync(process.execPath, [scriptPath, proposalPath, reviewPath, sourcePath, geometryPath, auditPath], { encoding: "utf8" });
  assert.notEqual(secondRun.status, 0);
  assert.match(secondRun.stderr, /already exists/);
});
