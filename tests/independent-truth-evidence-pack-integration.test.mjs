import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBuildingAccuracyEvidencePackFromManifest } from "../scripts/build-building-accuracy-evidence-pack.mjs";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";

const spec = JSON.parse(await readFile(new URL("./fixtures/demo-building-spec.json", import.meta.url), "utf8"));
const glb = generateProceduralGlb(spec).glb;
const glbSha256 = digest(glb);
const date = "2026-10-27T08:00:00Z";
const qa = analyzeGlbQuality(glb);
const dims = qa.bounds.dimensions.map((value) => Number(value));
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function truthReport(buildingId) {
  return {
    schemaVersion: "1.0.0",
    engine: "independent-building-truth-evaluator-v1",
    evaluationId: buildingId + "-truth-eval",
    buildingId,
    generatedAt: date,
    status: "benchmark-review-required",
    candidate: { glbSha256 },
    reference: { sourceSha256: "b".repeat(64), independentlyAuthenticated: false },
    metrics: {
      footprint: { areaRelativeErrorPercent: 0, boundaryDistance: { symmetric: { maxM: 0 } } },
      dimensions: { maxRelativeErrorPercent: 0 },
      checkPoints: { residuals: { rmsM: 0 } },
      surfaceDistance: null,
    },
    checks: [],
    warnings: [],
    failures: [],
    geometryExtractionProvenance: {
      candidate: { status: "passed" },
      reference: { status: "passed" },
    },
    policy: {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
  };
}
async function setup(t, expectedHashOverride = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "truth-evidence-pack-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["models", "configs", "renders", "reports"]) {
    await mkdir(path.join(root, directory));
  }
  const buildings = [];
  for (const [buildingId, category] of [
    ["landmark-a", "complex-landmark"],
    ["house-a", "ordinary-low-rise"],
  ]) {
    const modelPath = "models/" + buildingId + ".glb";
    await writeFile(path.join(root, modelPath), glb);
    const configPath = "configs/" + buildingId + ".json";
    await writeFile(path.join(root, configPath), JSON.stringify({
      schemaVersion: "1.0.0",
      buildingId,
      dimensionReference: {
        referenceDimensionsM: { x: dims[0], y: dims[1], z: dims[2] },
        metresPerModelUnit: 1,
        tolerancePercent: 5,
        evidence: {
          basis: "surveyed",
          referenceId: "survey-record-" + buildingId,
          sourceDescription: "Synthetic fixture only; not a real survey.",
        },
      },
    }));
    const renderManifestPath = "renders/" + buildingId + ".json";
    const renderManifest = {
      valid: true,
      status: "render-set-ready-for-human-review",
      errors: [],
      modelSha256: glbSha256,
      views: [],
    };
    const renderManifestBytes = Buffer.from(JSON.stringify(renderManifest, null, 2));
    await writeFile(path.join(root, renderManifestPath), renderManifestBytes);
    const truthPath = "reports/" + buildingId + "-truth.json";
    const truthBytes = Buffer.from(JSON.stringify(truthReport(buildingId), null, 2));
    await writeFile(path.join(root, truthPath), truthBytes);
    buildings.push({
      buildingId,
      category,
      sourceIdentity: {
        verified: true,
        sourceId: "building-record-" + buildingId,
        evidenceDescription: "Fixture identity record only.",
        verifiedBy: "reviewer-a",
        verifiedAt: date,
      },
      candidateGlbPath: modelPath,
      expectedGlbSha256: glbSha256,
      benchmarkConfigPath: configPath,
      requireIndependentTruthEvaluation: true,
      independentTruthReportPath: truthPath,
      expectedIndependentTruthReportSha256: expectedHashOverride ?? digest(truthBytes),
      sourceMedia: [],
      referenceImages: [],
      renderEvidence: {
        manifestPath: renderManifestPath,
        expectedManifestSha256: digest(renderManifestBytes),
        directory: "renders",
      },
    });
  }
  const manifest = { schemaVersion: "1.0.0", packId: "truth-report-integration-01", generatedAt: date, buildings };
  await writeFile(path.join(root, "pack.json"), JSON.stringify(manifest, null, 2));
  return { root };
}

test("loads a byte-pinned independent-truth report and exposes it through the accuracy evidence pack", async (t) => {
  const { root } = await setup(t);
  const report = await buildBuildingAccuracyEvidencePackFromManifest({ manifestPath: "pack.json", rootDir: root, generatedAt: date });
  assert.equal(report.buildings.length, 2);
  assert.equal(report.policy.publicationEligible, false);
  assert.equal(report.policy.mapReady, false);
  for (const building of report.buildings) {
    assert.equal(building.independentTruthReportEvidence.required, true);
    assert.equal(building.independentTruthReportEvidence.expectedSha256Pinned, true);
    assert.equal(building.independentTruthGeometry.reportArtifactPinned, true);
    assert.equal(building.independentTruthGeometry.candidateBound, true);
    assert.ok(building.checks.some((check) =>
      check.id === "independent-truth-geometry-evaluation" && check.status === "passed"));
  }
});

test("rejects an untrusted or stale expected independent-truth report hash", async (t) => {
  const { root } = await setup(t, "f".repeat(64));
  await assert.rejects(
    buildBuildingAccuracyEvidencePackFromManifest({ manifestPath: "pack.json", rootDir: root, generatedAt: date }),
    /independent-truth report hash mismatch/,
  );
});
