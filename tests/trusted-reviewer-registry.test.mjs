import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { parseTrustedReconstructionReviewerKeys } from "../src/core/building-generation/source-bound-authenticated-review.mjs";

const NOW = "2026-10-31T03:00:00.000Z";
const BEFORE = "2026-10-30T03:00:00.000Z";
const AFTER = "2026-11-30T03:00:00.000Z";
const REGISTRY_EXPIRES = "2026-11-30T03:00:00.000Z";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function activeEntry(publicKeyPem, overrides = {}) {
  return {
    reviewerId: "reviewer-01",
    keyId: "key-2026-01",
    status: "active",
    publicKeyPem,
    validFromUtc: BEFORE,
    validUntilUtc: REGISTRY_EXPIRES,
    revokedAtUtc: null,
    replacesKeyId: null,
    ...overrides,
  };
}

function registry(entries, overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "production-reviewers-2026-10",
    issuedAtUtc: BEFORE,
    expiresAtUtc: REGISTRY_EXPIRES,
    entries,
    ...overrides,
  };
}

test("accepts a versioned registry with one currently active Ed25519 key per reviewer", () => {
  const pair = keyPair();
  const parsed = parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem)]), { now: NOW, allowLegacy: false });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].reviewerId, "reviewer-01");
  assert.equal(parsed[0].keyId, "key-2026-01");
  assert.equal(parsed[0].registryId, "production-reviewers-2026-10");
  assert.equal(parsed[0].validFromUtc, BEFORE);
  assert.equal(parsed[0].validUntilUtc, REGISTRY_EXPIRES);
  assert.match(parsed[0].publicKeyFingerprintSha256, /^[a-f0-9]{64}$/);
});

test("rejects legacy arrays when production mode is requested", () => {
  const pair = keyPair();
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys([{ reviewerId: "reviewer-01", publicKeyPem: pair.publicKeyPem }], { now: NOW, allowLegacy: false }),
    /versioned.*registry|legacy key arrays/i,
  );
});

test("rejects an expired or not-yet-valid registry envelope", () => {
  const pair = keyPair();
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem)], {
      expiresAtUtc: BEFORE,
    }), { now: NOW, allowLegacy: false }),
    /validity must be positive|expired/i,
  );
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem)], {
      issuedAtUtc: AFTER,
      expiresAtUtc: "2026-12-01T00:00:00.000Z",
    }), { now: NOW, allowLegacy: false }),
    /not yet valid/i,
  );
});

test("rejects registry validity windows longer than 90 days", () => {
  const pair = keyPair();
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem)], {
      expiresAtUtc: "2027-02-01T00:00:00.000Z",
    }), { now: NOW, allowLegacy: false }),
    /no longer than 90 days/i,
  );
});

test("rejects expired and not-yet-valid active keys", () => {
  const pair = keyPair();
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem, {
      validUntilUtc: BEFORE,
    })]), { now: NOW, allowLegacy: false }),
    /validity window/i,
  );
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem, {
      validFromUtc: AFTER,
    })]), { now: NOW, allowLegacy: false }),
    /validity window/i,
  );
});

test("retains revoked key records for audit but never returns them for verification", () => {
  const oldPair = keyPair();
  const nextPair = keyPair();
  const entries = [
    activeEntry(oldPair.publicKeyPem, {
      keyId: "key-2026-01",
      status: "revoked",
      validUntilUtc: "2026-11-30T03:00:00.000Z",
      revokedAtUtc: "2026-10-31T02:00:00.000Z",
    }),
    activeEntry(nextPair.publicKeyPem, {
      keyId: "key-2026-02",
      status: "active",
      validFromUtc: "2026-10-31T02:00:00.000Z",
      replacesKeyId: "key-2026-01",
    }),
  ];
  const parsed = parseTrustedReconstructionReviewerKeys(registry(entries), { now: NOW, allowLegacy: false });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].keyId, "key-2026-02");
  assert.equal(parsed[0].publicKeyFingerprintSha256.length, 64);
});

test("rejects a revoked key without a timestamp, or a future revocation timestamp", () => {
  const pair = keyPair();
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem, {
      status: "revoked",
      revokedAtUtc: null,
    })]), { now: NOW, allowLegacy: false }),
    /revokedAtUtc/i,
  );
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem, {
      status: "revoked",
      revokedAtUtc: AFTER,
    })]), { now: NOW, allowLegacy: false }),
    /not in the future/i,
  );
});

test("rejects duplicate key IDs, reused public keys and more than one active key per reviewer", () => {
  const one = keyPair();
  const two = keyPair();
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([
      activeEntry(one.publicKeyPem, { keyId: "same-key" }),
      activeEntry(two.publicKeyPem, { keyId: "same-key" }),
    ]), { now: NOW, allowLegacy: false }),
    /key IDs must be globally unique/i,
  );
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([
      activeEntry(one.publicKeyPem, { reviewerId: "reviewer-01", keyId: "key-a" }),
      activeEntry(one.publicKeyPem, { reviewerId: "reviewer-02", keyId: "key-b" }),
    ]), { now: NOW, allowLegacy: false }),
    /fingerprints must be unique/i,
  );
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([
      activeEntry(one.publicKeyPem, { keyId: "key-a" }),
      activeEntry(two.publicKeyPem, { keyId: "key-b" }),
    ]), { now: NOW, allowLegacy: false }),
    /exactly one active key/i,
  );
});

test("requires rotation to supersede a prior revoked key for the same reviewer", () => {
  const oldPair = keyPair();
  const newPair = keyPair();
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([
      activeEntry(oldPair.publicKeyPem, {
        keyId: "key-old",
        status: "revoked",
        revokedAtUtc: "2026-10-31T02:30:00.000Z",
      }),
      activeEntry(newPair.publicKeyPem, {
        keyId: "key-new",
        validFromUtc: "2026-10-31T02:00:00.000Z",
        replacesKeyId: "key-old",
      }),
    ]), { now: NOW, allowLegacy: false }),
    /replace one prior revoked key/i,
  );
});

test("rejects malformed registry envelope, unknown fields and private-key material", () => {
  const pair = keyPair();
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem)], { extra: true }), { now: NOW, allowLegacy: false }),
    /versioned JSON object/i,
  );
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.publicKeyPem, { extra: true })]), { now: NOW, allowLegacy: false }),
    /exactly the documented key lifecycle fields/i,
  );
  assert.throws(
    () => parseTrustedReconstructionReviewerKeys(registry([activeEntry(pair.privateKeyPem)]), { now: NOW, allowLegacy: false }),
    /public-key PEM only/i,
  );
});

test("development/test compatibility still accepts the legacy public-key array", () => {
  const pair = keyPair();
  const parsed = parseTrustedReconstructionReviewerKeys([{ reviewerId: "reviewer-01", publicKeyPem: pair.publicKeyPem }], {
    now: NOW,
    allowLegacy: true,
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].registryId, "development-legacy-array");
  assert.match(parsed[0].keyId, /^legacy-/);
});
