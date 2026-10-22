import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";

import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import {
  createFloorPlanRasterLineProposal,
  loadFloorPlanRasterLineProposal,
} from "../src/core/building-generation/floor-plan-raster-line-job.mjs";

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeImage(width = 640, height = 480) {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
    '<rect width="100%" height="100%" fill="#ffffff"/>' +
    '<g fill="none" stroke="#111111" stroke-width="4">' +
    '<path d="M 80 80 H 560 V 400 H 80 Z"/><path d="M 320 80 V 400"/>' +
    '</g></svg>',
    "utf8",
  );
  return sharp(svg).png().toBuffer();
}

async function makeWorkspace(t, { mime = "image/png", bytes } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "floor-plan-line-job-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "uploads"), { recursive: true });
  const sourceBytes = bytes ?? (mime === "application/pdf" ? Buffer.from("%PDF-1.7\nfixture", "utf8") : await makeImage());
  const sourcePath = path.join(root, "uploads", mime === "application/pdf" ? "plan.pdf" : "plan.png");
  await writeFile(sourcePath, sourceBytes);
  const source = await ingestMediaFile({
    workspaceRoot: root,
    sourcePath: path.relative(root, sourcePath),
    buildingId: "dhaka-demo",
    sourceId: "floor-plan-source",
    kind: "floor-plan",
    licence: "unknown",
    usageStatus: "unreviewed",
  });
  assert.equal(source.record.mimeType, mime);
  return { root, source, sourceBytes };
}

test("creates a private source-bound line proposal and verifies it on retrieval", async (t) => {
  const { root, source, sourceBytes } = await makeWorkspace(t);
  const result = await createFloorPlanRasterLineProposal({
    workspaceRoot: root,
    buildingId: "dhaka-demo",
    sourceId: source.record.id,
    options: { minLineLengthPx: 32 },
    now: "2026-10-22T15:00:00.000Z",
  });
  assert.equal(result.status, "review-required-not-scaled");
  assert.equal(result.report.proposalId, result.proposalId);
  assert.equal(result.report.buildingId, "dhaka-demo");
  assert.equal(result.report.sourceId, "floor-plan-source");
  assert.equal(result.report.analysis.source.sha256, source.record.sha256);
  assert.equal(result.report.sourceContext.rightsApproved, false);
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
  assert.ok(result.candidateCount > 0);

  const directory = path.join(root, ".building-engine", "floor-plan-line-proposals", "dhaka-demo", result.proposalId);
  const [manifest, report, loaded, reportStat] = await Promise.all([
    readFile(path.join(directory, "manifest.json"), "utf8").then(JSON.parse),
    readFile(path.join(directory, "report.json"), "utf8").then(JSON.parse),
    loadFloorPlanRasterLineProposal({ workspaceRoot: root, buildingId: "dhaka-demo", proposalId: result.proposalId }),
    stat(path.join(directory, "report.json")),
  ]);
  assert.equal(manifest.sourceSha256, hash(sourceBytes));
  assert.equal(manifest.reportSha256, result.reportSha256);
  assert.equal(report.proposalId, result.proposalId);
  assert.equal(loaded.reportSha256, result.reportSha256);
  assert.equal(loaded.candidateCount, result.candidateCount);
  assert.equal(loaded.mapReady, false);
  assert.equal(reportStat.mode & 0o777, 0o600);
});

test("rejects PDF sources rather than silently treating them as raster pixels", async (t) => {
  const { root, source } = await makeWorkspace(t, { mime: "application/pdf" });
  await assert.rejects(
    createFloorPlanRasterLineProposal({
      workspaceRoot: root,
      buildingId: "dhaka-demo",
      sourceId: source.record.id,
    }),
    (error) => error.code === "UNSUPPORTED_RASTER_SOURCE",
  );
});

test("rejects a tampered private report or changed original source", async (t) => {
  const { root, source, sourceBytes } = await makeWorkspace(t);
  const result = await createFloorPlanRasterLineProposal({
    workspaceRoot: root,
    buildingId: "dhaka-demo",
    sourceId: source.record.id,
  });
  const directory = path.join(root, ".building-engine", "floor-plan-line-proposals", "dhaka-demo", result.proposalId);
  await writeFile(path.join(directory, "report.json"), JSON.stringify({ tampered: true }));
  await assert.rejects(
    loadFloorPlanRasterLineProposal({ workspaceRoot: root, buildingId: "dhaka-demo", proposalId: result.proposalId }),
    /failed integrity checks/,
  );

  // Make a fresh workspace so the report check passes and the source-integrity gate is reached.
  const second = await makeWorkspace(t);
  const secondResult = await createFloorPlanRasterLineProposal({
    workspaceRoot: second.root,
    buildingId: "dhaka-demo",
    sourceId: second.source.record.id,
  });
  await writeFile(second.source.absoluteAssetPath, Buffer.concat([sourceBytes, Buffer.from("changed")]));
  await assert.rejects(
    loadFloorPlanRasterLineProposal({
      workspaceRoot: second.root,
      buildingId: "dhaka-demo",
      proposalId: secondResult.proposalId,
    }),
    /SHA-256 does not match its ingestion record/,
  );
});
