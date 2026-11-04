import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getActivePublishedModels } from "../src/core/building-generation/published-model-catalog-reader.mjs";
import { publishEvidenceBackedVerticalSlice } from "../src/core/building-generation/publish-evidence-backed-vertical-slice.mjs";

const REQUIRED_CHECKS = {
  rightsVerified: true,
  sourceIdentityVerified: true,
  architectureReviewed: true,
  metricScaleVerified: true,
  horizontalGeoreferenceVerified: true,
  verticalDatumVerified: true,
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function createGlb() {
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0", generator: "D3M-ENGINE-03 publication contract test" },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
  }), "utf8");
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const paddedJson = Buffer.alloc(jsonLength, 0x20);
  json.copy(paddedJson);
  const binary = Buffer.alloc(4);
  const totalLength = 12 + 8 + paddedJson.length + 8 + binary.length;
  const glb = Buffer.alloc(totalLength);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  glb.writeUInt32LE(paddedJson.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(glb, 20);
  const binaryHeader = 20 + paddedJson.length;
  glb.writeUInt32LE(binary.length, binaryHeader);
  glb.writeUInt32LE(0x004e4942, binaryHeader + 4);
  binary.copy(glb, binaryHeader + 8);
  return glb;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m-03-map-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publicRoot = path.join(root, "application");
  const outputs = path.join(root, "outputs");
  const evidenceDir = path.join(root, "evidence");
  await mkdir(publicRoot, { recursive: true });
  await mkdir(outputs, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });

  const glb = createGlb();
  const candidatePath = path.join(outputs, "textured-candidate.glb");
  await writeFile(candidatePath, glb);
  const candidateSha = sha256(glb);
  const report = {
    schemaVersion: "1.0.0",
    workflow: "D3M-ENGINE-03",
    buildingId: "demo-building",
    jobId: "vertical-slice-001",
    status: "completed-requires-human-review",
    sourceEvidence: {
      sourceSetSha256: "1".repeat(64),
      sources: [{ sourceId: "front", sha256: "2".repeat(64), licence: "CC BY 4.0" }],
    },
    childJobs: {
      geometry: {
        jobId: "vertical-slice-001-geometry",
        status: "technical-checks-passed-requires-human-review",
        output: {
          blockerCount: 0,
          blockers: [],
          texturedModel: {
            path: "outputs/textured-candidate.glb",
            sha256: candidateSha,
            bytes: glb.length,
            texturedTriangleCount: 24,
            untexturedTriangleCount: 0,
          },
        },
      },
    },
    acceptance: {
      sourceEvidenceBound: true,
      candidateGlbAvailable: true,
      texturedGlbAvailable: true,
      geometryWorkflowChecksPassed: true,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
    blockers: [
      "trusted-human-review-not-supplied",
      "independent-building-truth-not-supplied",
    ],
  };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  const reportPath = path.join(root, "vertical-slice-report.json");
  await writeFile(reportPath, reportBytes);
  const evidenceBytes = Buffer.from(JSON.stringify({
    reportSha256: sha256(reportBytes),
    candidateSha256: candidateSha,
    reviewerNotes: "Synthetic test evidence only.",
  }, null, 2));
  await writeFile(path.join(evidenceDir, "review-evidence.json"), evidenceBytes);
  const attestation = {
    schemaVersion: "1.0.0",
    candidateSha256: candidateSha,
    verticalSliceReportSha256: sha256(reportBytes),
    sourceSetSha256: report.sourceEvidence.sourceSetSha256,
    model: {
      id: "demo-building",
      name: "Demo building",
      position: { longitude: 90.406, latitude: 23.709, height: 10.5 },
      headingDegrees: 0,
      pitchDegrees: 0,
      rollDegrees: 0,
      scale: 1,
      upAxis: "Y",
      forwardAxis: "Z",
    },
    review: {
      reviewer: "synthetic-reviewer-fixture",
      reviewedAt: "2026-11-04T00:00:00.000Z",
      evidenceId: "synthetic-d3m03-review-evidence",
      evidencePath: "evidence/review-evidence.json",
      evidenceSha256: sha256(evidenceBytes),
      checks: { ...REQUIRED_CHECKS },
      notes: "Synthetic test attestation. Never use as real review.",
    },
  };
  await writeFile(path.join(root, "publication-attestation.json"), JSON.stringify(attestation, null, 2));
  return { root, publicRoot, reportPath: "vertical-slice-report.json", candidatePath, candidateSha, attestation };
}

test("publishes the exact reviewed geometry GLB to the Cesium catalog and preserves fail-closed parent flags", async (t) => {
  const f = await fixture(t);
  const result = await publishEvidenceBackedVerticalSlice({
    workspaceRoot: f.root,
    reportPath: f.reportPath,
    attestationPath: "publication-attestation.json",
    publicRoot: f.publicRoot,
    publishedAt: "2026-11-04T00:01:00.000Z",
  });

  assert.equal(result.modelId, "demo-building");
  assert.equal(result.sha256, f.candidateSha);
  assert.equal(result.candidateSha256, f.candidateSha);
  assert.equal(result.assetUrl.startsWith("/models/generated/demo-building-"), true);
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
  const active = getActivePublishedModels(JSON.parse(await readFile(result.manifestPath, "utf8")));
  assert.equal(active.length, 1);
  assert.equal(active[0].definition.id, "demo-building");
  assert.equal(active[0].sha256, f.candidateSha);
  assert.equal(active[0].definition.url, result.assetUrl);
  const publishedBytes = await readFile(path.join(f.publicRoot, "public", result.assetUrl.slice(1)));
  assert.equal(sha256(publishedBytes), f.candidateSha);
});

test("rejects a candidate whose exact bytes changed after the parent report was written", async (t) => {
  const f = await fixture(t);
  await writeFile(f.candidatePath, createGlb().subarray(0, createGlb().length - 4));
  await assert.rejects(
    publishEvidenceBackedVerticalSlice({
      workspaceRoot: f.root,
      reportPath: f.reportPath,
      attestationPath: "publication-attestation.json",
      publicRoot: f.publicRoot,
    }),
    /SHA-256 does not match the parent report/,
  );
  await assert.rejects(readFile(path.join(f.publicRoot, "public", "models", "generated", "manifest.json")));
});

test("rejects a blocked geometry candidate even when an attestation file exists", async (t) => {
  const f = await fixture(t);
  const report = JSON.parse(await readFile(path.join(f.root, f.reportPath), "utf8"));
  report.acceptance.geometryWorkflowChecksPassed = false;
  report.childJobs.geometry.output.blockerCount = 1;
  report.childJobs.geometry.output.blockers = ["texture-atlas-bake-blocked"];
  await writeFile(path.join(f.root, f.reportPath), JSON.stringify(report, null, 2));
  await assert.rejects(
    publishEvidenceBackedVerticalSlice({
      workspaceRoot: f.root,
      reportPath: f.reportPath,
      attestationPath: "publication-attestation.json",
      publicRoot: f.publicRoot,
    }),
    /technical and source-binding checks must pass/,
  );
  await assert.rejects(readFile(path.join(f.publicRoot, "public", "models", "generated", "manifest.json")));
});

test("rejects an attestation for a different building before catalog publication", async (t) => {
  const f = await fixture(t);
  f.attestation.model.id = "another-building";
  await writeFile(path.join(f.root, "publication-attestation.json"), JSON.stringify(f.attestation));
  await assert.rejects(
    publishEvidenceBackedVerticalSlice({
      workspaceRoot: f.root,
      reportPath: f.reportPath,
      attestationPath: "publication-attestation.json",
      publicRoot: f.publicRoot,
    }),
    /model.id must exactly match the parent buildingId/,
  );
  await assert.rejects(readFile(path.join(f.publicRoot, "public", "models", "generated", "manifest.json")));
});
test("rejects publication attestation not bound to the exact parent report/source set", async (t) => {
  const f = await fixture(t);
  f.attestation.sourceSetSha256 = "0".repeat(64);
  await writeFile(path.join(f.root, "publication-attestation.json"), JSON.stringify(f.attestation));
  await assert.rejects(
    publishEvidenceBackedVerticalSlice({
      workspaceRoot: f.root,
      reportPath: f.reportPath,
      attestationPath: "publication-attestation.json",
      publicRoot: f.publicRoot,
    }),
    /exact parent report and source-set hashes/,
  );
  await assert.rejects(readFile(path.join(f.publicRoot, "public", "models", "generated", "manifest.json")));
});

