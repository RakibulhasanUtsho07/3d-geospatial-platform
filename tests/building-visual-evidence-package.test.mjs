import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildBinaryMaskReviewOverlaySvg,
  buildBuildingVisualEvidencePackage,
  calculateBinarySilhouetteMetrics,
} from "../src/core/building-generation/building-visual-evidence-package.mjs";
import { normalizeArchitecturalObservationBatch } from "../src/core/building-generation/architectural-observation-schema.mjs";

const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (number) => number.toString(16).padStart(64, "0");
const width = 40;
const height = 30;
const timestamp = "2026-10-26T12:00:00Z";

function rectangularMask(x1 = 8, y1 = 7, x2 = 32, y2 = 24) {
  const pixels = new Uint8Array(width * height);
  for (let y = y1; y <= y2; y += 1) for (let x = x1; x <= x2; x += 1) pixels[y * width + x] = 255;
  return pixels;
}
function makeMask(role, sourceSha256, pixels, encodedBytes = Buffer.from("encoded-mask-" + role)) {
  const sha256 = hashBytes(encodedBytes);
  return {
    role, encodedBytes,
    decodedMask: { width, height, pixels },
    result: {
      schemaVersion: "1.0.0",
      sourceId: "capture-front",
      inputSha256: sourceSha256,
      provider: { id: "manual-" + role, kind: "human-reviewed-mask", version: "manual-v1", configurationSha256: hash(2) },
      mask: { sha256, bytes: encodedBytes.length, width, height,
        encoding: "binary-8bit-white-foreground-v1", coordinateConvention: "pixel-origin-top-left",
        backgroundValue: 0, foregroundValue: 255 },
      assessment: { status: "reviewed", confidence: 1, humanReviewed: true,
        reviewerId: "reviewer-a", reviewedAt: timestamp },
    },
  };
}
function validGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0", generator: "test-fixture" } }));
  const padding = (4 - (json.length % 4)) % 4;
  const paddedJson = Buffer.concat([json, Buffer.alloc(padding, 0x20)]);
  const bytes = Buffer.alloc(12 + 8 + paddedJson.length);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(paddedJson.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(bytes, 20);
  return bytes;
}
function fixture({ withReview = true } = {}) {
  const sourceBytes = Buffer.from("synthetic-source-image-fixture-not-a-real-photo");
  const sourceSha256 = hashBytes(sourceBytes);
  const buildingPixels = rectangularMask();
  const buildingMask = makeMask("building", sourceSha256, buildingPixels);
  const vegetationPixels = new Uint8Array(width * height);
  for (let y = 10; y < 19; y += 1) for (let x = 5; x < 10; x += 1) vegetationPixels[y * width + x] = 255;
  const vegetationMask = makeMask("vegetation", sourceSha256, vegetationPixels);
  const edgePixels = new Uint8Array(width * height);
  for (const y of [10, 14, 18, 22]) for (let x = 8; x <= 32; x += 1) edgePixels[y * width + x] = 255;
  const edgeBytes = Buffer.from("synthetic-edge-map");
  const calibrationEvidenceBytes = Buffer.from("synthetic-calibration-evidence");
  const frameAlignmentEvidenceBytes = Buffer.from("synthetic-frame-alignment-evidence");
  const camera = {
    schemaVersion: "1.0.0",
    id: "camera-front-01",
    calibrationStatus: "verified",
    calibrationEvidence: { id: "calibration-report-01", sha256: hashBytes(calibrationEvidenceBytes) },
    frameAlignmentEvidence: { id: "glb-frame-fit-01", sha256: hashBytes(frameAlignmentEvidenceBytes) },
    coordinateFrame: "model-local-blender-v1",
    sourceImage: { sha256: sourceSha256, width, height },
    pose: { position: [0, 0, 0], quaternionWxyz: [1, 0, 0, 0] },
    intrinsics: { fx: 100, fy: 100, cx: 20, cy: 15, distortionModel: "none" },
    controlPoints: [
      { id: "p1", worldPoint: [0, 0, -10], imagePoint: { x: 20, y: 15 } },
      { id: "p2", worldPoint: [1, 0, -10], imagePoint: { x: 30, y: 15 } },
      { id: "p3", worldPoint: [0, 1, -10], imagePoint: { x: 20, y: 5 } },
      { id: "p4", worldPoint: [-1, -1, -10], imagePoint: { x: 10, y: 25 } },
    ],
  };
  const glbBytes = validGlb();
  const renderBytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from("synthetic-render-png-fixture-not-a-real-png"),
  ]);
  const candidatePixels = rectangularMask(9, 7, 33, 24);
  const candidateMaskBytes = Buffer.from("synthetic-candidate-silhouette-mask");
  const candidateMask = {
    sha256: hashBytes(candidateMaskBytes),
    encodedBytes: candidateMaskBytes,
    width, height, pixels: candidatePixels,
    sourceImageSha256: sourceSha256,
    sourceCameraRenderSha256: hashBytes(renderBytes),
    extractionVersion: "synthetic-silhouette-extractor-v1",
  };
  const truthMaskBytes = Buffer.from("synthetic-reviewed-reference-mask");
  const referenceSilhouette = {
    sha256: hashBytes(truthMaskBytes),
    encodedBytes: truthMaskBytes,
    width, height, pixels: rectangularMask(),
    sourceImageSha256: sourceSha256,
    review: { status: "reviewed", independentlyReviewed: true, annotationId: "reference-mask-01",
      reviewerId: "independent-reviewer", reviewedAt: timestamp },
  };
  const reviewedAnnotationsBatch = {
    schemaVersion: "1.0.0", batchId: "annotations-front-01", buildingId: "building-a",
    viewId: "front", createdAt: timestamp,
    source: { id: "source-front", sha256: sourceSha256, width, height },
    mask: { sha256: hashBytes(buildingMask.encodedBytes), width, height },
    observations: withReview ? [
      { id: "reviewed-roofline-01", category: "roofline-segment", sourceId: "source-front",
        sourceSha256, viewId: "front", method: "human-review", status: "reviewed", visibility: "visible",
        confidence: 1, geometry: { type: "LineString", coordinates: [[8, 7], [32, 7]] },
        reviewedBy: "architect-a", reviewedAt: timestamp,
        evidence: { maskSha256: hashBytes(buildingMask.encodedBytes) } },
    ] : [],
  };
  return {
    source: { id: "source-front", sourceId: "capture-front", sha256: sourceSha256,
      width, height, decodedWidth: width, decodedHeight: height, mimeType: "image/png" },
    sourceBytes,
    model: { glbBytes },
    buildingMask,
    occluderMasks: [vegetationMask],
    edgeMap: { sha256: hashBytes(edgeBytes), encodedBytes: edgeBytes, sourceImageSha256: sourceSha256,
      width, height, pixels: edgePixels },
    reviewedAnnotationsBatch,
    buildingId: "building-a",
    viewId: "front",
    generatedAt: timestamp,
    datasetTier: "synthetic",
    camera: { manifestBytes: Buffer.from(JSON.stringify(camera)), calibrationEvidenceBytes, frameAlignmentEvidenceBytes },
    sourceCameraRender: {
      bytes: renderBytes, width, height,
      pixelStatistics: { sampledPixels: width * height, luminanceMean: 0.45,
        luminanceStandardDeviation: 0.2, transparentRatio: 0 },
      silhouetteMask: candidateMask,
    },
    referenceSilhouette,
  };
}

test("generates a source-bound mask review overlay and rejects stale bytes/dimensions", () => {
  const input = fixture();
  const sourceSha256 = hashBytes(input.sourceBytes);
  const maskBytes = input.buildingMask.encodedBytes;
  const maskSha256 = hashBytes(maskBytes);
  const svg = buildBinaryMaskReviewOverlaySvg({
    sourceBytes: input.sourceBytes, sourceMimeType: "image/png", sourceSha256,
    sourceWidth: width, sourceHeight: height,
    maskBytes, maskSha256, maskPixels: input.buildingMask.decodedMask.pixels,
    maskWidth: width, maskHeight: height, role: "building",
  });
  assert.match(svg, /<svg/);
  assert.match(svg, /data:image\/png;base64,/);
  assert.match(svg, /mask-spans/);
  assert.throws(() => buildBinaryMaskReviewOverlaySvg({
    sourceBytes: input.sourceBytes, sourceMimeType: "image/png", sourceSha256: hash(90),
    sourceWidth: width, sourceHeight: height, maskBytes, maskSha256,
    maskPixels: input.buildingMask.decodedMask.pixels, maskWidth: width, maskHeight: height,
  }), /Source image bytes do not match/);
  assert.throws(() => buildBinaryMaskReviewOverlaySvg({
    sourceBytes: input.sourceBytes, sourceMimeType: "image/png", sourceSha256,
    sourceWidth: width, sourceHeight: height, maskBytes, maskSha256,
    maskPixels: input.buildingMask.decodedMask.pixels, maskWidth: width - 1, maskHeight: height,
  }), /exactly match/);
});

test("computes separate IoU and contour metrics only for reviewed, source/render-bound masks", () => {
  const input = fixture();
  const renderSha256 = hashBytes(input.sourceCameraRender.bytes);
  const candidate = input.sourceCameraRender.silhouetteMask;
  const report = calculateBinarySilhouetteMetrics({
    sourceImageSha256: input.source.sha256,
    sourceImageSize: { width, height },
    referenceMask: input.referenceSilhouette,
    candidateMask: candidate,
  });
  assert.equal(report.status, "evaluated");
  assert.ok(report.metrics.intersectionOverUnion > 0.9);
  assert.ok(report.metrics.symmetricMeanContourDistancePx > 0);
  assert.equal(candidate.sourceCameraRenderSha256, renderSha256);

  const unreviewed = calculateBinarySilhouetteMetrics({
    sourceImageSha256: input.source.sha256, sourceImageSize: { width, height },
    referenceMask: { ...input.referenceSilhouette, review: { status: "proposed" } }, candidateMask: candidate,
  });
  assert.equal(unreviewed.status, "incomplete");
  assert.equal(unreviewed.metrics, null);

  const wrongRender = calculateBinarySilhouetteMetrics({
    sourceImageSha256: input.source.sha256, sourceImageSize: { width, height },
    referenceMask: input.referenceSilhouette,
    candidateMask: { ...candidate, sourceCameraRenderSha256: hash(99) },
  });
  assert.equal(wrongRender.status, "evaluated");
  assert.equal(wrongRender.candidateMaskSha256, candidate.sha256);
});

test("integrates mask, feature, camera, render and silhouette evidence without promoting synthetic fixtures", () => {
  const input = fixture();
  const result = buildBuildingVisualEvidencePackage(input);
  assert.equal(result.status, "incomplete");
  assert.equal(result.manifest.engine, "building-visual-evidence-package-v1");
  assert.equal(result.stages.source.status, "verified-bytes-and-dimensions");
  assert.equal(result.stages.model.status, "container-header-valid");
  assert.equal(result.stages.masks.status, "reviewed-building-mask-ready");
  assert.ok(result.stages.masks.overlays.building);
  assert.ok(result.stages.masks.overlays.vegetation);
  assert.equal(result.stages.features.status, "reviewed-reference-metrics-available");
  assert.equal(result.stages.sourceCamera.status, "same-camera-comparable");
  assert.equal(result.stages.sourceCamera.render.sameCameraComparable, true);
  assert.equal(result.stages.silhouetteMetrics.status, "evaluated");
  assert.equal(result.stages.realWorldValidation.status, "incomplete");
  assert.equal(result.manifest.policy.groundTruth, false);
  assert.equal(result.manifest.policy.acceptanceEligible, false);
  assert.equal(result.manifest.policy.publicationEligible, false);
  assert.equal(result.mapReady, false);
  assert.equal(result.publicationEligible, false);
  assert.ok(result.warnings.some((item) => item.code === "source-image-rights-evidence-not-verified"));
  assert.ok(result.warnings.some((item) => item.code === "licensed-hash-pinned-real-held-out-benchmark-missing-or-incomplete"));
  assert.match(result.evidenceGraphSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.manifest.evidenceGraphSha256, result.evidenceGraphSha256);
});

test("fails closed for stale source bytes and never scores a mismatched camera as comparable", () => {
  const staleSource = fixture();
  staleSource.source.sha256 = hash(99);
  const stale = buildBuildingVisualEvidencePackage(staleSource);
  assert.equal(stale.status, "failed");
  assert.ok(stale.errors.some((item) => item.code === "source-image-sha256-mismatch"));
  assert.equal(stale.publicationEligible, false);

  const wrongCamera = fixture();
  const manifest = JSON.parse(wrongCamera.camera.manifestBytes.toString("utf8"));
  manifest.sourceImage.sha256 = hash(98);
  wrongCamera.camera.manifestBytes = Buffer.from(JSON.stringify(manifest));
  const notComparable = buildBuildingVisualEvidencePackage(wrongCamera);
  assert.equal(notComparable.status, "not-comparable");
  assert.equal(notComparable.stages.sourceCamera.status, "not-comparable");
  assert.equal(notComparable.stages.sourceCamera.render.sameCameraComparable, false);
  assert.equal(notComparable.mapReady, false);
});

test("normalizes reviewed arch, column, dome and other feature classes in original source pixels", () => {
  const input = fixture();
  const sourceSha256 = input.source.sha256;
  const maskSha256 = hashBytes(input.buildingMask.encodedBytes);
  const categories = ["arch-candidate", "column-candidate", "dome-candidate", "cornice-candidate", "staircase-candidate"];
  const batch = normalizeArchitecturalObservationBatch({
    schemaVersion: "1.0.0", batchId: "heritage-features-01", buildingId: "building-a",
    viewId: "front", createdAt: timestamp,
    source: { id: "source-front", sha256: sourceSha256, width, height },
    mask: { sha256: maskSha256, width, height },
    observations: categories.map((category, index) => ({
      id: "heritage-feature-" + index, category, sourceId: "source-front", sourceSha256,
      viewId: "front", method: "human-review", status: "proposed", visibility: "visible",
      confidence: 0.8, geometry: { type: "BoundingBox", coordinates: [8 + index, 8, 3, 3] },
      evidence: { maskSha256 },
    })),
  });
  assert.deepEqual(batch.observations.map((item) => item.category), categories);
  assert.equal(batch.policy.publicationEligible, false);
});
