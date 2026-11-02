import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import {
  createFloorPlanModelCandidate,
  loadFloorPlanModelCandidate,
} from "../src/core/building-generation/floor-plan-model-job.mjs";
import { hashFloorPlanRasterProposalReport } from "../src/core/building-generation/floor-plan-raster-vector-calibration.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inputs() {
  const sourceBytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("synthetic CLI source bytes")]);
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
      openings: index === 1 ? [
        { id: "east-door", type: "door", offsetPx: 20, widthPx: 20, heightM: 2.1, sillHeightM: 0 },
        { id: "east-window", type: "window", offsetPx: 70, widthPx: 30, heightM: 1.2, sillHeightM: 0.8 },
      ] : [],
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
  assert.equal(audit.vector.openingCount, 2);
  assert.deepEqual(geometry.walls[1].openings.map((opening) => opening.type), ["door", "window"]);
  assert.deepEqual(audit.releaseFlags, {
    acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false,
  });
  assert.equal((await stat(geometryPath)).mode & 0o777, 0o600);
  assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
  assert.equal(hash(Buffer.from(JSON.stringify(geometry, null, 2) + "\n")), hash(await readFile(geometryPath)));

  // Run the calibrated geometry through the real generator and verify hash parity with the in-memory preflight.
  const candidatePath = path.join(root, "candidate.glb");
  const candidateScriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/generate-floor-plan-model.mjs");
  const candidateRun = spawnSync(process.execPath, [candidateScriptPath, geometryPath, candidatePath, sourcePath], { encoding: "utf8" });
  assert.equal(candidateRun.status, 0, candidateRun.stderr);
  const candidateReport = JSON.parse(await readFile(candidatePath + ".report.json", "utf8"));
  assert.equal(candidateReport.output.sha256, audit.vector.generatedPreviewGlbSha256);
  assert.equal(candidateReport.input.sourceEvidenceVerified, true);
  assert.equal(candidateReport.geometry.openingCount, 2);

  // Ingest the exact same source bytes, then exercise the existing private candidate service.
  const ingested = await ingestMediaFile({
    workspaceRoot: root,
    sourcePath: path.basename(sourcePath),
    buildingId: geometry.buildingId,
    sourceId: geometry.source.sourceId,
    kind: "floor-plan",
    licence: "unknown",
    usageStatus: "unreviewed",
  });
  assert.equal(ingested.record.sha256, geometry.source.sha256);
  const storedCandidate = await createFloorPlanModelCandidate({ workspaceRoot: root, floorPlan: geometry });
  assert.equal(storedCandidate.modelSha256, audit.vector.generatedPreviewGlbSha256);
  assert.equal(storedCandidate.sourceSha256, ingested.record.sha256);
  assert.equal(storedCandidate.report.input.sourceEvidenceVerified, true);
  assert.equal(storedCandidate.report.input.sourceUsageStatus, "unreviewed");
  assert.equal(storedCandidate.mapReady, false);
  assert.equal(storedCandidate.publicationEligible, false);

  const loadedCandidate = await loadFloorPlanModelCandidate({
    workspaceRoot: root,
    buildingId: geometry.buildingId,
    candidateId: storedCandidate.candidateId,
  });
  assert.equal(loadedCandidate.modelSha256, audit.vector.generatedPreviewGlbSha256);
  assert.equal(loadedCandidate.plan.walls[1].openings.length, 2);
  assert.equal(loadedCandidate.report.input.verifiedSourceSha256, ingested.record.sha256);
  const storedCandidateDir = path.join(
    root, ".building-engine", "floor-plan-candidates", geometry.buildingId, storedCandidate.candidateId,
  );
  assert.equal((await stat(path.join(storedCandidateDir, "model.glb"))).mode & 0o777, 0o600);
  assert.equal((await stat(storedCandidateDir)).mode & 0o077, 0);

  const secondRun = spawnSync(process.execPath, [scriptPath, proposalPath, reviewPath, sourcePath, geometryPath, auditPath], { encoding: "utf8" });
  assert.notEqual(secondRun.status, 0);
  assert.match(secondRun.stderr, /already exists/);
});
