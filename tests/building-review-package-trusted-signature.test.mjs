import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  signBuildingReviewPackageManifestWithTrustedRegistry,
  verifyBuildingReviewPackageSignatureWithTrustedRegistry,
} from "../src/core/building-generation/building-review-package-signature.mjs";

const ISSUED = "2026-11-01T00:00:00.000Z";
const EXPIRES = "2026-12-01T00:00:00.000Z";
const SIGNED_AT = "2026-11-04T13:00:00.000Z";
const MANIFEST = Buffer.from('{"schemaVersion":"1.0.0","buildingId":"synthetic-building","publicationEligible":false}', "utf8");

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function makeRegistry(publicKeyPem, overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "test-reviewer-registry-2026-11",
    issuedAtUtc: ISSUED,
    expiresAtUtc: EXPIRES,
    entries: [{
      reviewerId: "reviewer-utsho-test",
      keyId: "reviewer-utsho-key-01",
      status: "active",
      publicKeyPem,
      validFromUtc: ISSUED,
      validUntilUtc: EXPIRES,
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
    ...overrides,
  };
}

function signFixture() {
  const pair = keyPair();
  const trustedReviewerRegistry = makeRegistry(pair.publicKeyPem);
  const signatureEnvelope = signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes: MANIFEST,
    privateKeyPem: pair.privateKeyPem,
    reviewerId: "reviewer-utsho-test",
    trustedReviewerRegistry,
    signedAt: SIGNED_AT,
  });
  return { ...pair, trustedReviewerRegistry, signatureEnvelope, manifestBytes: MANIFEST };
}

test("signs exact review-package bytes with the active registered reviewer key and purpose context", () => {
  const fixture = signFixture();
  const envelope = fixture.signatureEnvelope;
  assert.equal(envelope.schemaVersion, "2.0.0");
  assert.equal(envelope.engine, "building-review-package-signature-v2");
  assert.equal(envelope.signaturePurpose, "package-integrity-attestation-not-release-approval");
  assert.equal(envelope.reviewerId, "reviewer-utsho-test");
  assert.equal(envelope.keyId, "reviewer-utsho-key-01");
  assert.equal(envelope.registryId, "test-reviewer-registry-2026-11");
  assert.equal(envelope.publicationEligible, false);

  const result = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    signatureEnvelope: envelope,
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    now: SIGNED_AT,
  });
  assert.equal(result.status, "signature-verified");
  assert.equal(result.valid, true);
  assert.equal(result.reviewerId, "reviewer-utsho-test");
  assert.equal(result.keyId, "reviewer-utsho-key-01");
  assert.equal(result.registryId, "test-reviewer-registry-2026-11");
  assert.equal(result.publicationEligible, false);
});

test("rejects a private key that does not match the registered reviewer public key", () => {
  const registryPair = keyPair();
  const unrelatedPair = keyPair();
  assert.throws(() => signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes: MANIFEST,
    privateKeyPem: unrelatedPair.privateKeyPem,
    reviewerId: "reviewer-utsho-test",
    trustedReviewerRegistry: makeRegistry(registryPair.publicKeyPem),
    signedAt: SIGNED_AT,
  }), /does-not-match-active-registry-key/);
});

test("rejects an unknown or ambiguous reviewer identity", () => {
  const pair = keyPair();
  const trustedReviewerRegistry = makeRegistry(pair.publicKeyPem);
  assert.throws(() => signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes: MANIFEST,
    privateKeyPem: pair.privateKeyPem,
    reviewerId: "unknown-reviewer",
    trustedReviewerRegistry,
    signedAt: SIGNED_AT,
  }), /not-uniquely-active/);
});

test("rejects malformed, legacy-array and oversized reviewer registries for v2 signing", () => {
  const pair = keyPair();
  assert.throws(() => signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes: MANIFEST,
    privateKeyPem: pair.privateKeyPem,
    reviewerId: "reviewer-utsho-test",
    trustedReviewerRegistry: [{ reviewerId: "reviewer-utsho-test", publicKeyPem: pair.publicKeyPem }],
    signedAt: SIGNED_AT,
  }), /versioned.*registry|legacy key arrays/i);
  assert.throws(() => signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes: Buffer.alloc(0),
    privateKeyPem: pair.privateKeyPem,
    reviewerId: "reviewer-utsho-test",
    trustedReviewerRegistry: makeRegistry(pair.publicKeyPem),
    signedAt: SIGNED_AT,
  }), /non-empty Buffer/);
  assert.throws(() => signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes: MANIFEST,
    privateKeyPem: pair.privateKeyPem,
    reviewerId: "reviewer-utsho-test",
    trustedReviewerRegistry: makeRegistry(pair.publicKeyPem),
    signedAt: "2026-11-04T13:00:00Z",
  }), /canonical UTC timestamp/);
});

test("fails closed when a currently active key has been revoked", () => {
  const fixture = signFixture();
  const revokedRegistry = {
    ...fixture.trustedReviewerRegistry,
    entries: [{
      ...fixture.trustedReviewerRegistry.entries[0],
      status: "revoked",
      revokedAtUtc: "2026-11-04T14:00:00.000Z",
    }],
  };
  const result = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: revokedRegistry,
    now: "2026-11-04T15:00:00.000Z",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "trusted-reviewer-registry-key"));
});

test("fails closed for an expired registry and an expired current key", () => {
  const fixture = signFixture();
  const expiredRegistry = {
    ...fixture.trustedReviewerRegistry,
    issuedAtUtc: "2026-10-01T00:00:00.000Z",
    expiresAtUtc: "2026-10-30T00:00:00.000Z",
    entries: [{
      ...fixture.trustedReviewerRegistry.entries[0],
      validFromUtc: "2026-10-01T00:00:00.000Z",
      validUntilUtc: "2026-10-30T00:00:00.000Z",
    }],
  };
  const expired = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: expiredRegistry,
    now: "2026-11-04T15:00:00.000Z",
  });
  assert.equal(expired.valid, false);
  assert.ok(expired.errors.some((item) => item.id === "trusted-reviewer-registry-key"));

  const shortLivedPair = keyPair();
  const shortLivedRegistry = makeRegistry(shortLivedPair.publicKeyPem, {
    expiresAtUtc: "2026-11-30T00:00:00.000Z",
    entries: [{
      reviewerId: "reviewer-utsho-test",
      keyId: "reviewer-utsho-key-01",
      status: "active",
      publicKeyPem: shortLivedPair.publicKeyPem,
      validFromUtc: "2026-11-01T00:00:00.000Z",
      validUntilUtc: "2026-11-03T00:00:00.000Z",
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  });
  const shortLivedEnvelope = signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    privateKeyPem: shortLivedPair.privateKeyPem,
    reviewerId: "reviewer-utsho-test",
    trustedReviewerRegistry: shortLivedRegistry,
    signedAt: "2026-11-02T00:00:00.000Z",
  });
  const expiredKey = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    signatureEnvelope: shortLivedEnvelope,
    trustedReviewerRegistry: shortLivedRegistry,
    now: "2026-11-04T00:00:00.000Z",
  });
  assert.equal(expiredKey.valid, false);
  assert.ok(expiredKey.errors.some((item) => item.id === "trusted-reviewer-registry-key"));
});

test("rejects a different current registry, reviewer, key, fingerprint or validity window", () => {
  const fixture = signFixture();
  const anotherPair = keyPair();
  const anotherRegistry = makeRegistry(anotherPair.publicKeyPem, {
    registryId: "other-reviewer-registry-2026-11",
  });
  const wrongRegistry = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: anotherRegistry,
    now: SIGNED_AT,
  });
  assert.equal(wrongRegistry.valid, false);

  for (const [field, value] of [
    ["reviewerId", "reviewer-other"],
    ["keyId", "key-other"],
    ["registryId", "registry-other"],
    ["publicKeyFingerprintSha256", "f".repeat(64)],
    ["keyValidUntilUtc", "2026-11-30T00:00:00.000Z"],
    ["signaturePurpose", "release-approval"],
  ]) {
    const result = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
      manifestBytes: fixture.manifestBytes,
      signatureEnvelope: { ...fixture.signatureEnvelope, [field]: value },
      trustedReviewerRegistry: fixture.trustedReviewerRegistry,
      now: SIGNED_AT,
    });
    assert.equal(result.valid, false, "field " + field + " must remain signature-bound");
  }
});

test("rejects altered manifest bytes, altered signature bytes and non-canonical base64", () => {
  const fixture = signFixture();
  const changedManifest = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: Buffer.concat([fixture.manifestBytes, Buffer.from(" ")]),
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    now: SIGNED_AT,
  });
  assert.equal(changedManifest.valid, false);
  assert.ok(changedManifest.errors.some((item) => item.id === "signature-manifest-hash"));

  const alteredSignature = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    signatureEnvelope: {
      ...fixture.signatureEnvelope,
      signatureBase64: Buffer.alloc(64, 7).toString("base64"),
    },
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    now: SIGNED_AT,
  });
  assert.equal(alteredSignature.valid, false);
  assert.ok(alteredSignature.errors.some((item) => item.id === "ed25519-signature"));

  const malformedBase64 = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    signatureEnvelope: { ...fixture.signatureEnvelope, signatureBase64: "not-base64!" },
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    now: SIGNED_AT,
  });
  assert.equal(malformedBase64.valid, false);
});

test("rejects future-dated signature metadata", () => {
  const fixture = signFixture();
  const future = verifyBuildingReviewPackageSignatureWithTrustedRegistry({
    manifestBytes: fixture.manifestBytes,
    signatureEnvelope: { ...fixture.signatureEnvelope, signedAt: "2026-11-05T00:00:00.000Z" },
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    now: SIGNED_AT,
  });
  assert.equal(future.valid, false);
});


test("publishes a strict JSON Schema for the v2 registry-bound signature envelope", async () => {
  const schema = JSON.parse(await readFile(new URL("../building-review-package-signature-v2.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.properties.schemaVersion.const, "2.0.0");
  assert.equal(schema.properties.signaturePurpose.const, "package-integrity-attestation-not-release-approval");
  assert.equal(schema.additionalProperties, false);
  for (const field of [
    "reviewerId", "keyId", "registryId", "publicKeyFingerprintSha256",
    "registryIssuedAtUtc", "registryExpiresAtUtc", "keyValidFromUtc",
    "keyValidUntilUtc", "signedAt", "signatureBase64",
  ]) {
    assert.ok(schema.required.includes(field), field + " must be required in the signed envelope schema");
  }
});
