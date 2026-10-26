import assert from "node:assert/strict";
import test from "node:test";
import {
  SEGMENTATION_PALETTE_ID, buildSegmentationBenchmarkReport, calculateSegmentationMetrics,
  decodeSegmentationPalette, validateSegmentationBenchmarkManifest,
} from "../src/core/building-generation/building-segmentation-benchmark.mjs";

const hash = (n) => n.toString(16).padStart(64, "0");
const reviewedAt = "2026-10-26T10:00:00Z";
function asset(path, seed, width = 4, height = 3) {
  return { path, sha256: hash(seed), bytes: 100 + seed, width, height };
}
function sample(sampleId, split, group = sampleId) {
  const source = { ...asset("evidence/" + sampleId + ".png", 1), sourceId: "source-" + sampleId,
    rights: { status: "verified", evidenceId: "rights-" + sampleId, reviewedBy: "reviewer-a", reviewedAt } };
  return { sampleId, captureGroupId: group, split, source,
    groundTruthMask: { ...asset("labels/" + sampleId + ".png", 2), encoding: SEGMENTATION_PALETTE_ID,
      review: { status: "reviewed", annotationId: "annotation-" + sampleId, reviewerId: "reviewer-a", reviewedAt } },
    predictions: [{ providerId: "local-seg-v1", modelVersion: "1.0.0", configSha256: hash(3),
      inputSha256: source.sha256, mask: { ...asset("predictions/" + sampleId + ".png", 4), encoding: SEGMENTATION_PALETTE_ID } }],
  };
}
function manifest(samples = [sample("dev-01", "development"), sample("heldout-01", "held-out-evaluation")]) {
  return { schemaVersion: "1.0.0", benchmarkId: "pilot-dhaka-a", createdAt: reviewedAt,
    paletteId: SEGMENTATION_PALETTE_ID, samples };
}

test("validates versioned source/label provenance and a held-out capture-group split", () => {
  const report = validateSegmentationBenchmarkManifest(manifest());
  assert.equal(report.status, "ready-for-evaluation");
  assert.equal(report.sampleCount, 2);
  assert.equal(report.heldOutSamples, 1);
  assert.equal(report.issues.length, 0);
});

test("rejects capture-burst leakage, unsafe paths and stale model input hashes", () => {
  const leaked = manifest([sample("dev-01", "development", "burst-a"), sample("test-01", "held-out-evaluation", "burst-a")]);
  assert.equal(validateSegmentationBenchmarkManifest(leaked).status, "failed");
  assert.ok(validateSegmentationBenchmarkManifest(leaked).issues.some((x) => x.code === "capture-group-split-leakage"));

  const unsafe = manifest();
  unsafe.samples[0].groundTruthMask.path = "../not-a-label.png";
  assert.equal(validateSegmentationBenchmarkManifest(unsafe).status, "failed");

  const stale = manifest();
  stale.samples[0].predictions[0].inputSha256 = hash(98);
  assert.ok(validateSegmentationBenchmarkManifest(stale).issues.some((x) => x.code === "candidate-input-hash-mismatch"));
});

test("keeps missing held-out data, review records or source permission evidence incomplete", () => {
  const oneSplit = manifest([sample("dev-01", "development")]);
  assert.equal(validateSegmentationBenchmarkManifest(oneSplit).status, "incomplete");
  assert.ok(validateSegmentationBenchmarkManifest(oneSplit).issues.some((x) => x.code === "held-out-subset-missing"));

  const noReview = manifest();
  noReview.samples[1].groundTruthMask.review = { status: "proposed" };
  noReview.samples[1].source.rights.status = "operator-attested";
  const checked = validateSegmentationBenchmarkManifest(noReview);
  assert.equal(checked.status, "incomplete");
  assert.ok(checked.issues.some((x) => x.code === "ground-truth-mask-not-reviewed"));
  assert.ok(checked.issues.some((x) => x.code === "source-rights-not-independently-verified"));
});

test("decodes only known RGB labels and computes per-class precision, recall and IoU", () => {
  assert.deepEqual([...decodeSegmentationPalette(new Uint8Array([
    0,0,0, 255,255,255, 0,255,0, 255,0,0, 0,0,255, 255,255,0,
  ]))], [0,1,2,3,4,5]);
  assert.throws(() => decodeSegmentationPalette(new Uint8Array([1,2,3])), /unsupported palette colour/);
  assert.throws(() => decodeSegmentationPalette(new Uint8Array([1,2])), /divisible by three/);

  const exact = calculateSegmentationMetrics([0,1,1,2,3,4,5], [0,1,1,2,3,4,5]);
  assert.equal(exact.accuracy, 1);
  assert.equal(exact.perClass.find((x) => x.className === "building").iou, 1);
  const changed = calculateSegmentationMetrics([0,1,1,2], [0,1,2,2]);
  const building = changed.perClass.find((x) => x.className === "building");
  assert.equal(building.tp, 1);
  assert.equal(building.fn, 1);
  assert.equal(building.recall, 0.5);
  assert.ok(changed.perClass.find((x) => x.className === "vegetation").fp > 0);
});

test("benchmark report exposes per-image and held-out metrics but never auto-approves a model", () => {
  const input = manifest();
  const metrics = calculateSegmentationMetrics([0,1,1,2], [0,1,1,2]);
  const report = buildSegmentationBenchmarkReport({ manifest: input, generatedAt: reviewedAt,
    evaluatedSamples: [
      { sampleId: "dev-01", providerId: "local-seg-v1", status: "evaluated", metrics },
      { sampleId: "heldout-01", providerId: "local-seg-v1", status: "evaluated", metrics },
    ] });
  assert.equal(report.status, "benchmark-review-required");
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.candidateSummaries[0].heldOutImageCount, 1);
  assert.equal(report.perImage.length, 2);
  assert.equal(report.candidateSummaries[0].recommendation, "manual-review-required");
});

test("does not call an unevaluated mask or malformed palette a pass", () => {
  const input = manifest();
  const report = buildSegmentationBenchmarkReport({ manifest: input, evaluatedSamples: [] });
  assert.equal(report.status, "benchmark-incomplete");
  assert.ok(report.issues.some((x) => x.code === "candidate-result-not-evaluated"));
  const malformed = manifest();
  malformed.samples[0].predictions[0].mask.encoding = "binary-mask";
  assert.equal(validateSegmentationBenchmarkManifest(malformed).status, "failed");
});
