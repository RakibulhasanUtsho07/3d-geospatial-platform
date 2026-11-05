import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  createNextTrustRegistryGovernanceState,
  createTrustRegistryGovernanceInitialState,
  validateTrustRegistryGovernanceState,
} from "../../src/core/building-generation/trust-registry-governance-state.mjs";

const VERSION = /^[A-Za-z0-9._~:-]{1,256}$/;
const clone = (value) => structuredClone(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label + " must be an object");
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label + " must have exact fields");
}

function assertSnapshot(value, identity, label) {
  exactKeys(value, ["version", "state", "anchor"], label);
  assert.equal(typeof value.version, "string", label + " version must be a string");
  assert.match(value.version, VERSION, label + " version token must be opaque and bounded");
  const state = validateTrustRegistryGovernanceState(value.state, identity);
  exactKeys(value.anchor, ["revision", "minimumAcceptedSequence", "stateSha256"], label + " anchor");
  assert.deepEqual(value.anchor, {
    revision: state.revision,
    minimumAcceptedSequence: state.minimumAcceptedSequence,
    stateSha256: state.stateSha256,
  }, label + " anchor must independently match the exact state");
  return { version: value.version, state, anchor: clone(value.anchor) };
}

function assertWriteResult(value, flag, identity, label) {
  exactKeys(value, [flag, "version", "state", "anchor"], label);
  assert.equal(typeof value[flag], "boolean", label + " result flag must be boolean");
  return { [flag]: value[flag], ...assertSnapshot({
    version: value.version,
    state: value.state,
    anchor: value.anchor,
  }, identity, label) };
}

/**
 * Exercise the D3M-23 provider contract against a dedicated, unique identity.
 * The provider must route each identity to an isolated record and implement
 * atomic initialize-if-absent and compare-and-set operations.
 *
 * This is a conformance harness, not proof of a provider's physical durability,
 * independent anchor custody, deployment configuration or security controls.
 */
export async function runTrustRegistryGovernanceProviderConformance({
  provider,
  reopenProvider,
  bootstrapMinimumSequence = 5,
} = {}) {
  const assertProvider = (candidate, label) => {
    assert.ok(candidate && typeof candidate === "object", label + " is required");
    assert.match(candidate.providerId ?? "", /^[a-z0-9][a-z0-9._-]{0,79}$/,
      label + " providerId must be a safe stable identifier");
    for (const method of ["readState", "initializeStateIfAbsent", "compareAndSetState"]) {
      assert.equal(typeof candidate[method], "function", label + " must implement " + method);
    }
  };
  assertProvider(provider, "provider");
  assert.equal(typeof reopenProvider, "function",
    "reopenProvider must construct a fresh client for the same isolated backend");
  assert.ok(Number.isSafeInteger(bootstrapMinimumSequence + 2),
    "bootstrapMinimumSequence must leave room for two monotonic test transitions");
  assert.ok(Number.isSafeInteger(bootstrapMinimumSequence) && bootstrapMinimumSequence > 0,
    "bootstrapMinimumSequence must be a positive safe integer");

  const nonce = randomUUID();
  const identity = Object.freeze({
    registrySetId: "provider-conformance-" + nonce,
    governanceKeyFingerprintSha256: sha256("D3M-24 provider conformance " + nonce),
  });
  const initialState = createTrustRegistryGovernanceInitialState({
    ...identity,
    bootstrapMinimumSequence,
    now: new Date("2026-11-05T12:00:00.000Z"),
  });

  assert.equal(await provider.readState(identity), null,
    "a fresh conformance identity must not contain pre-existing state");

  // A concurrent bootstrap must produce exactly one creator and one shared record.
  const initializeResults = await Promise.all(Array.from({ length: 8 }, () =>
    provider.initializeStateIfAbsent({ identity, state: clone(initialState) })));
  const initialized = initializeResults.map((result, index) =>
    assertWriteResult(result, "created", identity, "initialize result " + index));
  assert.equal(initialized.filter((result) => result.created).length, 1,
    "exactly one concurrent initialize-if-absent operation must create the record");
  const first = initialized[0];
  for (const result of initialized) {
    assert.equal(result.version, first.version, "all initializers must observe one version");
    assert.equal(result.state.stateSha256, initialState.stateSha256,
      "all initializers must observe the requested initial state");
    assert.deepEqual(result.anchor, first.anchor, "all initializers must observe one anchor");
  }

  const afterInitialize = assertSnapshot(
    await provider.readState(identity), identity, "read-after-initialize",
  );
  assert.equal(afterInitialize.state.stateSha256, initialState.stateSha256);

  const next = createNextTrustRegistryGovernanceState({
    current: afterInitialize.state,
    ...identity,
    expectedRevision: afterInitialize.state.revision,
    acceptedSequence: bootstrapMinimumSequence + 1,
    acceptedAttestationSha256: sha256("D3M-24 attestation A " + nonce),
    acceptedSnapshotSha256: sha256("D3M-24 registry snapshot A " + nonce),
    now: new Date("2026-11-05T12:01:00.000Z"),
  }).state;

  // Competing CAS writers with the same token must have one winner at most.
  const casPayload = {
    identity,
    expectedVersion: afterInitialize.version,
    expectedStateSha256: afterInitialize.state.stateSha256,
    nextState: clone(next),
  };
  const casResults = await Promise.all(Array.from({ length: 8 }, () =>
    provider.compareAndSetState(clone(casPayload))));
  const committed = casResults.map((result, index) =>
    assertWriteResult(result, "updated", identity, "CAS result " + index));
  assert.equal(committed.filter((result) => result.updated).length, 1,
    "exactly one writer may win a compare-and-set race");
  const winner = committed.find((result) => result.updated);
  assert.notEqual(winner.version, afterInitialize.version,
    "a successful compare-and-set must advance the provider version token");
  for (const result of committed) {
    assert.equal(result.state.stateSha256, next.stateSha256,
      "losing writers must observe the committed state, not overwrite it");
    assert.deepEqual(result.anchor, winner.anchor,
      "losing writers must observe the winner's anchor");
  }

  // A stale version must not mutate the record after the winning CAS.
  const stale = assertWriteResult(await provider.compareAndSetState(casPayload),
    "updated", identity, "stale CAS result");
  assert.equal(stale.updated, false, "a stale version token must be rejected");
  assert.equal(stale.state.stateSha256, next.stateSha256,
    "stale CAS must preserve the winning state");

  // Reconstruct a client and verify that its read observes the same backing record.
  // A provider-specific integration may implement reopenProvider across a process boundary.
  const reopenedProvider = await reopenProvider();
  assertProvider(reopenedProvider, "reopened provider");
  assert.equal(reopenedProvider.providerId, provider.providerId,
    "a reopened client must address the same provider identity");
  const reloaded = assertSnapshot(
    await reopenedProvider.readState(identity), identity, "reopened-client read",
  );
  assert.equal(reloaded.state.stateSha256, next.stateSha256,
    "a fresh read must observe the committed state and its anchor");
  assert.equal(reloaded.version, winner.version);

  // Simulate a lost response after the provider commits. Recovery is a read,
  // never a blind replay using a new expected version.
  const nextAfterAmbiguous = createNextTrustRegistryGovernanceState({
    current: reloaded.state,
    ...identity,
    expectedRevision: reloaded.state.revision,
    acceptedSequence: bootstrapMinimumSequence + 2,
    acceptedAttestationSha256: sha256("D3M-24 attestation B " + nonce),
    acceptedSnapshotSha256: sha256("D3M-24 registry snapshot B " + nonce),
    now: new Date("2026-11-05T12:02:00.000Z"),
  }).state;
  let responseWasLost = false;
  try {
    const committedBeforeDisconnect = assertWriteResult(
      await reopenedProvider.compareAndSetState({
        identity,
        expectedVersion: reloaded.version,
        expectedStateSha256: reloaded.state.stateSha256,
        nextState: clone(nextAfterAmbiguous),
      }),
      "updated",
      identity,
      "ambiguous-write result",
    );
    assert.equal(committedBeforeDisconnect.updated, true,
      "the simulated ambiguous write must commit before its response is lost");
    responseWasLost = true;
    throw Object.assign(new Error("synthetic response lost after commit"), {
      code: "D3M24_SIMULATED_RESPONSE_LOST",
    });
  } catch (error) {
    assert.equal(error.code, "D3M24_SIMULATED_RESPONSE_LOST",
      "the synthetic transport fault must be the only swallowed failure");
  }
  assert.equal(responseWasLost, true);
  const recovered = assertSnapshot(
    await reopenedProvider.readState(identity), identity, "ambiguous-write recovery read",
  );
  assert.equal(recovered.state.stateSha256, nextAfterAmbiguous.stateSha256,
    "recovery read must identify the exact committed transition before any retry");
  assert.notEqual(recovered.version, reloaded.version);
  assert.equal(recovered.state.revision, reloaded.state.revision + 1);

  return Object.freeze({
    providerId: provider.providerId,
    initializeContenders: initializeResults.length,
    initializeWinners: 1,
    casContenders: casResults.length,
    casWinners: 1,
    staleCasRejected: !stale.updated,
    freshProviderReopened: reopenedProvider !== provider,
    freshReadMatched: recovered.state.stateSha256 === nextAfterAmbiguous.stateSha256,
    ambiguousCommitRecovered: responseWasLost,
    finalRevision: recovered.state.revision,
    finalMinimumAcceptedSequence: recovered.state.minimumAcceptedSequence,
  });
}
