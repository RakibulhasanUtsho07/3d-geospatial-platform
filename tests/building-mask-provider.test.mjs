import assert from "node:assert/strict";
import test from "node:test";
import { resolveBuildingMaskProvider, validateBuildingMaskArtifact } from "../src/core/building-generation/building-mask-provider.mjs";

const hash = (seed) => seed.toString(16).padStart(64, "0").slice(-64);
const source = { sourceId: "capture-front", sha256: hash(1), width: 4, height: 3 };
const pixels = new Uint8Array([
  0,0,0,0,
  0,255,255,0,
  0,255,255,0,
]);
function fixture(overrides = {}) {
  const result = {
    schemaVersion: "1.0.0", sourceId: source.sourceId, inputSha256: source.sha256,
    provider: { id: "manual-review", kind: "human-reviewed-mask", version: "1", configurationSha256: hash(2) },
    mask: { sha256: hash(3), bytes: 120, width: 4, height: 3,
      encoding: "binary-8bit-white-foreground-v1", coordinateConvention: "pixel-origin-top-left",
      backgroundValue: 0, foregroundValue: 255 },
    assessment: { status: "reviewed", confidence: 1, humanReviewed: true, reviewerId: "reviewer-a", reviewedAt: "2026-10-26T10:00:00Z" },
    ...overrides,
  };
  return { source, result, actualMaskSha256: hash(3), decodedMask: { width: 4, height: 3, pixels } };
}

test("accepts a source-bound binary mask only after explicit review", () => {
  const report = validateBuildingMaskArtifact(fixture());
  assert.equal(report.status, "ready-for-feature-extraction");
  assert.equal(report.validForFeatureExtraction, true);
  assert.equal(report.policy.publishable, false);
});

test("rejects stale source/mask hashes, dimension mismatch and non-binary masks", () => {
  const stale = fixture();
  stale.result.inputSha256 = hash(99);
  assert.ok(validateBuildingMaskArtifact(stale).errors.some((e) => e.code === "source-hash-mismatch"));

  const changed = fixture();
  changed.actualMaskSha256 = hash(90);
  assert.ok(validateBuildingMaskArtifact(changed).errors.some((e) => e.code === "mask-hash-mismatch"));

  const dimensions = fixture();
  dimensions.result.mask.width = 3;
  assert.ok(validateBuildingMaskArtifact(dimensions).errors.some((e) => e.code === "mask-source-dimensions-mismatch"));

  const grey = fixture();
  grey.decodedMask.pixels[0] = 127;
  assert.ok(validateBuildingMaskArtifact(grey).errors.some((e) => e.code === "mask-not-binary"));
});

test("never allows an edge preview to masquerade as semantic building segmentation", () => {
  const input = fixture();
  input.result.provider.kind = "edge-preview";
  const report = validateBuildingMaskArtifact(input);
  assert.equal(report.status, "failed");
  assert.ok(report.errors.some((e) => e.code === "edge-map-is-not-semantic-mask"));
});

test("pending or rejected review cannot be used as a verified mask", () => {
  const pending = fixture();
  pending.result.assessment = { status: "proposed", confidence: 0.99, humanReviewed: false };
  assert.equal(validateBuildingMaskArtifact(pending).status, "review-required");
  assert.equal(validateBuildingMaskArtifact(pending).validForFeatureExtraction, false);

  const rejected = fixture();
  rejected.result.assessment.status = "rejected";
  assert.equal(validateBuildingMaskArtifact(rejected).status, "failed");
});

test("uses a reviewed manual fallback if automatic segmentation is stale or below threshold", () => {
  const fallback = validateBuildingMaskArtifact(fixture());
  const failedAuto = { status: "failed", validForFeatureExtraction: false, confidence: 0.98 };
  const result = resolveBuildingMaskProvider({ automaticReport: failedAuto, manualFallbackReport: fallback });
  assert.equal(result.status, "ready-for-feature-extraction");
  assert.equal(result.selected, "human-reviewed-mask");
  assert.equal(result.publishable, false);
});

test("blocks feature extraction when neither automatic nor manual mask is reviewed", () => {
  const pending = fixture();
  pending.result.assessment.status = "proposed";
  const manualPending = validateBuildingMaskArtifact(pending);
  const result = resolveBuildingMaskProvider({
    automaticReport: { status: "review-required", confidence: 0.99, validForFeatureExtraction: false },
    manualFallbackReport: manualPending,
  });
  assert.equal(result.status, "incomplete");
  assert.equal(result.selected, null);
  assert.throws(() => resolveBuildingMaskProvider({ minimumAutomaticConfidence: 1.2 }), /between 0 and 1/);
});
