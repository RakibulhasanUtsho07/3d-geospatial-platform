import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createSurveyObservationAttributionAttestation,
  parseTrustedSurveyorRegistry,
  verifySurveyObservationAttributionAttestation,
} from "../src/core/building-generation/survey-observation-attribution-attestation.mjs";

const ISSUED = "2026-11-01T00:00:00.000Z";
const VALID_FROM = "2026-11-01T00:00:00.000Z";
const REVOKED_AT = "2026-11-04T00:00:00.000Z";
const NOW = "2026-11-05T13:00:00.000Z";
const EXPIRES = "2026-12-01T00:00:00.000Z";
const ATTESTED_AT = "2026-11-05T12:00:00.000Z";
const recordBytes = Buffer.from([0x00, 0x52, 0x49, 0x4e, 0x45, 0x58, 0xff, 0x10]);
const controlPointManifestBytes = Buffer.from('{"schemaVersion":"1.2.0","heldOutCheckpoints":{"points":[]}}', "utf8");

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function entry(pair, overrides = {}) {
  return {
    surveyorId: "surveyor-01",
    keyId: "surveyor-key-01",
    status: "active",
    publicKeyPem: pair.publicKeyPem,
    validFromUtc: VALID_FROM,
    validUntilUtc: EXPIRES,
    revokedAtUtc: null,
    replacesKeyId: null,
    ...overrides,
  };
}

function registry(entries, overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    recordType: "trusted-surveyor-public-key-registry",
    registryId: "surveyors-2026-q4",
    issuedAtUtc: ISSUED,
    expiresAtUtc: EXPIRES,
    entries,
    ...overrides,
  };
}

function signFixture(pair, trustedSurveyorRegistry = registry([entry(pair)]), overrides = {}) {
  return createSurveyObservationAttributionAttestation({
    recordBytes,
    controlPointManifestBytes,
    observationId: "obs-001",
    checkpointId: "check-001",
    buildingId: "building-001",
    surveyorId: "surveyor-01",
    privateKeyPem: pair.privateKeyPem,
    trustedSurveyorRegistry,
    attestedAtUtc: ATTESTED_AT,
    ...overrides,
  });
}

function verifyFixture(attestation, trustedSurveyorRegistry = null, overrides = {}) {
  return verifySurveyObservationAttributionAttestation({
    attestation,
    recordBytes,
    controlPointManifestBytes,
    observationId: "obs-001",
    checkpointId: "check-001",
    buildingId: "building-001",
    trustedSurveyorRegistry,
    now: NOW,
    ...overrides,
  });
}

test("creates and verifies an exact-byte checkpoint attribution attestation", () => {
  const pair = keys();
  const trusted = registry([entry(pair)]);
  const attestation = signFixture(pair, trusted);
  const result = verifyFixture(attestation, trusted);

  assert.equal(attestation.algorithm, "Ed25519");
  assert.equal(attestation.recordBytes, recordBytes.length);
  assert.equal(attestation.publicationEligible, false);
  assert.equal(attestation.signatureBase64.length, 88);
  assert.equal(result.status, "attribution-signature-verified");
  assert.equal(result.valid, true);
  assert.equal(result.publicationEligible, false);
  assert.equal(result.surveyorId, "surveyor-01");
});

test("rejects record-byte substitution even when manifest bytes are unchanged", () => {
  const pair = keys();
  const trusted = registry([entry(pair)]);
  const attestation = signFixture(pair, trusted);
  const result = verifyFixture(attestation, trusted, {
    recordBytes: Buffer.concat([recordBytes, Buffer.from("tampered")]),
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "record-byte-binding"));
});

test("rejects control-point manifest drift", () => {
  const pair = keys();
  const trusted = registry([entry(pair)]);
  const attestation = signFixture(pair, trusted);
  const result = verifyFixture(attestation, trusted, {
    controlPointManifestBytes: Buffer.concat([controlPointManifestBytes, Buffer.from(" ")]),
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "control-manifest-binding"));
});

test("rejects an observation or checkpoint context substitution", () => {
  const pair = keys();
  const trusted = registry([entry(pair)]);
  const attestation = signFixture(pair, trusted);
  const result = verifyFixture(attestation, trusted, { checkpointId: "check-002" });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "observation-binding"));
  assert.equal(result.checks.find((item) => item.id === "ed25519-signature").status, "failed");
});

test("refuses a private key that does not match the active surveyor registry entry", () => {
  const trustedPair = keys();
  const wrongPair = keys();
  const trusted = registry([entry(trustedPair)]);

  assert.throws(() => signFixture(wrongPair, trusted), /does not resolve/);
});

test("rejects an unknown registry key during verification", () => {
  const pair = keys();
  const other = keys();
  const attestation = signFixture(pair, registry([entry(pair)]));
  const result = verifyFixture(attestation, registry([entry(other)]));

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "active-surveyor-key"));
});

test("accepts an explicit all-revoked emergency lockout registry but authorizes no signatures", () => {
  const pair = keys();
  const revokedRegistry = registry([entry(pair, {
    status: "revoked",
    revokedAtUtc: REVOKED_AT,
  })]);
  const parsed = parseTrustedSurveyorRegistry(revokedRegistry, { now: NOW });

  assert.equal(parsed.activeEntries.length, 0);
  assert.throws(() => signFixture(pair, revokedRegistry), /does not resolve/);
});

test("revocation invalidates a previously valid attestation under the current registry", () => {
  const pair = keys();
  const activeRegistry = registry([entry(pair)]);
  const attestation = signFixture(pair, activeRegistry);
  const currentRevokedRegistry = registry([entry(pair, {
    status: "revoked",
    revokedAtUtc: "2026-11-05T12:30:00.000Z",
  })]);
  const result = verifyFixture(attestation, currentRevokedRegistry);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "active-surveyor-key"));
});

test("accepts a linear key rotation and verifies only the currently active successor", () => {
  const oldPair = keys();
  const newPair = keys();
  const rotatedRegistry = registry([
    entry(oldPair, {
      status: "revoked",
      revokedAtUtc: REVOKED_AT,
      validUntilUtc: EXPIRES,
    }),
    entry(newPair, {
      keyId: "surveyor-key-02",
      validFromUtc: REVOKED_AT,
      replacesKeyId: "surveyor-key-01",
    }),
  ]);
  const attestation = createSurveyObservationAttributionAttestation({
    recordBytes,
    controlPointManifestBytes,
    observationId: "obs-001",
    checkpointId: "check-001",
    buildingId: "building-001",
    surveyorId: "surveyor-01",
    privateKeyPem: newPair.privateKeyPem,
    trustedSurveyorRegistry: rotatedRegistry,
    attestedAtUtc: ATTESTED_AT,
  });
  const result = verifyFixture(attestation, rotatedRegistry);

  assert.equal(result.valid, true);
  assert.equal(result.keyId, "surveyor-key-02");
});

test("rejects duplicate key IDs, duplicate public-key fingerprints and forked rotation histories", () => {
  const first = keys();
  const second = keys();
  const duplicateId = registry([
    entry(first),
    entry(second, { keyId: "surveyor-key-01", status: "revoked", revokedAtUtc: REVOKED_AT, replacesKeyId: null }),
  ]);
  assert.throws(() => parseTrustedSurveyorRegistry(duplicateId, { now: NOW }), /key IDs must be globally unique/);

  const duplicateFingerprint = registry([
    entry(first),
    entry(first, { keyId: "surveyor-key-02", status: "revoked", revokedAtUtc: REVOKED_AT, replacesKeyId: null }),
  ]);
  assert.throws(() => parseTrustedSurveyorRegistry(duplicateFingerprint, { now: NOW }), /fingerprints must be unique/);

  const forked = registry([
    entry(first, { status: "revoked", revokedAtUtc: REVOKED_AT }),
    entry(second, { keyId: "surveyor-key-02", validFromUtc: REVOKED_AT, replacesKeyId: "surveyor-key-01" }),
    entry(keys(), { keyId: "surveyor-key-03", validFromUtc: REVOKED_AT, replacesKeyId: "surveyor-key-01" }),
  ]);
  assert.throws(() => parseTrustedSurveyorRegistry(forked, { now: NOW }), /replace one earlier revoked key/);
});

test("rejects expired and not-yet-valid registries", () => {
  const pair = keys();
  const expired = registry([entry(pair)], { expiresAtUtc: "2026-11-05T12:00:00.000Z" });
  assert.throws(() => parseTrustedSurveyorRegistry(expired, { now: NOW }), /expired/);

  const future = registry([entry(pair)], {
    issuedAtUtc: "2026-11-06T00:00:00.000Z",
    expiresAtUtc: "2026-12-01T00:00:00.000Z",
  });
  assert.throws(() => parseTrustedSurveyorRegistry(future, { now: NOW }), /not yet valid/);
});

test("rejects malformed timestamps, non-Ed25519 public keys and oversized registries", () => {
  const pair = keys();
  const badTime = registry([entry(pair)], { issuedAtUtc: "2026-11-01T00:00:00Z" });
  assert.throws(() => parseTrustedSurveyorRegistry(badTime, { now: NOW }), /canonical UTC/);

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPublic = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => parseTrustedSurveyorRegistry(registry([entry(pair, { publicKeyPem: rsaPublic })]), { now: NOW }), /Ed25519/);

  assert.throws(() => parseTrustedSurveyorRegistry(" ".repeat(64 * 1024 + 1), { now: NOW }), /64 KiB/);
});

test("rejects malformed signature encoding and attempts to set release eligibility", () => {
  const pair = keys();
  const trusted = registry([entry(pair)]);
  const attestation = signFixture(pair, trusted);
  const malformed = verifyFixture({ ...attestation, signatureBase64: "AAAA" }, trusted);
  assert.equal(malformed.valid, false);
  assert.ok(malformed.errors.some((item) => item.id === "attestation-envelope"));

  const releaseClaim = verifyFixture({ ...attestation, publicationEligible: true }, trusted);
  assert.equal(releaseClaim.valid, false);
  assert.equal(releaseClaim.publicationEligible, false);
});

test("rejects unknown fields in registry and attestation envelopes", () => {
  const pair = keys();
  const trusted = { ...registry([entry(pair)]), injected: true };
  assert.throws(() => parseTrustedSurveyorRegistry(trusted, { now: NOW }), /exact versioned envelope/);

  const validRegistry = registry([entry(pair)]);
  const attestation = signFixture(pair, validRegistry);
  const result = verifyFixture({ ...attestation, extraField: "nope" }, validRegistry);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "attestation-envelope-fields"));
});

test("rejects unsafe identifiers and oversized record or manifest inputs", () => {
  const pair = keys();
  const trusted = registry([entry(pair)]);
  assert.throws(() => signFixture(pair, trusted, { observationId: "../escape" }), /safe identifier/);
  assert.throws(() => createSurveyObservationAttributionAttestation({
    recordBytes: Buffer.alloc(16 * 1024 * 1024 + 1),
    controlPointManifestBytes,
    observationId: "obs-001",
    checkpointId: "check-001",
    buildingId: "building-001",
    surveyorId: "surveyor-01",
    privateKeyPem: pair.privateKeyPem,
    trustedSurveyorRegistry: trusted,
    attestedAtUtc: ATTESTED_AT,
  }), /16 MiB/);
  assert.throws(() => createSurveyObservationAttributionAttestation({
    recordBytes,
    controlPointManifestBytes: Buffer.alloc(1024 * 1024 + 1),
    observationId: "obs-001",
    checkpointId: "check-001",
    buildingId: "building-001",
    surveyorId: "surveyor-01",
    privateKeyPem: pair.privateKeyPem,
    trustedSurveyorRegistry: trusted,
    attestedAtUtc: ATTESTED_AT,
  }), /1 MiB/);
});
