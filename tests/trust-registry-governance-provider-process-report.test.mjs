import assert from "node:assert/strict";
import test from "node:test";
import {
  validateTrustRegistryGovernanceProviderProcessReport,
} from "../src/core/building-generation/trust-registry-governance-provider-process-report.mjs";

const sourceCommitSha = "a".repeat(40);
const providerId = "provider-staging-01";
const adapterModuleSha256 = "b".repeat(64);
const instanceFingerprintSha256 = "c".repeat(64);
const namespaceFingerprintSha256 = "d".repeat(64);
const trustBoundary = "Software conformance only. Adapter declarations are not independently authenticated. This report does not prove provider deployment, independent anchor custody, rollback resistance, security controls or production durability.";

function report(overrides = {}) {
  return {
    schemaVersion: "1.1.0",
    sourceCommitSha,
    providerId,
    adapterModuleSha256,
    adapterDeclaredSyntheticOnly: false,
    providerInstanceFingerprintSha256: instanceFingerprintSha256,
    providerNamespaceFingerprintSha256: namespaceFingerprintSha256,
    executionMode: "fresh-node-child-process-per-provider-operation",
    processIsolationVerified: true,
    workerProcessesStarted: 43,
    uniqueWorkerInstances: 43,
    uniqueWorkerProcessIds: 8,
    conformance: {
      providerId,
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
    },
    trustBoundary,
    ...overrides,
  };
}

function expected(overrides = {}) {
  return {
    sourceCommitSha,
    providerId,
    adapterModuleSha256,
    syntheticOnly: false,
    instanceFingerprintSha256,
    namespaceFingerprintSha256,
    ...overrides,
  };
}

test("D3M-27 accepts a complete report only when every source/provider/adapter/namespace identity matches", () => {
  const result = validateTrustRegistryGovernanceProviderProcessReport(report(), expected());
  assert.equal(result.schemaVersion, "1.1.0");
  assert.equal(result.sourceCommitSha, sourceCommitSha);
  assert.equal(result.providerId, providerId);
  assert.equal(result.adapterModuleSha256, adapterModuleSha256);
  assert.equal(result.providerInstanceFingerprintSha256, instanceFingerprintSha256);
  assert.equal(result.providerNamespaceFingerprintSha256, namespaceFingerprintSha256);
  assert.equal(result.processIsolationVerified, true);
  assert.equal(result.conformanceVerified, true);
  assert.equal(Object.isFrozen(result), true);
});

test("D3M-27 rejects a stale or unrelated source commit", () => {
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ sourceCommitSha: "e".repeat(40) }), expected(),
  ), /source commit/i);
});

test("D3M-27 rejects provider, adapter, instance and namespace substitution", () => {
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ providerId: "different-provider" }), expected(),
  ), /provider ID/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ adapterModuleSha256: "e".repeat(64) }), expected(),
  ), /adapter hash/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ providerInstanceFingerprintSha256: "e".repeat(64) }), expected(),
  ), /different provider instance or namespace/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ providerNamespaceFingerprintSha256: "e".repeat(64) }), expected(),
  ), /different provider instance or namespace/i);
});

test("D3M-27 rejects synthetic adapter evidence when the provisioned provider is declared real", () => {
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ adapterDeclaredSyntheticOnly: true }), expected(),
  ), /synthetic declaration/i);
});

test("D3M-27 keeps synthetic report semantics explicit instead of relabeling it as a real provider", () => {
  const syntheticReport = report({
    adapterDeclaredSyntheticOnly: true,
    providerInstanceFingerprintSha256: "e".repeat(64),
    providerNamespaceFingerprintSha256: "f".repeat(64),
  });
  const result = validateTrustRegistryGovernanceProviderProcessReport(syntheticReport, expected({
    syntheticOnly: true,
    instanceFingerprintSha256: "e".repeat(64),
    namespaceFingerprintSha256: "f".repeat(64),
  }));
  assert.equal(result.processIsolationVerified, true);
  assert.equal(syntheticReport.adapterDeclaredSyntheticOnly, true);
});

test("D3M-27 rejects an incomplete process-isolation or worker identity claim", () => {
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ processIsolationVerified: false }), expected(),
  ), /fresh-child-process/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ uniqueWorkerInstances: 42 }), expected(),
  ), /worker-process evidence/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ uniqueWorkerProcessIds: 1 }), expected(),
  ), /worker-process evidence/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ workerProcessesStarted: 10, uniqueWorkerInstances: 10 }), expected(),
  ), /worker-process evidence/i);
});

test("D3M-27 rejects failed, missing or inconsistent D3M-24 conformance outcomes", () => {
  const noWinner = report();
  noWinner.conformance.casWinners = 2;
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(noWinner, expected()),
    /single-winner concurrency/i);

  const staleWrite = report();
  staleWrite.conformance.staleCasRejected = false;
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(staleWrite, expected()),
    /staleCasRejected/i);

  const ambiguousWrite = report();
  ambiguousWrite.conformance.ambiguousCommitRecovered = false;
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(ambiguousWrite, expected()),
    /ambiguousCommitRecovered/i);

  const missing = report();
  delete missing.conformance.freshReadMatched;
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(missing, expected()),
    /unsupported or missing field/i);
});

test("D3M-27 rejects unknown report fields, wrong version and altered trust-boundary statement", () => {
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ schemaVersion: "1.0.0" }), expected(),
  ), /schemaVersion/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    { ...report(), endpoint: "https://secret.example" }, expected(),
  ), /unsupported or missing field/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ trustBoundary: "Production provider security is proven." }), expected(),
  ), /trust-boundary/i);
});

test("D3M-27 requires the validation context itself to be complete and non-ambiguous", () => {
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report(), { ...expected(), namespaceFingerprintSha256: null },
  ), /namespaceFingerprintSha256/i);
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report(), { ...expected(), adapterModuleSha256: "not-a-hash" },
  ), /adapterModuleSha256/i);
});

test("synthetic reports may omit deployment fingerprints but real-provider reports may not", () => {
  const syntheticReport = report({
    adapterDeclaredSyntheticOnly: true,
    providerInstanceFingerprintSha256: null,
    providerNamespaceFingerprintSha256: null,
  });
  const syntheticExpected = expected({
    syntheticOnly: true,
    instanceFingerprintSha256: null,
    namespaceFingerprintSha256: null,
  });
  assert.equal(
    validateTrustRegistryGovernanceProviderProcessReport(syntheticReport, syntheticExpected).processIsolationVerified,
    true,
  );
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ providerInstanceFingerprintSha256: null }),
    expected(),
  ), /providerInstanceFingerprintSha256/);
});

test("D3M-27 JSON Schema stays aligned with the semantic validator contract", async () => {
  const { readFile } = await import("node:fs/promises");
  const schemaUrl = new URL("../trust-registry-governance-provider-process-report.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "schemaVersion", "sourceCommitSha", "providerId", "adapterModuleSha256",
    "adapterDeclaredSyntheticOnly", "providerInstanceFingerprintSha256",
    "providerNamespaceFingerprintSha256", "executionMode", "processIsolationVerified",
    "workerProcessesStarted", "uniqueWorkerInstances", "uniqueWorkerProcessIds",
    "conformance", "trustBoundary",
  ].sort());
  assert.deepEqual(Object.keys(schema.properties.conformance.properties).sort(), [
    "providerId", "initializeContenders", "initializeWinners", "casContenders", "casWinners",
    "staleCasRejected", "freshProviderReopened", "freshReadMatched", "ambiguousCommitRecovered",
    "preCommitTimeoutSafeRetry", "ambiguousCompetingWinnerDetected", "identityIsolationVerified",
    "finalRevision", "finalMinimumAcceptedSequence",
  ].sort());
  assert.equal(schema.additionalProperties, false);
});
