import assert from "node:assert/strict";
import test from "node:test";
import { runTrustRegistryGovernanceProviderConformance } from "./helpers/trust-registry-governance-provider-conformance.mjs";

const clone = (value) => structuredClone(value);

function syntheticProvider({ ignoreCompareAndSetVersion = false, corruptAnchor = false } = {}) {
  let state = null;
  let anchor = null;
  let generation = 0;
  const version = () => "generation-" + generation;
  const snapshot = () => state === null ? null : ({
    version: version(),
    state: clone(state),
    anchor: clone(anchor),
  });
  const assertIdentity = (identity) => {
    assert.equal(state?.registrySetId, identity.registrySetId);
    assert.equal(state?.governanceKeyFingerprintSha256,
      identity.governanceKeyFingerprintSha256);
  };
  const anchorFor = (next) => ({
    revision: next.revision,
    minimumAcceptedSequence: next.minimumAcceptedSequence,
    stateSha256: next.stateSha256,
  });

  const createClient = () => ({
    providerId: "synthetic-conformance-provider",
    async readState(identity) {
      if (state === null) return null;
      assertIdentity(identity);
      return snapshot();
    },
    async initializeStateIfAbsent({ identity, state: requestedState }) {
      if (state !== null) {
        assertIdentity(identity);
        return { created: false, ...snapshot() };
      }
      state = clone(requestedState);
      generation += 1;
      anchor = anchorFor(state);
      if (corruptAnchor) anchor.revision += 1;
      return { created: true, ...snapshot() };
    },
    async compareAndSetState({ identity, expectedVersion, expectedStateSha256, nextState }) {
      assertIdentity(identity);
      if (!ignoreCompareAndSetVersion &&
          (expectedVersion !== version() || expectedStateSha256 !== state.stateSha256)) {
        return { updated: false, ...snapshot() };
      }
      state = clone(nextState);
      generation += 1;
      anchor = anchorFor(state);
      if (corruptAnchor) anchor.revision += 1;
      return { updated: true, ...snapshot() };
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
    finalRevision: 2,
    finalMinimumAcceptedSequence: 7,
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
