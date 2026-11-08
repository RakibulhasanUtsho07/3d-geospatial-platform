import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildTrustRegistrySnapshotInventory } from "../src/core/building-generation/trust-registry-snapshot.mjs";
import {
  signTrustRegistryGovernanceAttestation,
  verifyTrustRegistryGovernanceAttestation,
  matchesTrustRegistryGovernanceMetadata,
} from "../src/core/building-generation/trust-registry-governance-attestation.mjs";

function fixtures() {
  const registry = (recordType, registryId) => JSON.stringify({
    schemaVersion: "1.0.0", recordType, registryId,
    issuedAtUtc: "2026-11-01T00:00:00.000Z",
    expiresAtUtc: "2026-12-01T00:00:00.000Z", entries: [],
  });
  const registries = {
    trustedSurveyorRegistry: registry("trusted-surveyor-public-key-registry", "surveyors-q4-2026"),
    trustedDeviceRegistry: registry("trusted-survey-device-public-key-registry", "devices-q4-2026"),
    trustedEnrollmentAuthorityRegistry: registry(
      "trusted-survey-device-enrollment-authority-public-key-registry", "enrollment-authorities-q4-2026",
    ),
  };
  const pair = generateKeyPairSync("ed25519");
  return {
    registries,
    snapshotInventory: buildTrustRegistrySnapshotInventory(registries),
    privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
function signed(fixture, overrides = {}) {
  return signTrustRegistryGovernanceAttestation({
    snapshotInventory: fixture.snapshotInventory,
    registrySetId: "survey-trust-q4-2026",
    sequence: 17,
    issuedAtUtc: "2026-11-05T00:00:00.000Z",
    expiresAtUtc: "2026-11-20T00:00:00.000Z",
    governanceKeyId: "trust-governance-root-01",
    privateKey: fixture.privateKey,
    ...overrides,
  });
}
const NOW = new Date("2026-11-05T12:00:00.000Z");

test("signs and verifies governance approval for the exact D3M-20 snapshot", () => {
  const fixture = fixtures();
  const result = verifyTrustRegistryGovernanceAttestation({
    attestation: signed(fixture), governancePublicKeyPem: fixture.publicKeyPem,
    minimumSequence: 17, snapshotInventory: fixture.snapshotInventory, now: NOW,
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.metadata.sequence, 17);
  assert.equal(result.metadata.registrySetId, "survey-trust-q4-2026");
  assert.equal(result.metadata.snapshotSha256, fixture.snapshotInventory.sha256);
  assert.equal(matchesTrustRegistryGovernanceMetadata(result.metadata, fixture.snapshotInventory), true);
  assert.doesNotMatch(JSON.stringify(result.metadata), /BEGIN PRIVATE KEY|BEGIN PUBLIC KEY/);
});
test("rejects a signature changed after governance approval", () => {
  const fixture = fixtures();
  const envelope = JSON.parse(signed(fixture));
  envelope.signatureBase64 = "B" + envelope.signatureBase64.slice(1);
  const result = verifyTrustRegistryGovernanceAttestation({
    attestation: JSON.stringify(envelope), governancePublicKeyPem: fixture.publicKeyPem,
    minimumSequence: 17, snapshotInventory: fixture.snapshotInventory, now: NOW,
  });
  assert.equal(result.valid, false);
});
test("rejects governance key substitution", () => {
  const fixture = fixtures();
  const other = generateKeyPairSync("ed25519");
  const result = verifyTrustRegistryGovernanceAttestation({
    attestation: signed(fixture),
    governancePublicKeyPem: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
    minimumSequence: 17, snapshotInventory: fixture.snapshotInventory, now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /fingerprint/);
});
test("rejects a sequence below the independently pinned anti-rollback floor", () => {
  const fixture = fixtures();
  const result = verifyTrustRegistryGovernanceAttestation({
    attestation: signed(fixture), governancePublicKeyPem: fixture.publicKeyPem,
    minimumSequence: 18, snapshotInventory: fixture.snapshotInventory, now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /minimum/);
});
test("rejects a governance statement for a different D3M-20 snapshot", () => {
  const fixture = fixtures();
  const changedSnapshot = buildTrustRegistrySnapshotInventory({
    ...fixture.registries,
    trustedDeviceRegistry: fixture.registries.trustedDeviceRegistry + "\n",
  });
  const result = verifyTrustRegistryGovernanceAttestation({
    attestation: signed(fixture), governancePublicKeyPem: fixture.publicKeyPem,
    minimumSequence: 17, snapshotInventory: changedSnapshot, now: NOW,
  });
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /exact D3M-20/);
});
test("rejects expired, future-dated and overlong statements", () => {
  const fixture = fixtures();
  const expired = signed(fixture, {
    issuedAtUtc: "2026-10-01T00:00:00.000Z", expiresAtUtc: "2026-10-20T00:00:00.000Z",
  });
  assert.equal(verifyTrustRegistryGovernanceAttestation({
    attestation: expired, governancePublicKeyPem: fixture.publicKeyPem,
    minimumSequence: 17, snapshotInventory: fixture.snapshotInventory, now: NOW,
  }).valid, false);
  const future = signed(fixture, {
    issuedAtUtc: "2026-11-06T00:00:00.000Z", expiresAtUtc: "2026-11-20T00:00:00.000Z",
  });
  assert.equal(verifyTrustRegistryGovernanceAttestation({
    attestation: future, governancePublicKeyPem: fixture.publicKeyPem,
    minimumSequence: 17, snapshotInventory: fixture.snapshotInventory, now: NOW,
  }).valid, false);
  assert.throws(() => signed(fixture, {
    issuedAtUtc: "2026-11-01T00:00:00.000Z", expiresAtUtc: "2026-12-05T00:00:00.000Z",
  }), /30 days/);
});
test("rejects unknown fields and a missing anti-rollback floor", () => {
  const fixture = fixtures();
  const envelope = JSON.parse(signed(fixture));
  envelope.operatorComment = "not permitted";
  assert.equal(verifyTrustRegistryGovernanceAttestation({
    attestation: JSON.stringify(envelope), governancePublicKeyPem: fixture.publicKeyPem,
    minimumSequence: 17, snapshotInventory: fixture.snapshotInventory, now: NOW,
  }).valid, false);
  assert.equal(verifyTrustRegistryGovernanceAttestation({
    attestation: signed(fixture), governancePublicKeyPem: fixture.publicKeyPem,
    snapshotInventory: fixture.snapshotInventory, now: NOW,
  }).valid, false);
});
test("governance JSON Schema is strict", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../trust-registry-governance-attestation.schema.json", import.meta.url), "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.signaturePurpose.const, "approve-exact-survey-trust-registry-snapshot-only");
  assert.equal(schema.properties.sequence.minimum, 1);
  assert.equal(schema.required.length, 16);
});
