#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_PATH = path.join(ROOT, "public", "models", "ahsan-manzil-lod3.glb");
const PARAMETERS_PATH = path.join(ROOT, "data", "heritage", "ahsan-manzil.parameters.json");
const SOURCES_PATH = path.join(ROOT, "data", "heritage", "ahsan-manzil-reference-sources.json");
const VISUAL_REVIEW_PATH = path.join(ROOT, "data", "heritage", "ahsan-manzil-visual-review-p1-3-baseline.json");
const OUT_ROOT = path.resolve(process.env.AHSAN_MANZIL_REVIEW_OUTPUT || path.join(ROOT, "artifacts", "ahsan-manzil-review"));
const PROFILE = "ahsan-manzil-y-up-cycles-cpu-v1";
const BLENDER_BIN = (process.env.BLENDER_BIN || "blender").trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

async function runNode(scriptPath, args, label) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(label + " failed to start: " + result.error.message);
  if (result.status !== 0) {
    throw new Error(label + " failed (exit " + result.status + ").\n" +
      ((result.stdout || "") + "\n" + (result.stderr || "")).trim().slice(-12000));
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

async function fetchPinnedReference(reference, targetPath) {
  const sourceUrl = new URL(reference.url);
  if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "upload.wikimedia.org") {
    throw new TypeError("Reference download must use the pinned Wikimedia upload host: " + reference.id);
  }
  const response = await fetch(sourceUrl, {
    headers: { "User-Agent": "3d-geospatial-platform/1.0 (heritage model review evidence)" },
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error("Reference download failed (" + response.status + "): " + reference.id);
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("image/jpeg")) throw new TypeError("Pinned reference is not served as JPEG: " + reference.id);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 10000 || bytes.length > 25 * 1024 * 1024) {
    throw new RangeError("Reference size outside the allowed range: " + reference.id);
  }
  const actualSha1 = sha1(bytes);
  if (actualSha1 !== reference.expectedSha1) {
    throw new Error("Pinned source SHA-1 mismatch for " + reference.id + ": " + actualSha1);
  }
  if (reference.expectedBytes && bytes.length !== reference.expectedBytes) {
    throw new Error("Pinned source byte length mismatch for " + reference.id + ": " + bytes.length);
  }
  const dimensions = readImageDimensions(bytes);
  if (!dimensions || dimensions.width !== reference.expectedWidth || dimensions.height !== reference.expectedHeight) {
    throw new Error("Pinned source image dimension mismatch for " + reference.id);
  }
  await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
  return { sha1: actualSha1, sha256: sha256(bytes), bytes: bytes.length, ...dimensions };
}

async function ensureAbsent(targetPath) {
  try {
    await access(targetPath);
    throw new Error("Refusing to overwrite prior Ahsan Manzil review evidence: " + targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function main() {
  assert.ok(BLENDER_BIN, "BLENDER_BIN must not be empty");
  const parameters = JSON.parse(await readFile(PARAMETERS_PATH, "utf8"));
  const sourceManifest = JSON.parse(await readFile(SOURCES_PATH, "utf8"));
  const visualReview = JSON.parse(await readFile(VISUAL_REVIEW_PATH, "utf8"));
  assert.equal(parameters.id, sourceManifest.buildingId);
  assert.equal(visualReview.schemaVersion, "1.0.0");
  assert.equal(visualReview.reviewStage, "P1.3-baseline");
  assert.equal(visualReview.buildingId, sourceManifest.buildingId);
  assert.equal(visualReview.overallStatus, "needs-model-or-reference-correction");
  assert.match(visualReview.provenance.modelSha256, /^[a-f0-9]{64}$/);
  assert.match(visualReview.provenance.renderManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(visualReview.publicationEligible, false);
  assert.equal(visualReview.humanAcceptance.status, "pending");
  assert.match(visualReview.reviewer, /AI-assisted visual triage/);
  assert.match(visualReview.reviewedAt, /^2026-10-23T/);
  assert.equal(visualReview.comparisons.length, 2);
  for (const assessment of visualReview.comparisons) {
    const reference = sourceManifest.references.find((item) => item.id === assessment.referenceImageId);
    assert.ok(reference, "visual review references a pinned source image");
    assert.equal(assessment.viewId, reference.mappedRenderViewId);
    assert.equal(assessment.comparisonBasis, "pose-estimated");
    assert.equal(assessment.outcome, "mismatch");
    assert.ok(assessment.notes.trim());
    assert.ok(assessment.correctionRequest.trim());
  }
  assert.equal(parameters.units, "meters");
  assert.equal(parameters.georeference.axes.value, "X east-west; Y up; +Z south / river-front");
  assert.equal(parameters.modelAssets.defaultRuntimeAsset, "/models/ahsan-manzil-lod3.glb");
  assert.equal(sourceManifest.modelCoordinateConvention, "Y-up; +X east; +Z south / riverfront");
  assert.equal(sourceManifest.references.length, 2);
  for (const reference of sourceManifest.references) {
    assert.equal(reference.license, "CC BY-SA 4.0");
    assert.match(reference.expectedSha1, /^[a-f0-9]{40}$/);
    assert.ok(reference.sourcePageUrl.startsWith("https://commons.wikimedia.org/wiki/File:"));
    assert.ok(reference.attribution.includes(reference.author));
  }

  const modelBytes = await readFile(MODEL_PATH);
  assert.notEqual(sha256(modelBytes), visualReview.provenance.modelSha256,
    "P1.4 must render a new candidate instead of reusing the P1.3 baseline model");
  assert.equal(modelBytes.readUInt32LE(0), 0x46546c67, "LOD3 must be a GLB");
  assert.equal(modelBytes.readUInt32LE(4), 2, "LOD3 must be GLB 2.0");
  assert.equal(modelBytes.readUInt32LE(8), modelBytes.length, "LOD3 declared GLB size must match");
  const jsonLength = modelBytes.readUInt32LE(12);
  assert.equal(modelBytes.readUInt32LE(16), 0x4e4f534a);
  const gltf = JSON.parse(modelBytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
  const nodeNames = new Set((gltf.nodes || []).map((node) => node.name));
  for (const nodeName of parameters.requiredNodeNames) assert.ok(nodeNames.has(nodeName), "LOD3 missing semantic node " + nodeName);
  assert.equal(gltf.asset?.extras?.units, "meters");
  assert.equal(gltf.asset?.extras?.localAxes, "X east-west, Y up, +Z south");

  await ensureAbsent(OUT_ROOT);
  const modelDir = path.join(OUT_ROOT, "model");
  const renderDir = path.join(OUT_ROOT, "renders");
  const referencesDir = path.join(OUT_ROOT, "references");
  const reviewDir = path.join(OUT_ROOT, "review");
  const parametersDir = path.join(OUT_ROOT, "parameters");
  for (const dir of [modelDir, referencesDir, reviewDir, parametersDir]) await mkdir(dir, { recursive: true });
  await copyFile(MODEL_PATH, path.join(modelDir, "ahsan-manzil-lod3.glb"));
  await copyFile(PARAMETERS_PATH, path.join(parametersDir, "ahsan-manzil.parameters.json"));
  await copyFile(SOURCES_PATH, path.join(OUT_ROOT, "reference-sources.json"));
  await copyFile(VISUAL_REVIEW_PATH, path.join(OUT_ROOT, "baseline-visual-review.json"));

  const downloaded = {};
  for (const reference of sourceManifest.references) {
    const actual = await fetchPinnedReference(reference, path.join(referencesDir, reference.filename));
    downloaded[reference.id] = actual;
  }

  const renderResult = await runNode(
    path.join(ROOT, "scripts", "render-building-review-views.mjs"),
    [
      path.join(modelDir, "ahsan-manzil-lod3.glb"),
      renderDir,
      "--resolution=512",
      "--blender=" + BLENDER_BIN,
      "--render-profile=" + PROFILE,
    ],
    "Ahsan Manzil Y-up 13-view render",
  );
  const renderManifestPath = path.join(renderDir, "render-review-manifest.json");
  const renderManifestBytes = await readFile(renderManifestPath);
  const renderManifest = JSON.parse(renderManifestBytes.toString("utf8"));
  assert.equal(renderManifest.valid, true, "coordinate-aware render manifest must validate");
  assert.equal(renderManifest.renderProfile, PROFILE);
  assert.equal(renderManifest.publicationEligible, false);
  assert.equal(renderManifest.counts.generatedViews, REQUIRED_REVIEW_VIEWS.length);
  assert.ok(renderManifest.views.every((view) => view.width === 512 && view.height === 512), "heritage review views must use readable 512x512 detail");
  assert.match(renderManifest.modelSha256, /^[a-f0-9]{64}$/);
  assert.match(renderManifest.renderConfigSha256, /^[a-f0-9]{64}$/);
  assert.equal(renderManifest.renderSettings.cameraCoordinateConvention, "blender-z-up;source-glTF-y-up-imported;source+Z-south=>world-Y-negative;front-camera-from-world-Y-negative");
  assert.deepEqual(renderManifest.renderSettings.excludedRenderObjects, [
    "Site_Approach", "Site_Context_Blocks", "Site_Family_Mosque",
    "Site_Pond", "Site_River", "Site_Stable", "Site_Trees",
  ]);
  assert.equal(renderManifest.renderSettings.frontViewFraming,
    "rangmahal-semantic-bounds-for-front-and-turntable-315;whole-palace-for-other-views");
  const renderedFront = renderManifest.views.find((view) => view.id === "front");
  const renderedSoutheast = renderManifest.views.find((view) => view.id === "turntable-315");
  const renderedTop = renderManifest.views.find((view) => view.id === "top");
  assert.ok(Math.abs(renderedFront.cameraPose.targetWorld[0] - 34.8) < 1,
    "front comparison must centre on the provisional Rangmahal/dome axis");
  assert.ok(renderedFront.cameraPose.orthographicScale < 85,
    "front comparison must frame the public wing rather than the full footprint");
  assert.ok(Math.abs(renderedSoutheast.cameraPose.targetWorld[0] - 34.8) < 1,
    "southeast reference comparison must focus the dome-bearing Rangmahal");
  assert.ok(renderedSoutheast.cameraPose.orthographicScale < 100 &&
    renderedSoutheast.cameraPose.orthographicScale > renderedFront.cameraPose.orthographicScale,
    "southeast view must retain extra margin for diagonal projection");
  assert.ok(renderedTop.cameraPose.orthographicScale > 150,
    "whole-palace top-down view must retain the full footprint");
  // Camera framing must use the named palace nodes, not the 440 m site-context bounds.
  assert.ok(renderManifest.sceneBounds.dimensions[0] < 150, "palace length bounds must exclude large site-context objects");
  assert.ok(renderManifest.sceneBounds.dimensions[1] < 70, "palace depth bounds must exclude site/context extents");
  assert.ok(renderManifest.sceneBounds.dimensions[2] < 40, "palace height bounds must exclude site/context height");
  assert.ok(
    renderManifest.views.every((view) => view.pixelStatistics.luminanceStandardDeviation > 0.004),
    "all 13 camera renders must contain image detail; a flat background-only image is a failure",
  );
  const palaceCenterZ = (renderManifest.sceneBounds.min[2] + renderManifest.sceneBounds.max[2]) / 2;
  assert.ok(
    renderManifest.renderSettings.lights.every((light) => light.positionWorld[2] > palaceCenterZ),
    "heritage key/fill/rim lights must sit above the palace in Blender Z-up world coordinates",
  );
  const directions = Object.fromEntries(renderManifest.views.map((view) => [view.id, view.cameraPose.viewDirectionWorld]));
  const assertDirection = (id, expected) => {
    assert.ok(
      Math.hypot(...directions[id].map((value, axis) => value - expected[axis])) <= 1e-3,
      id + " camera must use the expected Y-up viewing direction; actual=" + JSON.stringify(directions[id]),
    );
  };
  assertDirection("front", [0, 1, 0]);
  assertDirection("back", [0, -1, 0]);
  assertDirection("top", [0, 0, -1]);
  const diagonal = [
    -Math.cos(315 * Math.PI / 180) * Math.cos(22 * Math.PI / 180),
    -Math.sin(315 * Math.PI / 180) * Math.cos(22 * Math.PI / 180),
    -Math.sin(22 * Math.PI / 180),
  ];
  assertDirection("turntable-315", diagonal);
  assert.deepEqual(renderManifest.views.map((view) => view.id), [...REQUIRED_REVIEW_VIEWS]);

  const reviewInputPath = path.join(reviewDir, "ahsan-manzil.review-input.json");
  const reviewReportPath = path.join(reviewDir, "render-reference-review-report.json");
  const reviewInput = {
    schemaVersion: "1.0.0",
    buildingId: sourceManifest.buildingId,
    referenceImages: sourceManifest.references.map((reference) => ({
      id: reference.id,
      path: "../references/" + reference.filename,
      sha256: downloaded[reference.id].sha256,
      width: downloaded[reference.id].width,
      height: downloaded[reference.id].height,
      sourceDescription: reference.title,
      sourceUrl: reference.sourcePageUrl,
      attribution: reference.attribution + " License: " + reference.licenseUrl,
      rightsStatus: "verified",
      facadeLabel: reference.facadeLabel,
      captureHeadingBasis: reference.captureHeadingBasis,
    })),
    comparisons: sourceManifest.references.map((reference) => ({
      viewId: reference.mappedRenderViewId,
      referenceImageId: reference.id,
      comparisonBasis: reference.comparisonBasis,
      outcome: "pending",
    })),
  };
  await writeFile(reviewInputPath, JSON.stringify(reviewInput, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await runNode(
    path.join(ROOT, "scripts", "review-render-references.mjs"),
    [renderDir, reviewInputPath, reviewReportPath],
    "Ahsan Manzil traceable reference review",
  );
  const reviewReport = JSON.parse(await readFile(reviewReportPath, "utf8"));
  assert.equal(reviewReport.valid, true, "evidence-linked reference-review report must validate");
  assert.equal(reviewReport.buildingId, sourceManifest.buildingId);
  assert.equal(reviewReport.publicationEligible, false);
  assert.equal(reviewReport.provenance.sourceModelSha256, renderManifest.modelSha256);
  assert.equal(reviewReport.provenance.renderManifestSha256, sha256(renderManifestBytes));
  assert.equal(reviewReport.counts.referenceImageCount, 2);
  assert.equal(reviewReport.counts.comparisonCount, 2);
  assert.equal(reviewReport.reviewStatus, "pending-human-review");
  assert.equal(reviewReport.counts.mismatch, 0);
  assert.equal(reviewReport.counts.pending, 2, "new images require a fresh side-by-side review");
  assert.equal(reviewReport.counts.viewsWithoutComparisons, REQUIRED_REVIEW_VIEWS.length - 2);
  assert.ok(reviewReport.comparisons.every((comparison) => comparison.outcome === "pending"));
  assert.equal(reviewReport.publicationEligible, false);

  const attributions = [
    "# Ahsan Manzil reference-image attribution",
    "",
    "The reference images in this package are unmodified copies used for a qualitative visual review.",
    "",
    ...sourceManifest.references.flatMap((reference) => [
      "## " + reference.title,
      "",
      "- Author: " + reference.author,
      "- Source: " + reference.sourcePageUrl,
      "- File URL: " + reference.url,
      "- License: " + reference.license + " (" + reference.licenseUrl + ")",
      "- Capture date: " + reference.capturedOn,
      "- SHA-1 pinned to Wikimedia Commons metadata: " + downloaded[reference.id].sha1,
      "- SHA-256 in review evidence: " + downloaded[reference.id].sha256,
      "- Facade mapping: " + reference.facadeLabel + " -> render view " + reference.mappedRenderViewId,
      "- Mapping confidence: estimated facade/view correspondence; camera heading/lens calibration is not provided by the source metadata.",
      "",
    ]),
    "## Review status",
    "",
    "P1.3 baseline outcome: NEEDS MODEL OR REFERENCE CORRECTION. Those observations belong to the previous model hash recorded in baseline-visual-review.json; do not apply them automatically to this P1.4 candidate.",
    "",
    "Current P1.4 candidate: PENDING HUMAN REVIEW. The new hash-linked report starts with two pending comparison outcomes until the revised images are inspected. Camera poses remain estimated and publication eligibility remains false.",
    "",
    "## Recorded findings",
    "",
    ...visualReview.comparisons.flatMap((assessment) => {
      const reference = sourceManifest.references.find((item) => item.id === assessment.referenceImageId);
      return [
        "### " + reference.title + " -> " + assessment.viewId + " (" + assessment.outcome.toUpperCase() + ")",
        "",
        assessment.notes,
        "",
        "**Correction request:** " + assessment.correctionRequest,
        "",
      ];
    }),
    "## Human acceptance gate",
    "",
    visualReview.humanAcceptance.note,
    "",
  ].join("\n");
  await writeFile(path.join(OUT_ROOT, "ATTRIBUTION-AND-REVIEW-STATUS.md"), attributions, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(OUT_ROOT, "VISUAL-REVIEW-FINDINGS.md"), [
    "# Ahsan Manzil visual review findings",
    "",
    "- Candidate: P1.4 geometry/render correction",
    "- Current report status: " + reviewReport.reviewStatus,
    "- Current pending comparisons: " + reviewReport.counts.pending,
    "- Independent human sign-off: pending",
    "- Publication eligible: no",
    "- Current model SHA-256: " + renderManifest.modelSha256,
    "- Current render-manifest SHA-256: " + sha256(renderManifestBytes),
    "",
    "## P1.3 baseline findings",
    "",
    ...visualReview.comparisons.flatMap((assessment) => [
      "### " + assessment.referenceImageId + " -> " + assessment.viewId + ": " + assessment.outcome.toUpperCase(),
      "",
      "**Previous observation:** " + assessment.notes,
      "",
      "**Previous correction request:** " + assessment.correctionRequest,
      "",
    ]),
    "## P1.4 current candidate",
    "",
    "The front and southeast-oblique views have been reframed to the dome-bearing Rangmahal. The roof finish is separated from the upper-floor slab to remove overlapping top surfaces. Current comparison outcomes intentionally remain pending until this candidate's newly hashed images are inspected.",
    "",
    "## Unassessed views",
    "",
    ...REQUIRED_REVIEW_VIEWS.filter((id) => !reviewInput.comparisons.some((item) => item.viewId === id)).map((id) => "- " + id),
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  await writeFile(path.join(OUT_ROOT, "downloaded-reference-hashes.json"), JSON.stringify(downloaded, null, 2) + "\n", { flag: "wx", mode: 0o600 });

  console.log(JSON.stringify({
    status: "ahsan-manzil-p1-4-candidate-rendered-pending-human-review",
    renderProfile: PROFILE,
    modelSha256: renderManifest.modelSha256,
    renderConfigSha256: renderManifest.renderConfigSha256,
    renderManifestSha256: sha256(renderManifestBytes),
    viewsRendered: renderManifest.counts.generatedViews,
    referencesPinnedAndHashed: sourceManifest.references.length,
    referenceReviewReportSha256: sha256(await readFile(reviewReportPath)),
    comparisonStatus: reviewReport.reviewStatus,
    baselineMismatches: visualReview.comparisons.length,
    currentCandidateMismatches: reviewReport.counts.mismatch,
    pendingHumanComparisons: reviewReport.counts.pending,
    independentHumanSignoff: "pending",
    unmatchedRenderViews: reviewReport.counts.viewsWithoutComparisons,
    publicationEligible: false,
    output: OUT_ROOT,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
