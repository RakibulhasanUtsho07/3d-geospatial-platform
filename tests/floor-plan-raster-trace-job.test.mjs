import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";

import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import {
  loadFloorPlanRasterTrace,
  traceFloorPlanImageSource,
} from "../src/core/building-generation/floor-plan-raster-trace-job.mjs";

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">
  <rect width="320" height="240" fill="#f5f5f5"/>
  <g fill="none" stroke="#141414" stroke-width="5" stroke-linecap="square">
    <path d="M30 30H290 M30 120H290 M30 210H290"/>
    <path d="M30 30V210 M160 30V210 M290 30V210"/>
  </g>
</svg>`, "utf8");
const pngBytes = await sharp(svg).png().toBuffer();
const pdfBytes = Buffer.from("%PDF-1.7\nsource fixture\n", "utf8");

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "floor-plan-raster-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  return root;
}

async function ingest(root, bytes, { name, sourceId }) {
  await writeFile(path.join(root, "uploads", name), bytes);
  return ingestMediaFile({
    workspaceRoot: root,
    sourcePath: "uploads/" + name,
    buildingId: "dhaka-demo",
    sourceId,
    kind: "floor-plan",
    licence: "CC BY 4.0",
    usageStatus: "unreviewed",
    title: name,
  });
}

test("creates a private trace artifact from a verified uploaded raster source", async (t) => {
  const root = await workspace(t);
  const source = await ingest(root, pngBytes, { name: "plan.png", sourceId: "plan-scan" });
  const result = await traceFloorPlanImageSource({
    workspaceRoot: root,
    buildingId: "dhaka-demo",
    sourceId: "plan-scan",
    options: { maxEdge: 512, threshold: 180, minLineLengthPx: 50, minRoomSidePx: 40 },
  });
  assert.equal(result.sourceSha256, source.record.sha256);
  assert.equal(result.status, "needs-human-trace-review");
  assert.equal(result.summary.horizontalWallCandidates, 3);
  assert.equal(result.summary.verticalWallCandidates, 3);
  assert.equal(result.summary.roomCandidates, 4);
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);

  const saved = await loadFloorPlanRasterTrace({
    workspaceRoot: root,
    buildingId: "dhaka-demo",
    traceId: result.traceId,
  });
  assert.equal(saved.sourceEvidence.sha256, source.record.sha256);
  assert.equal(saved.sourceEvidence.usageStatus, "unreviewed");
  assert.equal(saved.raster.orientedSourceWidth, 320);
  assert.equal(saved.raster.analysisWidth, 320);
  assert.equal(saved.scale.status, "unknown-until-calibrated");
  assert.equal(saved.candidates.rooms.length, 4);
  assert.ok(saved.limitations.some((item) => item.includes("No scale, north, heading")));
  const artifactPath = path.join(root, ...result.artifact.relativePath.split("/"));
  assert.deepEqual(JSON.parse(await readFile(artifactPath, "utf8")).summary, result.summary);
  assert.equal((await readFile(artifactPath)).byteLength, result.artifact.byteSize);
});

test("rejects PDF input explicitly rather than pretending to detect vectors from PDF bytes", async (t) => {
  const root = await workspace(t);
  await ingest(root, pdfBytes, { name: "plan.pdf", sourceId: "pdf-source" });
  await assert.rejects(
    traceFloorPlanImageSource({ workspaceRoot: root, buildingId: "dhaka-demo", sourceId: "pdf-source" }),
    (error) => error.code === "UNSUPPORTED_SOURCE_MEDIA",
  );
});

test("detects trace artifact tampering and source tampering on retrieval", async (t) => {
  const root = await workspace(t);
  const source = await ingest(root, pngBytes, { name: "plan.png", sourceId: "plan-scan" });
  const result = await traceFloorPlanImageSource({
    workspaceRoot: root,
    buildingId: "dhaka-demo",
    sourceId: "plan-scan",
    options: { maxEdge: 512, threshold: 180, minLineLengthPx: 50, minRoomSidePx: 40 },
  });
  const artifactPath = path.join(root, ...result.artifact.relativePath.split("/"));
  const originalTraceBytes = await readFile(artifactPath);
  const trace = JSON.parse(originalTraceBytes.toString("utf8"));
  trace.candidates.rooms = [];
  await writeFile(artifactPath, JSON.stringify(trace));
  await assert.rejects(
    loadFloorPlanRasterTrace({ workspaceRoot: root, buildingId: "dhaka-demo", traceId: result.traceId }),
    (error) => error.code === "TRACE_CHECKSUM_MISMATCH",
  );

  await writeFile(artifactPath, originalTraceBytes);
  const originalSourcePath = path.join(root, ...source.record.relativePath.split("/"));
  await writeFile(originalSourcePath, Buffer.concat([pngBytes, Buffer.from("tampered")]));
  await assert.rejects(
    loadFloorPlanRasterTrace({ workspaceRoot: root, buildingId: "dhaka-demo", traceId: result.traceId }),
    /source asset SHA-256 does not match its ingestion record/,
  );
});

test("rejects an oversized resize option before decoding a source", async (t) => {
  const root = await workspace(t);
  await ingest(root, pngBytes, { name: "plan.png", sourceId: "plan-scan" });
  await assert.rejects(
    traceFloorPlanImageSource({
      workspaceRoot: root,
      buildingId: "dhaka-demo",
      sourceId: "plan-scan",
      options: { maxEdge: 99999 },
    }),
    /maxEdge must be an integer between 256 and 4096/,
  );
});
