import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createExternalTrustRegistryGovernanceStateStore } from "../src/core/building-generation/trust-registry-governance-external-store.mjs";

const IDENTITY = {
  registrySetId: "survey-trust-q4-2026",
  governanceKeyFingerprintSha256: "a".repeat(64),
};
const ATTESTATION_7 = createHash("sha256").update("attestation-7").digest("hex");
const SNAPSHOT_7 = createHash("sha256").update("snapshot-7").digest("hex");
const ATTESTATION_8 = createHash("sha256").update("attestation-8").digest("hex");
const SNAPSHOT_8 = createHash("sha256").update("snapshot-8").digest("hex");
const NOW = new Date("2026-11-05T12:00:00.000Z");
const clone = (value) => structuredClone(value);

function fakeProvider(overrides = {}) {
  let record = null;
  let generation = 0;
  const anchorFor = (state) => ({
    revision: state.revision,
    minimumAcceptedSequence: state.minimumAcceptedSequence,
    stateSha256: state.stateSha256,
  });
  const snapshot = () => clone(record);
  const provider = {
    providerId: "synthetic-remote-test",
    async readState(identity) {
      if (!record) return null;
      assert.equal(record.state.registrySetId, identity.registrySetId);
      assert.equal(record.state.governanceKeyFingerprintSha256,
        identity.governanceKeyFingerprintSha256);
      return snapshot();
    },
    async initializeStateIfAbsent({ state }) {
      if (record) return { created: false, ...snapshot() };
      generation += 1;
      record = { version: "generation-" + generation, state: clone(state), anchor: anchorFor(state) };
      return { created: true, ...snapshot() };
    },
    async compareAndSetState({ expectedVersion, expectedStateSha256, nextState }) {
      if (!record || record.version !== expectedVersion ||
          record.state.stateSha256 !== expectedStateSha256) {
        return { updated: false, ...snapshot() };
      }
      generation += 1;
      record = {
        version: "generation-" + generation,
        state: clone(nextState),
        anchor: anchorFor(nextState),
      };
      return { updated: true, ...snapshot() };
    },
    restoreStateWithoutAnchor(state) {
      if (!record) throw new Error("no state to restore");
      record.state = clone(state);
    },
    replaceRecord(next) {
      record = clone(next);
    },
    current() {
      return snapshot();
    },
  };
  return { provider: { ...provider, ...overrides }, controls: provider };
}

function storeFor(provider) {
  return createExternalTrustRegistryGovernanceStateStore({ provider });
}

async function initialize(store, floor = 5) {
  return store.loadOrInitialize({
    ...IDENTITY,
    bootstrapMinimumSequence: floor,
    now: NOW,
  });
}

async function advance(store, loaded, sequence = 7, attestation = ATTESTATION_7, snapshot = SNAPSHOT_7) {
  return store.advance({
    ...IDENTITY,
    expectedRevision: loaded.state.revision,
    expectedVersion: loaded.version,
    acceptedSequence: sequence,
    acceptedAttestationSha256: attestation,
    acceptedSnapshotSha256: snapshot,
    now: new Date("2026-11-05T12:01:00.000Z"),
  });
}

test("bootstraps once and advances state with a distinct independently checked anchor", async () => {
  const fixture = fakeProvider();
  const store = storeFor(fixture.provider);
  const initial = await initialize(store);
  assert.equal(initial.created, true);
  assert.equal(initial.state.minimumAcceptedSequence, 5);
  assert.equal(initial.state.revision, 0);
  assert.equal(initial.version, "generation-1");

  const advanced = await advance(store, initial, 7);
  assert.equal(advanced.changed, true);
  assert.equal(advanced.state.minimumAcceptedSequence, 7);
  assert.equal(advanced.state.revision, 1);
  assert.notEqual(advanced.version, initial.version);

  const restarted = await initialize(store);
  assert.equal(restarted.created, false);
  assert.equal(restarted.state.stateSha256, advanced.state.stateSha256);
  assert.equal(restarted.version, advanced.version);

  const restartedWithoutBootstrapFloor = await store.loadOrInitialize({ ...IDENTITY });
  assert.equal(restartedWithoutBootstrapFloor.created, false);
  assert.equal(restartedWithoutBootstrapFloor.state.stateSha256, advanced.state.stateSha256);
  assert.equal(restartedWithoutBootstrapFloor.version, advanced.version);
});

test("requires an operator bootstrap floor and never silently resets missing provider state", async () => {
  const fixture = fakeProvider();
  const store = storeFor(fixture.provider);
  await assert.rejects(
    store.loadOrInitialize({ ...IDENTITY }),
    /explicit operator minimum sequence/i,
  );
});

test("rejects stale external version tokens before attempting a state transition", async () => {
  const fixture = fakeProvider();
  const store = storeFor(fixture.provider);
  const initial = await initialize(store);
  const winner = await advance(store, initial, 7);
  await assert.rejects(
    advance(store, initial, 8, ATTESTATION_8, SNAPSHOT_8),
    /version conflict|stale state snapshot/i,
  );
  assert.equal((await initialize(store)).state.stateSha256, winner.state.stateSha256);
});

test("detects a restored old state document when the independent anchor remains newer", async () => {
  const fixture = fakeProvider();
  const store = storeFor(fixture.provider);
  const initial = await initialize(store);
  await advance(store, initial, 7);
  fixture.controls.restoreStateWithoutAnchor(initial.state);
  await assert.rejects(initialize(store), /independent monotonic anchor/i);
});

test("rejects an anchor that does not bind the exact state revision, floor and digest", async () => {
  const fixture = fakeProvider();
  const initial = await initialize(storeFor(fixture.provider));
  const current = fixture.controls.current();
  fixture.controls.replaceRecord({
    ...current,
    anchor: { ...current.anchor, minimumAcceptedSequence: initial.state.minimumAcceptedSequence + 1 },
  });
  await assert.rejects(initialize(storeFor(fixture.provider)), /independent monotonic anchor/i);
});

test("rejects a provider that reports success without advancing its opaque version", async () => {
  const fixture = fakeProvider();
  const goodStore = storeFor(fixture.provider);
  const initial = await initialize(goodStore);
  const staleVersionProvider = {
    ...fixture.provider,
    async compareAndSetState({ nextState }) {
      const current = fixture.controls.current();
      return {
        updated: true,
        version: current.version,
        state: nextState,
        anchor: {
          revision: nextState.revision,
          minimumAcceptedSequence: nextState.minimumAcceptedSequence,
          stateSha256: nextState.stateSha256,
        },
      };
    },
  };
  const store = storeFor(staleVersionProvider);
  await assert.rejects(
    advance(store, initial, 7),
    /did not advance its version token/i,
  );
});

test("rejects same-sequence equivocation and sequence downgrade", async () => {
  const fixture = fakeProvider();
  const store = storeFor(fixture.provider);
  const initial = await initialize(store);
  const accepted = await advance(store, initial, 7);
  await assert.rejects(
    advance(store, accepted, 7, ATTESTATION_8, SNAPSHOT_8),
    /cannot be reused/i,
  );
  await assert.rejects(
    advance(store, accepted, 6, ATTESTATION_8, SNAPSHOT_8),
    /downgrade/i,
  );
});

test("requires a safe provider identity and all atomic store methods", () => {
  assert.throws(() => storeFor({ providerId: "bad id" }), /providerId/i);
  assert.throws(() => storeFor({
    providerId: "missing-cas",
    readState() {},
    initializeStateIfAbsent() {},
  }), /all three store methods/i);
});
