import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildTrustRegistrySnapshotInventory,
  verifyTrustRegistrySnapshotInventory,
  validateTrustRegistrySnapshotInventoryEntries,
  MAX_TRUST_REGISTRY_SNAPSHOT_BYTES,
} from "../src/core/building-generation/trust-registry-snapshot.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");

function registry(recordType, registryId, entries = []) {
  return JSON.stringify({
    schemaVersion: "1.0.0",
    recordType,
    registryId,
    issuedAtUtc: "2026-11-01T00:00:00.000Z",
    expiresAtUtc: "2026-12-01T00:00:00.000Z",
    entries,
  });
}

function fixtures() {
  return {
    trustedSurveyorRegistry: registry("trusted-surveyor-public-key-registry", "surveyors-2026-q4"),
    trustedDeviceRegistry: registry("trusted-survey-device-public-key-registry", "devices-2026-q4"),
    trustedEnrollmentAuthorityRegistry: registry(
      "trusted-survey-device-enrollment-authority-public-key-registry",
      "enrollment-authorities-2026-q4",
    ),
  };
}

test("builds a deterministic three-role snapshot over the exact raw UTF-8 registry bytes", () => {
  const raw = fixtures();
  const snapshot = buildTrustRegistrySnapshotInventory(raw);

  assert.equal(snapshot.schemaVersion, "1.0.0");
  assert.equal(snapshot.count, 3);
  assert.deepEqual(snapshot.entries.map((entry) => entry.role), [
    "surveyor",
    "device",
    "enrollment-authority",
  ]);
  assert.deepEqual(snapshot.entries.map((entry) => entry.registryId), [
    "surveyors-2026-q4",
    "devices-2026-q4",
    "enrollment-authorities-2026-q4",
  ]);
  for (const [index, key] of [
    "trustedSurveyorRegistry",
    "trustedDeviceRegistry",
    "trustedEnrollmentAuthorityRegistry",
  ].entries()) {
    const bytes = Buffer.from(raw[key], "utf8");
    assert.equal(snapshot.entries[index].bytes, bytes.length);
    assert.equal(snapshot.entries[index].sha256, sha(bytes));
  }
  assert.equal(snapshot.totalBytes, snapshot.entries.reduce((sum, entry) => sum + entry.bytes, 0));
  assert.equal(snapshot.sha256, sha(Buffer.from(JSON.stringify(snapshot.entries), "utf8")));
  assert.deepEqual(buildTrustRegistrySnapshotInventory(raw), snapshot);
});

test("same registry ID with different raw bytes produces a different exact-byte snapshot", () => {
  const raw = fixtures();
  const first = buildTrustRegistrySnapshotInventory(raw);
  const changedWhitespace = {
    ...raw,
    trustedSurveyorRegistry: raw.trustedSurveyorRegistry + "\n",
  };
  const second = buildTrustRegistrySnapshotInventory(changedWhitespace);

  assert.equal(first.entries[0].registryId, second.entries[0].registryId);
  assert.notEqual(first.entries[0].sha256, second.entries[0].sha256);
  assert.notEqual(first.sha256, second.sha256);

  const verification = verifyTrustRegistrySnapshotInventory({
    metadata: {
      trustRegistrySnapshotSchemaVersion: first.schemaVersion,
      trustRegistrySnapshotCount: first.count,
      trustRegistrySnapshotBytes: first.totalBytes,
      trustRegistrySnapshotsSha256: first.sha256,
      trustRegistrySnapshots: first.entries,
    },
    ...changedWhitespace,
  });
  assert.equal(verification.valid, false);
  assert.equal(verification.checks.find((item) => item.id === "trust-registry-snapshot-digest").status, "failed");
});

test("verifies the complete inventory and rejects tampered snapshot metadata", () => {
  const raw = fixtures();
  const inventory = buildTrustRegistrySnapshotInventory(raw);
  const metadata = {
    trustRegistrySnapshotSchemaVersion: inventory.schemaVersion,
    trustRegistrySnapshotCount: inventory.count,
    trustRegistrySnapshotBytes: inventory.totalBytes,
    trustRegistrySnapshotsSha256: inventory.sha256,
    trustRegistrySnapshots: inventory.entries,
  };
  assert.equal(verifyTrustRegistrySnapshotInventory({ metadata, ...raw }).valid, true);

  for (const mutated of [
    { ...metadata, trustRegistrySnapshotSchemaVersion: "9.9.9" },
    { ...metadata, trustRegistrySnapshotCount: 2 },
    { ...metadata, trustRegistrySnapshotBytes: metadata.trustRegistrySnapshotBytes + 1 },
    { ...metadata, trustRegistrySnapshotsSha256: "f".repeat(64) },
    { ...metadata, trustRegistrySnapshots: metadata.trustRegistrySnapshots.map((entry, i) =>
      i === 1 ? { ...entry, sha256: "e".repeat(64) } : entry) },
    { ...metadata, trustRegistrySnapshots: [...metadata.trustRegistrySnapshots].reverse() },
    { ...metadata, trustRegistrySnapshots: metadata.trustRegistrySnapshots.map((entry, i) =>
      i === 2 ? { ...entry, extra: true } : entry) },
  ]) {
    assert.equal(verifyTrustRegistrySnapshotInventory({ metadata: mutated, ...raw }).valid, false);
  }
});

test("rejects missing, non-string, malformed, wrong-type and wrong-version registries", () => {
  const valid = fixtures();
  assert.throws(() => buildTrustRegistrySnapshotInventory({
    ...valid,
    trustedDeviceRegistry: null,
  }), /exact raw UTF-8 JSON string/);
  assert.throws(() => buildTrustRegistrySnapshotInventory({
    ...valid,
    trustedDeviceRegistry: { recordType: "trusted-survey-device-public-key-registry" },
  }), /exact raw UTF-8 JSON string/);
  assert.throws(() => buildTrustRegistrySnapshotInventory({
    ...valid,
    trustedDeviceRegistry: "{not-json",
  }), /valid JSON/);
  assert.throws(() => buildTrustRegistrySnapshotInventory({
    ...valid,
    trustedDeviceRegistry: registry("trusted-surveyor-public-key-registry", "wrong-role"),
  }), /unexpected record type/);
  assert.throws(() => buildTrustRegistrySnapshotInventory({
    ...valid,
    trustedDeviceRegistry: JSON.stringify({
      ...JSON.parse(valid.trustedDeviceRegistry),
      schemaVersion: "2.0.0",
    }),
  }), /unexpected record type/);
  assert.throws(() => buildTrustRegistrySnapshotInventory({
    ...valid,
    trustedEnrollmentAuthorityRegistry: registry(
      "trusted-survey-device-enrollment-authority-public-key-registry",
      "../unsafe",
    ),
  }), /unexpected record type/);
  assert.throws(() => buildTrustRegistrySnapshotInventory({
    ...valid,
    trustedOtherRegistry: valid.trustedDeviceRegistry,
  }), /exactly the surveyor, device and enrollment-authority registries/);
});

test("requires different registry IDs for the three independent trust roles", () => {
  const raw = fixtures();
  raw.trustedEnrollmentAuthorityRegistry = registry(
    "trusted-survey-device-enrollment-authority-public-key-registry",
    "devices-2026-q4",
  );
  assert.throws(() => buildTrustRegistrySnapshotInventory(raw), /distinct registry IDs/);

  const repeatedEntry = [
    {
      role: "surveyor",
      recordType: "trusted-surveyor-public-key-registry",
      registryId: "same-id",
      schemaVersion: "1.0.0",
      sha256: "a".repeat(64),
      bytes: 10,
    },
    {
      role: "device",
      recordType: "trusted-survey-device-public-key-registry",
      registryId: "same-id",
      schemaVersion: "1.0.0",
      sha256: "b".repeat(64),
      bytes: 10,
    },
    {
      role: "enrollment-authority",
      recordType: "trusted-survey-device-enrollment-authority-public-key-registry",
      registryId: "authority-id",
      schemaVersion: "1.0.0",
      sha256: "c".repeat(64),
      bytes: 10,
    },
  ];
  assert.throws(() => validateTrustRegistrySnapshotInventoryEntries(repeatedEntry), /invalid or out of canonical order/);
});

test("enforces per-registry raw byte bounds and strict schema shape", async () => {
  const raw = fixtures();
  const padded = raw.trustedSurveyorRegistry + " ".repeat(
    MAX_TRUST_REGISTRY_SNAPSHOT_BYTES - Buffer.byteLength(raw.trustedSurveyorRegistry, "utf8"),
  );
  const exactBound = buildTrustRegistrySnapshotInventory({
    ...raw,
    trustedSurveyorRegistry: padded,
  });
  assert.equal(exactBound.entries[0].bytes, MAX_TRUST_REGISTRY_SNAPSHOT_BYTES);
  assert.throws(() => buildTrustRegistrySnapshotInventory({
    ...raw,
    trustedSurveyorRegistry: padded + " ",
  }), /1–64 KiB/);

  const schema = JSON.parse(await readFile(
    new URL("../trust-registry-snapshot-inventory.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.trustRegistrySnapshotCount.const, 3);
  assert.equal(schema.properties.trustRegistrySnapshots.minItems, 3);
  assert.equal(schema.properties.trustRegistrySnapshots.maxItems, 3);
});
