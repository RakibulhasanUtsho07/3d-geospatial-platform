import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildSourceBoundVisualEvidenceBundle } from "../src/core/building-generation/source-bound-visual-evidence-bundle.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const iso = "2026-10-30T10:00:00.000Z";
function fixture(overrides = {}) {
  const sourceBytes = Buffer.from("synthetic-source-image");
  const maskBytes = Buffer.from("synthetic-binary-mask-png-fixture");
  const sourceSha256 = hash(sourceBytes);
  const maskSha256 = hash(maskBytes);
  const maskManifest = {
    schemaVersion: "1.0.0",
    artifactType: "source-bound-manual-mask-review",
    generatedAt: iso,
    source: { sourceId: "source-front", sha256: sourceSha256, bytes: sourceBytes.length, width: 100, height: 80, mimeType: "image/jpeg" },
    result: {
      schemaVersion: "1.0.0", sourceId: "source-front", inputSha256: sourceSha256,
      mask: { sha256: maskSha256, bytes: maskBytes.length, width: 100, height: 80,
        encoding: "binary-8bit-white-foreground-v1", coordinateConvention: "pixel-origin-top-left",
        backgroundValue: 0, foregroundValue: 255 },
      assessment: { status: "reviewed", confidence: 0.9, humanReviewed: true, reviewerId: "reviewer-01", reviewedAt: iso },
    },
    policy: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false, publishable: false },
  };
  const observationBatch = {
    schemaVersion: "1.0.0", batchId: "batch-front-01", buildingId: "building-a", viewId: "front",
    createdAt: iso, coordinateConvention: "source-image-pixel-origin-top-left",
    source: { id: "source-front", sha256: sourceSha256, width: 100, height: 80 },
    mask: null,
    observations: [{
      id: "roofline-01", category: "roofline-segment", sourceId: "source-front", sourceSha256,
      viewId: "front", geometry: { type: "LineString", coordinates: [[5, 10], [95, 12]] },
      confidence: 0.8, method: "human-review", status: "proposed", visibility: "visible", evidence: {},
    }],
    policy: { groundTruth: false, publicationEligible: false, publishable: false },
  };
  const input = {
    sourceBytes, maskBytes,
    maskManifestBytes: Buffer.from(JSON.stringify(maskManifest)),
    observationBatchBytes: Buffer.from(JSON.stringify(observationBatch)),
    sourceDimensions: { width: 100, height: 80 }, maskDimensions: { width: 100, height: 80 },
    sourceMimeType: "image/jpeg", createdAt: iso,
    ...overrides,
  };
  return { input, sourceBytes, maskBytes, maskManifest, observationBatch };
}

test("binds separate mask and observation exports to one exact source and mask", () => {
  const { input, maskBytes, maskManifest } = fixture();
  const result = buildSourceBoundVisualEvidenceBundle(input);
  assert.equal(result.bundle.source.sha256, maskManifest.source.sha256);
  assert.equal(result.bundle.maskArtifact.sha256, hash(maskBytes));
  assert.equal(result.bundle.observationArtifact.batch.mask.sha256, hash(maskBytes));
  assert.equal(result.bundle.observationArtifact.batch.mask.width, 100);
  assert.equal(result.bundle.evidenceLinks.maskAndObservationsShareExactSource, true);
  assert.equal(result.bundle.evidenceLinks.observationsReferenceExactMask, true);
  assert.equal(result.bundle.policy.groundTruth, false);
  assert.equal(result.bundle.policy.publicationEligible, false);
  assert.equal(result.bundle.policy.mapReady, false);
});

test("rejects source bytes that differ from the mask manifest source hash", () => {
  const { input } = fixture({ sourceBytes: Buffer.from("tampered-source") });
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(input), /exact supplied source-image bytes/);
});

test("rejects mask bytes that differ from the mask manifest hash", () => {
  const { input } = fixture({ maskBytes: Buffer.from("different-mask") });
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(input), /mask PNG bytes/);
});

test("rejects mismatched decoded source or mask dimensions", () => {
  const source = fixture({ sourceDimensions: { width: 99, height: 80 } });
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(source.input), /decoded source-image dimensions/);
  const mask = fixture({ maskDimensions: { width: 100, height: 79 } });
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(mask.input), /decoded mask dimensions/);
});

test("rejects an observation batch bound to another source or image size", () => {
  const { input, observationBatch } = fixture();
  observationBatch.source.id = "other-source";
  input.observationBatchBytes = Buffer.from(JSON.stringify(observationBatch));
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(input), /same source ID, bytes and dimensions/);
});

test("rejects a conflicting mask reference or per-observation mask hash", () => {
  const a = fixture();
  a.observationBatch.mask = { sha256: "f".repeat(64), width: 100, height: 80 };
  a.input.observationBatchBytes = Buffer.from(JSON.stringify(a.observationBatch));
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(a.input), /conflicting mask reference/);

  const b = fixture();
  b.observationBatch.observations[0].evidence.maskSha256 = "e".repeat(64);
  b.input.observationBatchBytes = Buffer.from(JSON.stringify(b.observationBatch));
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(b.input), /different mask SHA-256/);
});

test("rejects any attempt to promote acceptance, publication or map readiness", () => {
  const { input, maskManifest } = fixture();
  maskManifest.policy.mapReady = true;
  input.maskManifestBytes = Buffer.from(JSON.stringify(maskManifest));
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(input), /must explicitly keep/);
});

test("rejects inconsistent human-review metadata and preserves fail-closed status for proposals", () => {
  const { input, maskManifest } = fixture();
  maskManifest.result.assessment = { status: "reviewed", humanReviewed: false, confidence: 0.5 };
  input.maskManifestBytes = Buffer.from(JSON.stringify(maskManifest));
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(input), /assessment is inconsistent/);

  const pending = fixture();
  pending.maskManifest.result.assessment = { status: "proposed", humanReviewed: false, confidence: 0.5 };
  pending.input.maskManifestBytes = Buffer.from(JSON.stringify(pending.maskManifest));
  const result = buildSourceBoundVisualEvidenceBundle(pending.input);
  assert.equal(result.bundle.maskArtifact.assessment.status, "proposed");
  assert.equal(result.bundle.policy.acceptanceEligible, false);
});

test("rejects malformed, oversized or missing artifacts", () => {
  const { input } = fixture({ observationBatchBytes: Buffer.from("{") });
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(input), /valid JSON object/);
  const missing = fixture({ maskBytes: Buffer.alloc(0) });
  assert.throws(() => buildSourceBoundVisualEvidenceBundle(missing.input), /non-empty byte array/);
});
