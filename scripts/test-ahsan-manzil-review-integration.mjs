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
  assert.equal(parameters.id, sourceManifest.buildingId);
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
      "--resolution=256",
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
  assert.match(renderManifest.modelSha256, /^[a-f0-9]{64}$/);
  assert.match(renderManifest.renderConfigSha256, /^[a-f0-9]{64}$/);
  assert.equal(renderManifest.renderSettings.cameraCoordinateConvention, "y-up;+X=east-west-eastward;+Z=south-riverfront");
  // Camera framing must use the named palace nodes, not the 440 m site-context bounds.
  assert.ok(renderManifest.sceneBounds.dimensions[0] < 150, "palace width bounds must exclude large site-context objects");
  assert.ok(renderManifest.sceneBounds.dimensions[1] < 40, "palace height bounds must exclude site/context height");
  assert.ok(renderManifest.sceneBounds.dimensions[2] < 70, "palace depth bounds must exclude surrounding river/context extents");
  assert.ok(
    renderManifest.views.every((view) => view.pixelStatistics.luminanceStandardDeviation > 0.004),
    "all 13 camera renders must contain image detail; a flat background-only image is a failure",
  );
  const palaceCenterY = (renderManifest.sceneBounds.min[1] + renderManifest.sceneBounds.max[1]) / 2;
  assert.ok(
    renderManifest.renderSettings.lights.every((light) => light.positionWorld[1] > palaceCenterY),
    "Y-up heritage key/fill/rim lights must sit above the palace, not below it",
  );
  const directions = Object.fromEntries(renderManifest.views.map((view) => [view.id, view.cameraPose.viewDirectionWorld]));
  const assertDirection = (id, expected) => {
    assert.ok(
      Math.hypot(...directions[id].map((value, axis) => value - expected[axis])) <= 1e-3,
      id + " camera must use the expected Y-up viewing direction; actual=" + JSON.stringify(directions[id]),
    );
  };
  assertDirection("front", [0, 0, -1]);
  assertDirection("back", [0, 0, 1]);
  assertDirection("top", [0, -1, 0]);
  assertDirection("right", [-1, 0, 0]);
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
  assert.equal(reviewReport.counts.pending, 2, "view pairing is prepared, but human comparison outcomes are intentionally pending");
  assert.equal(reviewReport.counts.viewsWithoutComparisons, REQUIRED_REVIEW_VIEWS.length - 2);
  assert.ok(reviewReport.comparisons.every((comparison) => comparison.outcome === "pending"));

  const attributions = [
    "# Ahsan Manzil reference-image attribution",
    "",
    "The reference images in this package are unmodified copies used to support visual review.",
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
    "The manifest links source/reference/model hashes and maps the front photo to the south-front camera and the east-side photo to the east/right camera. Comparison outcomes remain pending until a reviewer opens the rendered PNGs alongside these source images. No similarity percentage or publication approval is inferred.",
    "",
  ].join("\n");
  await writeFile(path.join(OUT_ROOT, "ATTRIBUTION-AND-REVIEW-STATUS.md"), attributions, { flag: "wx", mode: 0o600 });
  await writeFile(path.join(OUT_ROOT, "downloaded-reference-hashes.json"), JSON.stringify(downloaded, null, 2) + "\n", { flag: "wx", mode: 0o600 });

  console.log(JSON.stringify({
    status: "ahsan-manzil-coordinate-aware-review-package-ready",
    renderProfile: PROFILE,
    modelSha256: renderManifest.modelSha256,
    renderConfigSha256: renderManifest.renderConfigSha256,
    renderManifestSha256: sha256(renderManifestBytes),
    viewsRendered: renderManifest.counts.generatedViews,
    referencesPinnedAndHashed: sourceManifest.references.length,
    referenceReviewReportSha256: sha256(await readFile(reviewReportPath)),
    comparisonStatus: reviewReport.reviewStatus,
    pendingHumanComparisons: reviewReport.counts.pending,
    unmatchedRenderViews: reviewReport.counts.viewsWithoutComparisons,
    publicationEligible: false,
    output: OUT_ROOT,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
