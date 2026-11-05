import {
  createNextTrustRegistryGovernanceState,
  createTrustRegistryGovernanceInitialState,
  validateTrustRegistryGovernanceState,
} from "./trust-registry-governance-state.mjs";

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const VERSION_TOKEN = /^[A-Za-z0-9._~:-]{1,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new TypeError(label + " must be an object.");
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)) ||
      keys.some((key) => !expected.includes(key))) {
    throw new TypeError(label + " must contain exactly: " + expected.join(", ") + ".");
  }
}

function assertIdentity(identity) {
  if (!isObject(identity) ||
      typeof identity.registrySetId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(identity.registrySetId) ||
      typeof identity.governanceKeyFingerprintSha256 !== "string" ||
      !HASH.test(identity.governanceKeyFingerprintSha256)) {
    throw new TypeError("External governance store identity is invalid.");
  }
  return Object.freeze({
    registrySetId: identity.registrySetId,
    governanceKeyFingerprintSha256: identity.governanceKeyFingerprintSha256,
  });
}

function validateSnapshot(value, identity, label) {
  exactKeys(value, ["version", "state", "anchor"], label);
  if (typeof value.version !== "string" || !VERSION_TOKEN.test(value.version)) {
    throw new TypeError(label + " version token is invalid.");
  }
  const state = validateTrustRegistryGovernanceState(value.state, identity);
  exactKeys(value.anchor, ["revision", "minimumAcceptedSequence", "stateSha256"], label + " anchor");
  if (!Number.isSafeInteger(value.anchor.revision) || value.anchor.revision < 0 ||
      !Number.isSafeInteger(value.anchor.minimumAcceptedSequence) ||
      value.anchor.minimumAcceptedSequence < 1 ||
      typeof value.anchor.stateSha256 !== "string" || !HASH.test(value.anchor.stateSha256)) {
    throw new TypeError(label + " anchor fields are invalid.");
  }
  if (value.anchor.revision !== state.revision ||
      value.anchor.minimumAcceptedSequence !== state.minimumAcceptedSequence ||
      value.anchor.stateSha256 !== state.stateSha256) {
    throw new Error(label + " does not match the independent monotonic anchor; possible state rollback or substitution.");
  }
  return Object.freeze({
    version: value.version,
    state,
    anchor: Object.freeze({
      revision: value.anchor.revision,
      minimumAcceptedSequence: value.anchor.minimumAcceptedSequence,
      stateSha256: value.anchor.stateSha256,
    }),
  });
}

function validateWriteResult(value, flag, identity, label) {
  exactKeys(value, [flag, "version", "state", "anchor"], label);
  if (typeof value[flag] !== "boolean") throw new TypeError(label + " " + flag + " flag is invalid.");
  const snapshot = validateSnapshot({
    version: value.version,
    state: value.state,
    anchor: value.anchor,
  }, identity, label);
  return { [flag]: value[flag], ...snapshot };
}

function assertBootstrapFloor(state, bootstrapMinimumSequence) {
  if (bootstrapMinimumSequence === null || bootstrapMinimumSequence === undefined ||
      bootstrapMinimumSequence === "") {
    throw new Error("External governance state bootstrap requires an explicit operator minimum sequence.");
  }
  const floor = Number(bootstrapMinimumSequence);
  if (!Number.isSafeInteger(floor) || floor < 1) {
    throw new TypeError("External governance bootstrap minimum sequence must be a positive safe integer.");
  }
  if (state.minimumAcceptedSequence < floor) {
    throw new Error("External governance provider returned a state below the configured operator floor.");
  }
}

/**
 * Adapts an operator-supplied provider to the D3M-22 state-store contract.
 *
 * Provider methods:
 * - readState(identity) -> null | { version, state, anchor }
 * - initializeStateIfAbsent({ identity, state }) -> { created, version, state, anchor }
 * - compareAndSetState({ identity, expectedVersion, expectedStateSha256, nextState })
 *     -> { updated, version, state, anchor }
 *
 * The anchor must come from a separately rollback-resistant monotonic facility.
 * This adapter verifies anchor/state agreement but cannot prove the provider's
 * implementation, custody, linearizability, or durability.
 */
export function createExternalTrustRegistryGovernanceStateStore({ provider }) {
  if (!isObject(provider) ||
      typeof provider.providerId !== "string" ||
      !PROVIDER_ID.test(provider.providerId) ||
      typeof provider.readState !== "function" ||
      typeof provider.initializeStateIfAbsent !== "function" ||
      typeof provider.compareAndSetState !== "function") {
    throw new TypeError("External governance provider must expose a safe providerId and all three store methods.");
  }

  const providerId = provider.providerId;

  async function read(identity) {
    const result = await provider.readState(identity);
    if (result === null) return null;
    return validateSnapshot(result, identity, "External governance provider read");
  }

  return Object.freeze({
    providerId,

    async loadOrInitialize({
      registrySetId,
      governanceKeyFingerprintSha256,
      bootstrapMinimumSequence = null,
      now,
    }) {
      const identity = assertIdentity({ registrySetId, governanceKeyFingerprintSha256 });
      const existing = await read(identity);
      if (existing) {
        assertBootstrapFloor(existing.state, bootstrapMinimumSequence);
        return { state: existing.state, version: existing.version, created: false, providerId };
      }
      const initialState = createTrustRegistryGovernanceInitialState({
        ...identity,
        bootstrapMinimumSequence,
        now,
      });
      const result = validateWriteResult(
        await provider.initializeStateIfAbsent({ identity, state: initialState }),
        "created",
        identity,
        "External governance provider initialize",
      );
      if (result.created && result.state.stateSha256 !== initialState.stateSha256) {
        throw new Error("External governance provider initialized a different state than requested.");
      }
      assertBootstrapFloor(result.state, bootstrapMinimumSequence);
      return { state: result.state, version: result.version, created: result.created, providerId };
    },

    async advance({
      registrySetId,
      governanceKeyFingerprintSha256,
      expectedRevision,
      expectedVersion,
      acceptedSequence,
      acceptedAttestationSha256,
      acceptedSnapshotSha256,
      now,
    }) {
      const identity = assertIdentity({ registrySetId, governanceKeyFingerprintSha256 });
      if (typeof expectedVersion !== "string" || !VERSION_TOKEN.test(expectedVersion)) {
        throw new TypeError("Expected external provider version token is invalid.");
      }
      const current = await read(identity);
      if (!current) throw new Error("External governance provider state disappeared before compare-and-set.");
      if (current.version !== expectedVersion) {
        throw new Error("External governance provider version conflict; stale state snapshot rejected.");
      }
      const next = createNextTrustRegistryGovernanceState({
        current: current.state,
        ...identity,
        expectedRevision,
        acceptedSequence,
        acceptedAttestationSha256,
        acceptedSnapshotSha256,
        now,
      });
      if (!next.changed) {
        return { state: current.state, version: current.version, changed: false, providerId };
      }

      const result = validateWriteResult(
        await provider.compareAndSetState({
          identity,
          expectedVersion: current.version,
          expectedStateSha256: current.state.stateSha256,
          nextState: next.state,
        }),
        "updated",
        identity,
        "External governance provider compare-and-set",
      );
      if (!result.updated) {
        throw new Error("External governance provider compare-and-set conflict.");
      }
      if (result.version === current.version) {
        throw new Error("External governance provider did not advance its version token after a successful write.");
      }
      if (result.state.stateSha256 !== next.state.stateSha256) {
        throw new Error("External governance provider persisted a state different from the requested transition.");
      }
      return { state: result.state, version: result.version, changed: true, providerId };
    },
  });
}
