import assert from "node:assert/strict";
import test from "node:test";
import { runTrustRegistryGovernanceProviderConformance } from "./helpers/trust-registry-governance-provider-conformance.mjs";

const clone = (value) => structuredClone(value);

function createBarrier(parties) {
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === parties) release();
    await ready;
  };
}

function syntheticProvider({
  ignoreCompareAndSetVersion = false,
  staleConflictReturnsWrongVersion = false,
  raceInitializeIfAbsent = false,
  raceCompareAndSet = false,
  ignoreRegistryIdentity = false,
  corruptAnchor = false,
  reuseVersionOnWrite = false,
  cycleVersionOnSecondWrite = false,
  rollbackAnchorOnCompareAndSet = false,
} = {}) {
  const records = new Map();
  const identityKey = (identity) => JSON.stringify([
    identity.registrySetId,
    identity.governanceKeyFingerprintSha256,
  ]);
  const lookupRecord = (identity) => records.get(identityKey(identity)) ??
    (ignoreRegistryIdentity ? records.values().next().value : undefined);
  const version = (record) => cycleVersionOnSecondWrite && record.generation >= 3
    ? "generation-1"
    : "generation-" + record.generation;
  const snapshot = (record) => ({
    version: version(record),
    state: clone(record.state),
    anchor: clone(record.anchor),
  });
  const assertIdentity = (record, identity) => {
    assert.equal(record.state.registrySetId, identity.registrySetId);
    assert.equal(record.state.governanceKeyFingerprintSha256,
      identity.governanceKeyFingerprintSha256);
  };
  const anchorFor = (next) => ({
    revision: next.revision,
    minimumAcceptedSequence: next.minimumAcceptedSequence,
    stateSha256: next.stateSha256,
  });
  const initializeBarrier = createBarrier(8);
  const compareAndSetBarrier = createBarrier(8);

  const createClient = () => ({
    providerId: "synthetic-conformance-provider",
    async readState(identity) {
      const record = lookupRecord(identity);
      if (!record) return null;
      if (!ignoreRegistryIdentity) assertIdentity(record, identity);
      return snapshot(record);
    },
    async initializeStateIfAbsent({ identity, state: requestedState }) {
      const existing = lookupRecord(identity);
      if (existing) {
        if (!ignoreRegistryIdentity) assertIdentity(existing, identity);
        return { created: false, ...snapshot(existing) };
      }
      // In the intentionally broken fixture, all callers observe "empty"
      // before any caller is allowed to commit, exposing a check-then-write race.
      if (raceInitializeIfAbsent) await initializeBarrier();
      const record = {
        state: clone(requestedState),
        anchor: null,
        generation: 1,
      };
      record.anchor = anchorFor(record.state);
      if (corruptAnchor) record.anchor.revision += 1;
      records.set(identityKey(identity), record);
      return { created: true, ...snapshot(record) };
    },
    async compareAndSetState({ identity, expectedVersion, expectedStateSha256, nextState }) {
      const record = lookupRecord(identity);
      if (!record) throw new Error("synthetic provider record is missing");
      if (!ignoreRegistryIdentity) assertIdentity(record, identity);
      if (!ignoreCompareAndSetVersion &&
          (expectedVersion !== version(record) || expectedStateSha256 !== record.state.stateSha256)) {
        const rejected = snapshot(record);
        if (staleConflictReturnsWrongVersion) rejected.version = "stale-replica-version";
        return { updated: false, ...rejected };
      }
      // Capture the matching version before yielding. A correct atomic provider
      // would serialize this region or use a storage-level conditional write.
      if (raceCompareAndSet) await compareAndSetBarrier();
      const previousAnchor = clone(record.anchor);
      record.state = clone(nextState);
      if (!reuseVersionOnWrite) record.generation += 1;
      record.anchor = rollbackAnchorOnCompareAndSet ? previousAnchor : anchorFor(record.state);
      if (corruptAnchor) record.anchor.revision += 1;
      return { updated: true, ...snapshot(record) };
    },
  });
  return { provider: createClient(), reopenProvider: async () => createClient() };
}

test("provider conformance suite accepts an atomic synthetic provider", async () => {
  const fixture = syntheticProvider();
  const report = await runTrustRegistryGovernanceProviderConformance(fixture);
  assert.deepEqual({
    initializeContenders: report.initializeContenders,
    initializeWinners: report.initializeWinners,
    casContenders: report.casContenders,
    casWinners: report.casWinners,
    staleCasRejected: report.staleCasRejected,
    freshProviderReopened: report.freshProviderReopened,
    freshReadMatched: report.freshReadMatched,
    ambiguousCommitRecovered: report.ambiguousCommitRecovered,
    preCommitTimeoutSafeRetry: report.preCommitTimeoutSafeRetry,
    ambiguousCompetingWinnerDetected: report.ambiguousCompetingWinnerDetected,
    identityIsolationVerified: report.identityIsolationVerified,
    finalRevision: report.finalRevision,
    finalMinimumAcceptedSequence: report.finalMinimumAcceptedSequence,
  }, {
    initializeContenders: 8,
    initializeWinners: 1,
    casContenders: 8,
    casWinners: 1,
    staleCasRejected: true,
    freshProviderReopened: true,
    freshReadMatched: true,
    ambiguousCommitRecovered: true,
    preCommitTimeoutSafeRetry: true,
    ambiguousCompetingWinnerDetected: true,
    identityIsolationVerified: true,
    finalRevision: 4,
    finalMinimumAcceptedSequence: 9,
  });
});

test("provider conformance suite rejects a provider that permits competing stale CAS writers", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ ignoreCompareAndSetVersion: true }),
    }),
    /exactly one writer may win/i,
  );
});

test("provider conformance suite rejects a provider that aliases distinct registry identities", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ ignoreRegistryIdentity: true }),
    }),
    /distinct registry-set identity must not alias an existing governance state/i,
  );
});

test("provider conformance suite rejects stale CAS responses with the wrong provider version", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ staleConflictReturnsWrongVersion: true }),
    }),
    /losing compare-and-set callers must observe the winner's provider version/i,
  );
});

test("provider conformance suite detects a check-then-write initialization race", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ raceInitializeIfAbsent: true }),
    }),
    /exactly one concurrent initialize-if-absent operation/i,
  );
});

test("provider conformance suite detects a compare-and-set race after concurrent precondition reads", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ raceCompareAndSet: true }),
    }),
    /exactly one writer may win/i,
  );
});

test("provider conformance suite rejects a successful CAS without advancing its version token", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ reuseVersionOnWrite: true }),
    }),
    /successful compare-and-set must not reuse any prior provider version token/i,
  );
});

test("provider conformance suite rejects a provider that reuses a historical version token (ABA)", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ cycleVersionOnSecondWrite: true }),
    }),
    /must never reuse a historical version token \(ABA\)/i,
  );
});

test("provider conformance suite rejects an anchor rolled back behind the committed state", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ rollbackAnchorOnCompareAndSet: true }),
    }),
    /anchor must independently match the exact state/i,
  );
});

test("provider conformance suite rejects an anchor that does not bind its initial state", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      ...syntheticProvider({ corruptAnchor: true }),
    }),
    /anchor must independently match/i,
  );
});

test("provider conformance suite requires a newly constructed client on reopen", async () => {
  const fixture = syntheticProvider();
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      provider: fixture.provider,
      reopenProvider: async () => fixture.provider,
    }),
    /newly constructed client object/i,
  );
});

test("provider conformance suite rejects providers with missing contract methods", async () => {
  await assert.rejects(
    runTrustRegistryGovernanceProviderConformance({
      provider: { providerId: "incomplete-provider", readState() {} },
      reopenProvider: async () => ({ providerId: "incomplete-provider" }),
    }),
    /initializeStateIfAbsent/i,
  );
});
