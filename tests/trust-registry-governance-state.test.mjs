import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  advanceTrustRegistryGovernanceState,
  loadOrInitializeTrustRegistryGovernanceState,
} from "../src/core/building-generation/trust-registry-governance-state.mjs";

const REGISTRY_SET_ID = "survey-trust-q4-2026";
const KEY_FINGERPRINT = "a".repeat(64);
const ATTESTATION_7 = createHash("sha256").update("attestation-7").digest("hex");
const SNAPSHOT_7 = createHash("sha256").update("snapshot-7").digest("hex");
const ATTESTATION_8 = createHash("sha256").update("attestation-8").digest("hex");
const SNAPSHOT_8 = createHash("sha256").update("snapshot-8").digest("hex");
const NOW = new Date("2026-11-05T12:00:00.000Z");

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "d3m22-governance-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, stateFilePath: path.join(directory, "governance-state.json") };
}

async function bootstrap(stateFilePath, overrides = {}) {
  return loadOrInitializeTrustRegistryGovernanceState({
    stateFilePath,
    registrySetId: REGISTRY_SET_ID,
    governanceKeyFingerprintSha256: KEY_FINGERPRINT,
    bootstrapMinimumSequence: 5,
    now: NOW,
    ...overrides,
  });
}

async function advance(stateFilePath, expectedRevision, sequence, attestationHash, snapshotHash, overrides = {}) {
  return advanceTrustRegistryGovernanceState({
    stateFilePath,
    registrySetId: REGISTRY_SET_ID,
    governanceKeyFingerprintSha256: KEY_FINGERPRINT,
    expectedRevision,
    acceptedSequence: sequence,
    acceptedAttestationSha256: attestationHash,
    acceptedSnapshotSha256: snapshotHash,
    now: new Date("2026-11-05T12:01:00.000Z"),
    ...overrides,
  });
}

test("bootstraps once from an explicit operator floor and persists across reload", async (t) => {
  const { stateFilePath } = await fixture(t);
  const initial = await bootstrap(stateFilePath);
  assert.equal(initial.created, true);
  assert.equal(initial.state.minimumAcceptedSequence, 5);
  assert.equal(initial.state.revision, 0);
  assert.equal(initial.state.lastAcceptedAttestationSha256, null);
  assert.equal(initial.state.previousStateSha256, null);

  const reloaded = await loadOrInitializeTrustRegistryGovernanceState({
    stateFilePath,
    registrySetId: REGISTRY_SET_ID,
    governanceKeyFingerprintSha256: KEY_FINGERPRINT,
  });
  assert.equal(reloaded.created, false);
  assert.deepEqual(reloaded.state, initial.state);
});

test("atomically advances the floor and links the prior state digest", async (t) => {
  const { stateFilePath } = await fixture(t);
  const initial = await bootstrap(stateFilePath);
  const advanced = await advance(
    stateFilePath, initial.state.revision, 7, ATTESTATION_7, SNAPSHOT_7,
  );
  assert.equal(advanced.changed, true);
  assert.equal(advanced.state.minimumAcceptedSequence, 7);
  assert.equal(advanced.state.revision, 1);
  assert.equal(advanced.state.previousStateSha256, initial.state.stateSha256);
  assert.equal(advanced.state.lastAcceptedAttestationSha256, ATTESTATION_7);
  assert.equal(advanced.state.lastAcceptedSnapshotSha256, SNAPSHOT_7);

  const restarted = await bootstrap(stateFilePath);
  assert.equal(restarted.state.minimumAcceptedSequence, 7);
  assert.equal(restarted.state.stateSha256, advanced.state.stateSha256);
});

test("rejects a lower sequence and leaves the persisted floor unchanged", async (t) => {
  const { stateFilePath } = await fixture(t);
  const initial = await bootstrap(stateFilePath);
  const accepted = await advance(stateFilePath, initial.state.revision, 7, ATTESTATION_7, SNAPSHOT_7);
  await assert.rejects(
    advance(stateFilePath, accepted.state.revision, 6, ATTESTATION_8, SNAPSHOT_8),
    /downgrade/,
  );
  const current = await bootstrap(stateFilePath);
  assert.equal(current.state.minimumAcceptedSequence, 7);
  assert.equal(current.state.stateSha256, accepted.state.stateSha256);
});

test("rejects an equivocated statement reusing the current sequence", async (t) => {
  const { stateFilePath } = await fixture(t);
  const initial = await bootstrap(stateFilePath);
  const accepted = await advance(stateFilePath, initial.state.revision, 7, ATTESTATION_7, SNAPSHOT_7);
  await assert.rejects(
    advance(stateFilePath, accepted.state.revision, 7, ATTESTATION_8, SNAPSHOT_8),
    /reused/,
  );
  const idempotent = await advance(
    stateFilePath, accepted.state.revision, 7, ATTESTATION_7, SNAPSHOT_7,
  );
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.state.stateSha256, accepted.state.stateSha256);
});

test("rejects stale compare-and-set revisions after a concurrent writer advances state", async (t) => {
  const { stateFilePath } = await fixture(t);
  const initial = await bootstrap(stateFilePath);
  await advance(stateFilePath, initial.state.revision, 7, ATTESTATION_7, SNAPSHOT_7);
  await assert.rejects(
    advance(stateFilePath, initial.state.revision, 8, ATTESTATION_8, SNAPSHOT_8),
    /revision conflict/,
  );
});

test("rejects registry-set and governance-key substitution", async (t) => {
  const { stateFilePath } = await fixture(t);
  await bootstrap(stateFilePath);
  await assert.rejects(
    loadOrInitializeTrustRegistryGovernanceState({
      stateFilePath,
      registrySetId: "other-registry-set",
      governanceKeyFingerprintSha256: KEY_FINGERPRINT,
    }),
    /different registry set/,
  );
  await assert.rejects(
    loadOrInitializeTrustRegistryGovernanceState({
      stateFilePath,
      registrySetId: REGISTRY_SET_ID,
      governanceKeyFingerprintSha256: "b".repeat(64),
    }),
    /different registry set or pinned key/,
  );
});

test("does not silently bootstrap over a missing bootstrap floor", async (t) => {
  const { stateFilePath } = await fixture(t);
  await assert.rejects(
    loadOrInitializeTrustRegistryGovernanceState({
      stateFilePath,
      registrySetId: REGISTRY_SET_ID,
      governanceKeyFingerprintSha256: KEY_FINGERPRINT,
    }),
    /explicit operator bootstrap floor/,
  );
});

test("fails closed for corrupt state rather than resetting its sequence", async (t) => {
  const { stateFilePath } = await fixture(t);
  await bootstrap(stateFilePath);
  const original = JSON.parse(await readFile(stateFilePath, "utf8"));
  original.minimumAcceptedSequence = 1;
  await writeFile(stateFilePath, JSON.stringify(original) + "\n", { mode: 0o600 });
  await assert.rejects(bootstrap(stateFilePath), /digest verification failed/);
});

test("rejects symlinked and group/world-readable state files", async (t) => {
  const { directory, stateFilePath } = await fixture(t);
  const target = path.join(directory, "real-state.json");
  await bootstrap(target);
  await symlink(target, stateFilePath);
  await assert.rejects(bootstrap(stateFilePath), /non-symlink/);

  await rm(stateFilePath);
  await writeFile(stateFilePath, await readFile(target), { mode: 0o644 });
  await chmod(stateFilePath, 0o644);
  await assert.rejects(bootstrap(stateFilePath), /permissions must be private/);
});

test("lock contention fails closed instead of racing a second writer", async (t) => {
  const { stateFilePath } = await fixture(t);
  await bootstrap(stateFilePath);
  await writeFile(stateFilePath + ".lock", "owned by another process", { mode: 0o600 });
  await assert.rejects(bootstrap(stateFilePath), /locked by another operation/);
});

test("governance state JSON Schema is strict and documents the local-file trust boundary", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../trust-registry-governance-state.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.minimumAcceptedSequence.minimum, 1);
  assert.match(schema.description, /cannot resist hostile filesystem snapshot rollback/);
});
