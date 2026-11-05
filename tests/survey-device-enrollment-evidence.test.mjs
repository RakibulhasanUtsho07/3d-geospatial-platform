import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  parseTrustedSurveyDeviceEnrollmentAuthorityRegistry,
  surveyDeviceEnrollmentEvidencePath,
  surveyDeviceEnrollmentEvidenceSigningBytes,
  verifySurveyDeviceEnrollmentEvidence,
  SURVEY_DEVICE_ENROLLMENT_EVIDENCE_NOTE,
} from "../src/core/building-generation/survey-device-enrollment-evidence.mjs";

const ISSUED = "2026-11-01T00:00:00.000Z";
const NOW = "2026-11-05T14:00:00.000Z";
const EXPIRES = "2026-12-01T00:00:00.000Z";
const HASH = (value) => createHash("sha256").update(value).digest("hex");
function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: pair.privateKey,
  };
}
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}
function canonical(value) { return Buffer.from(JSON.stringify(sorted(value)), "utf8"); }

function makeFixture({ authorityType = "independent-enrollment-authority" } = {}) {
  const device = keys();
  const authority = keys();
  const authorityRegistry = {
    schemaVersion: "1.0.0",
    recordType: "trusted-survey-device-enrollment-authority-public-key-registry",
    registryId: "enrollment-authorities-q4-2026",
    issuedAtUtc: ISSUED,
    expiresAtUtc: EXPIRES,
    entries: [{
      authorityId: "survey-enrollment-office",
      authorityType,
      keyId: "enrollment-key-01",
      status: "active",
      publicKeyPem: authority.publicKeyPem,
      validFromUtc: ISSUED,
      validUntilUtc: EXPIRES,
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  };
  const unsigned = {
    schemaVersion: "1.0.0",
    recordType: "survey-device-enrollment-evidence",
    engine: "survey-device-enrollment-evidence-v1",
    signatureAlgorithm: "Ed25519",
    signaturePurpose: "survey-device-hardware-identity-enrollment-only",
    enrollmentId: "enrollment-2026-001",
    deviceId: "receiver-01",
    manufacturerId: "vendor-01",
    modelId: "gnss-model-a",
    deviceSerialCommitmentSha256: "a".repeat(64),
    authorityId: "survey-enrollment-office",
    authorityType,
    authorityKeyId: "enrollment-key-01",
    authorityRegistryId: authorityRegistry.registryId,
    authorityRegistryIssuedAtUtc: authorityRegistry.issuedAtUtc,
    authorityRegistryExpiresAtUtc: authorityRegistry.expiresAtUtc,
    issuedAtUtc: NOW,
    validFromUtc: ISSUED,
    validUntilUtc: EXPIRES,
    publicationEligible: false,
    note: SURVEY_DEVICE_ENROLLMENT_EVIDENCE_NOTE,
  };
  const signatureBase64 = sign(null, surveyDeviceEnrollmentEvidenceSigningBytes({ ...unsigned, signatureBase64: "" }), authority.privateKey).toString("base64");
  const evidenceBytes = canonical({ ...unsigned, signatureBase64 });
  const deviceRegistry = {
    schemaVersion: "1.0.0",
    recordType: "trusted-survey-device-public-key-registry",
    registryId: "devices-q4-2026",
    issuedAtUtc: ISSUED,
    expiresAtUtc: EXPIRES,
    entries: [{
      deviceId: "receiver-01",
      manufacturerId: "vendor-01",
      modelId: "gnss-model-a",
      deviceSerialCommitmentSha256: "a".repeat(64),
      enrollmentEvidenceSha256: HASH(evidenceBytes),
      keyId: "receiver-key-01",
      status: "active",
      publicKeyPem: device.publicKeyPem,
      validFromUtc: ISSUED,
      validUntilUtc: EXPIRES,
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  };
  return { device, authority, authorityRegistry, deviceRegistry, evidenceBytes, unsigned };
}
function verifyFixture(fixture, overrides = {}) {
  return verifySurveyDeviceEnrollmentEvidence({
    evidenceBytes: fixture.evidenceBytes,
    trustedDeviceRegistry: fixture.deviceRegistry,
    trustedEnrollmentAuthorityRegistry: fixture.authorityRegistry,
    deviceId: "receiver-01",
    now: NOW,
    ...overrides,
  });
}

test("verifies exact device-level enrollment bytes against D3M-17 identity and operator authority registry", () => {
  const fixture = makeFixture({ authorityType: "manufacturer" });
  const result = verifyFixture(fixture);
  assert.equal(result.valid, true, JSON.stringify(result.checks));
  assert.equal(result.authorityType, "manufacturer");
  assert.equal(result.evidenceSha256, fixture.deviceRegistry.entries[0].enrollmentEvidenceSha256);
  assert.equal(result.publicationEligible, false);
  assert.equal(parseTrustedSurveyDeviceEnrollmentAuthorityRegistry(fixture.authorityRegistry, { now: NOW }).activeEntries.length, 1);
  assert.equal(surveyDeviceEnrollmentEvidencePath("receiver-01"), "evidence/device-enrollments/receiver-01.receiver-key-01.enrollment.json");
  assert.throws(() => surveyDeviceEnrollmentEvidencePath("con"), /cross-platform/);
});

test("rejects digest drift, noncanonical evidence bytes and tampered signatures", () => {
  const fixture = makeFixture();
  const digestDrift = { ...fixture, deviceRegistry: { ...fixture.deviceRegistry, entries: [{ ...fixture.deviceRegistry.entries[0], enrollmentEvidenceSha256: "f".repeat(64) }] } };
  assert.equal(verifyFixture(digestDrift).valid, false);
  const whitespace = { ...fixture, evidenceBytes: Buffer.concat([fixture.evidenceBytes, Buffer.from("\n")]) };
  assert.equal(verifyFixture(whitespace).valid, false);
  const parsed = JSON.parse(fixture.evidenceBytes.toString("utf8"));
  parsed.signatureBase64 = Buffer.alloc(64).toString("base64");
  const tampered = { ...fixture, evidenceBytes: canonical(parsed), deviceRegistry: { ...fixture.deviceRegistry, entries: [{ ...fixture.deviceRegistry.entries[0], enrollmentEvidenceSha256: HASH(canonical(parsed)) }] } };
  const result = verifyFixture(tampered);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "enrollment-authority-ed25519-signature"));
});

test("rejects wrong device identity and serial commitment substitution", () => {
  const fixture = makeFixture();
  const evidence = JSON.parse(fixture.evidenceBytes.toString("utf8"));
  evidence.deviceSerialCommitmentSha256 = "c".repeat(64);
  const changed = canonical(evidence);
  const changedFixture = { ...fixture, evidenceBytes: changed, deviceRegistry: { ...fixture.deviceRegistry, entries: [{ ...fixture.deviceRegistry.entries[0], enrollmentEvidenceSha256: HASH(changed) }] } };
  const result = verifyFixture(changedFixture);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "device-identity-binding"));
  assert.equal(verifyFixture(fixture, { deviceId: "receiver-02" }).valid, false);
});

test("same immutable enrollment statement remains valid after a D3M-17 device-key rotation", () => {
  const fixture = makeFixture();
  const oldEntry = fixture.deviceRegistry.entries[0];
  const replacement = keys();
  const revokedAtUtc = "2026-11-04T00:00:00.000Z";
  const rotatedRegistry = {
    ...fixture.deviceRegistry,
    entries: [
      { ...oldEntry, status: "revoked", revokedAtUtc },
      {
        ...oldEntry,
        keyId: "receiver-key-02",
        status: "active",
        publicKeyPem: replacement.publicKeyPem,
        validFromUtc: revokedAtUtc,
        revokedAtUtc: null,
        replacesKeyId: oldEntry.keyId,
      },
    ],
  };
  const result = verifyFixture({ ...fixture, deviceRegistry: rotatedRegistry });
  assert.equal(result.valid, true, JSON.stringify(result.checks));
  assert.equal(result.evidenceSha256, oldEntry.enrollmentEvidenceSha256);
  assert.equal(result.activeDeviceRegistryKeyId, "receiver-key-02");
});

test("rejects unknown, wrong and revoked enrollment authorities", () => {
  const fixture = makeFixture();
  const wrong = keys();
  const wrongRegistry = { ...fixture.authorityRegistry, entries: [{ ...fixture.authorityRegistry.entries[0], publicKeyPem: wrong.publicKeyPem }] };
  assert.equal(verifyFixture(fixture, { trustedEnrollmentAuthorityRegistry: wrongRegistry }).valid, false);
  const revokedRegistry = { ...fixture.authorityRegistry, entries: [{ ...fixture.authorityRegistry.entries[0], status: "revoked", revokedAtUtc: NOW }] };
  assert.equal(verifyFixture(fixture, { trustedEnrollmentAuthorityRegistry: revokedRegistry }).valid, false);
  assert.throws(() => parseTrustedSurveyDeviceEnrollmentAuthorityRegistry({ ...fixture.authorityRegistry, entries: [{ ...fixture.authorityRegistry.entries[0], authorityType: "unknown" }] }, { now: NOW }), /type/);
});

test("accepts bounded device-registry bytes and JSON text through the D3M-17 parser contract", () => {
  const fixture = makeFixture();
  const bytes = Buffer.from(JSON.stringify(fixture.deviceRegistry));
  assert.equal(verifyFixture(fixture, { trustedDeviceRegistry: bytes }).valid, true);
  assert.equal(verifyFixture(fixture, { trustedDeviceRegistry: bytes.toString("utf8") }).valid, true);
});

test("rejects enrollment statements issued outside the registered device-key validity window", () => {
  const fixture = makeFixture();
  const evidence = JSON.parse(fixture.evidenceBytes.toString("utf8"));
  evidence.issuedAtUtc = "2026-10-31T23:59:59.000Z";
  const changed = canonical({ ...evidence, signatureBase64: sign(null,
    surveyDeviceEnrollmentEvidenceSigningBytes({ ...evidence, signatureBase64: "" }), fixture.authority.privateKey).toString("base64") });
  const registry = { ...fixture.deviceRegistry, entries: [{ ...fixture.deviceRegistry.entries[0], enrollmentEvidenceSha256: HASH(changed) }] };
  const result = verifySurveyDeviceEnrollmentEvidence({ evidenceBytes: changed, trustedDeviceRegistry: registry,
    trustedEnrollmentAuthorityRegistry: fixture.authorityRegistry, deviceId: "receiver-01", keyId: "receiver-key-01", now: NOW });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "enrollment-evidence-time-window"));
});

test("rejects authority registry expiry, malformed key and broken rotation chain", () => {
  const fixture = makeFixture();
  assert.throws(() => parseTrustedSurveyDeviceEnrollmentAuthorityRegistry({ ...fixture.authorityRegistry, expiresAtUtc: "2026-11-05T13:00:00.000Z" }, { now: NOW }), /expired/);
  assert.throws(() => parseTrustedSurveyDeviceEnrollmentAuthorityRegistry({ ...fixture.authorityRegistry, entries: [{ ...fixture.authorityRegistry.entries[0], publicKeyPem: "not a key" }] }, { now: NOW }));
  assert.throws(() => parseTrustedSurveyDeviceEnrollmentAuthorityRegistry({ ...fixture.authorityRegistry, unexpected: true }, { now: NOW }), /exact versioned/);
});

test("keeps the JSON schemas strict and versioned", async () => {
  const registrySchema = JSON.parse(await readFile(new URL("../trusted-survey-device-enrollment-authority-public-key-registry.schema.json", import.meta.url), "utf8"));
  const evidenceSchema = JSON.parse(await readFile(new URL("../survey-device-enrollment-evidence.schema.json", import.meta.url), "utf8"));
  assert.equal(registrySchema.additionalProperties, false);
  assert.equal(registrySchema.properties.schemaVersion.const, "1.0.0");
  assert.equal(evidenceSchema.additionalProperties, false);
  assert.equal(evidenceSchema.properties.signaturePurpose.const, "survey-device-hardware-identity-enrollment-only");
  assert.equal(evidenceSchema.required.includes("keyId"), false);
  assert.equal(evidenceSchema.required.includes("devicePublicKeyFingerprintSha256"), false);
  assert.equal(evidenceSchema.properties.publicationEligible.const, false);
});

test("offline CLI prints help, verifies a fixture and rejects symlink inputs", async () => {
  const fixture = makeFixture();
  const script = new URL("../scripts/verify-survey-device-enrollment-evidence.mjs", import.meta.url);
  const help = spawnSync(process.execPath, [script.pathname, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /operator-provisioned trust anchor/);
  assert.doesNotMatch(help.stdout, /--key-id/);
  const directory = await mkdtemp(path.join(os.tmpdir(), "d3m18-enrollment-"));
  try {
    const devices = path.join(directory, "devices.json");
    const authorities = path.join(directory, "authorities.json");
    const evidence = path.join(directory, "evidence.json");
    await Promise.all([
      writeFile(devices, JSON.stringify(fixture.deviceRegistry)),
      writeFile(authorities, JSON.stringify(fixture.authorityRegistry)),
      writeFile(evidence, fixture.evidenceBytes),
    ]);
    const args = [script.pathname, devices, authorities, evidence, "--device-id", "receiver-01", "--now", NOW];
    const good = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr + good.stdout);
    assert.equal(JSON.parse(good.stdout).valid, true);
    assert.equal(JSON.parse(good.stdout).activeDeviceRegistryKeyId, "receiver-key-01");
    const linked = path.join(directory, "device-link.json");
    await symlink(devices, linked);
    const bad = spawnSync(process.execPath, [script.pathname, linked, authorities, evidence, "--device-id", "receiver-01", "--key-id", "receiver-key-01", "--now", NOW], { encoding: "utf8" });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /symlink/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
