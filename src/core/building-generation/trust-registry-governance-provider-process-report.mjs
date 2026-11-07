const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const EXECUTION_MODE = "fresh-node-child-process-per-provider-operation";
const TRUST_BOUNDARY = "Software conformance only. Adapter declarations are not independently authenticated. This report does not prove provider deployment, independent anchor custody, rollback resistance, security controls or production durability.";

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be an object");
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(label + " has an unsupported or missing field");
  }
}

function requireHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(label + " must be a lowercase SHA-256 digest");
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(label + " must be a positive safe integer");
  }
}

const CONFORMANCE_KEYS = Object.freeze([
  "providerId",
  "initializeContenders",
  "initializeWinners",
  "casContenders",
  "casWinners",
  "staleCasRejected",
  "freshProviderReopened",
  "freshReadMatched",
  "ambiguousCommitRecovered",
  "preCommitTimeoutSafeRetry",
  "ambiguousCompetingWinnerDetected",
  "identityIsolationVerified",
  "finalRevision",
  "finalMinimumAcceptedSequence",
]);

/**
 * Validate the semantics of a D3M-26 report before D3M-25 accepts it as
 * process-restart evidence. The report remains an operator-supplied claim:
 * byte integrity and these structural checks do not authenticate the provider
 * or prove its independent anchor is physically/logically independent.
 */
export function validateTrustRegistryGovernanceProviderProcessReport(input, expected = {}) {
  exactKeys(expected, [
    "sourceCommitSha",
    "providerId",
    "adapterModuleSha256",
    "syntheticOnly",
    "instanceFingerprintSha256",
    "namespaceFingerprintSha256",
  ], "expected provider process context");
  exactKeys(input, [
    "schemaVersion",
    "sourceCommitSha",
    "providerId",
    "adapterModuleSha256",
    "adapterDeclaredSyntheticOnly",
    "providerInstanceFingerprintSha256",
    "providerNamespaceFingerprintSha256",
    "executionMode",
    "processIsolationVerified",
    "workerProcessesStarted",
    "uniqueWorkerInstances",
    "uniqueWorkerProcessIds",
    "conformance",
    "trustBoundary",
  ], "provider process report");

  if (input.schemaVersion !== "1.1.0") throw new TypeError("provider process report schemaVersion must be 1.1.0");
  if (typeof input.sourceCommitSha !== "string" || !COMMIT.test(input.sourceCommitSha) ||
      input.sourceCommitSha !== expected.sourceCommitSha) {
    throw new TypeError("provider process report source commit does not match the qualification source");
  }
  if (typeof input.providerId !== "string" || !PROVIDER_ID.test(input.providerId) ||
      input.providerId !== expected.providerId) {
    throw new TypeError("provider process report provider ID does not match the provisioned provider");
  }
  const adapterModuleSha256 = requireHash(input.adapterModuleSha256, "adapterModuleSha256");
  if (adapterModuleSha256 !== expected.adapterModuleSha256) {
    throw new TypeError("provider process report adapter hash does not match the provisioned adapter");
  }
  if (typeof input.adapterDeclaredSyntheticOnly !== "boolean" ||
      input.adapterDeclaredSyntheticOnly !== expected.syntheticOnly) {
    throw new TypeError("provider process report synthetic declaration does not match the provider record");
  }
  const providerInstanceFingerprintSha256 = requireHash(
    input.providerInstanceFingerprintSha256, "providerInstanceFingerprintSha256",
  );
  const providerNamespaceFingerprintSha256 = requireHash(
    input.providerNamespaceFingerprintSha256, "providerNamespaceFingerprintSha256",
  );
  if (providerInstanceFingerprintSha256 !== expected.instanceFingerprintSha256 ||
      providerNamespaceFingerprintSha256 !== expected.namespaceFingerprintSha256) {
    throw new TypeError("provider process report is bound to a different provider instance or namespace");
  }
  if (input.executionMode !== EXECUTION_MODE || input.processIsolationVerified !== true) {
    throw new TypeError("provider process report does not prove the required fresh-child-process execution mode");
  }
  requirePositiveInteger(input.workerProcessesStarted, "workerProcessesStarted");
  if (input.workerProcessesStarted < 30 ||
      input.uniqueWorkerInstances !== input.workerProcessesStarted ||
      !Number.isSafeInteger(input.uniqueWorkerProcessIds) ||
      input.uniqueWorkerProcessIds < 2 ||
      input.uniqueWorkerProcessIds > input.workerProcessesStarted) {
    throw new TypeError("provider process report has insufficient or inconsistent worker-process evidence");
  }

  exactKeys(input.conformance, CONFORMANCE_KEYS, "provider process conformance result");
  if (input.conformance.providerId !== expected.providerId ||
      input.conformance.initializeContenders !== 8 ||
      input.conformance.initializeWinners !== 1 ||
      input.conformance.casContenders !== 8 ||
      input.conformance.casWinners !== 1) {
    throw new TypeError("provider process report does not show the required single-winner concurrency outcomes");
  }
  for (const key of [
    "staleCasRejected",
    "freshProviderReopened",
    "freshReadMatched",
    "ambiguousCommitRecovered",
    "preCommitTimeoutSafeRetry",
    "ambiguousCompetingWinnerDetected",
    "identityIsolationVerified",
  ]) {
    if (input.conformance[key] !== true) {
      throw new TypeError("provider process report is missing a successful conformance result: " + key);
    }
  }
  requirePositiveInteger(input.conformance.finalRevision, "conformance.finalRevision");
  requirePositiveInteger(input.conformance.finalMinimumAcceptedSequence,
    "conformance.finalMinimumAcceptedSequence");
  if (input.trustBoundary !== TRUST_BOUNDARY) {
    throw new TypeError("provider process report trust-boundary statement is missing or altered");
  }

  return Object.freeze({
    schemaVersion: input.schemaVersion,
    sourceCommitSha: input.sourceCommitSha,
    providerId: input.providerId,
    adapterModuleSha256,
    providerInstanceFingerprintSha256,
    providerNamespaceFingerprintSha256,
    workerProcessesStarted: input.workerProcessesStarted,
    uniqueWorkerInstances: input.uniqueWorkerInstances,
    uniqueWorkerProcessIds: input.uniqueWorkerProcessIds,
    processIsolationVerified: true,
    conformanceVerified: true,
  });
}

export const TRUST_REGISTRY_GOVERNANCE_PROVIDER_PROCESS_REPORT_SCHEMA_VERSION = "1.1.0";
