import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessTrustRegistryProviderQualification,
  TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS,
  verifyTrustRegistryProviderQualificationArtifacts,
} from "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs";
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

test("D3M-27 rejects an absent syntheticOnly declaration", () => {
  assert.throws(() => validateTrustRegistryGovernanceProviderProcessReport(
    report({ adapterDeclaredSyntheticOnly: null }), expected(),
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


test("D3M-27 end-to-end: actual D3M-26 CLI report is verified by D3M-25 but synthetic evidence stays blocked", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "d3m27-e2e-"));
  const repository = "RakibulhasanUtsho07/3d-geospatial-platform";
  const sourceCommitSha = "a".repeat(40);
  const providerInstanceFingerprintSha256 = "1".repeat(64);
  const providerNamespaceFingerprintSha256 = "2".repeat(64);
  const stateFile = path.join(workspace, "provider-state.json");
  const reportPath = path.join(workspace, "process-report.json");
  const artifactRoot = path.join(workspace, "qualification-artifacts");
  const fixtureModule = fileURLToPath(new URL(
    "./fixtures/trust-registry-governance-file-backed-provider.mjs", import.meta.url,
  ));
  const runnerScript = fileURLToPath(new URL(
    "../scripts/run-trust-registry-governance-provider-process-conformance.mjs", import.meta.url,
  ));
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const runUrl = (runId) => "https://github.com/" + repository + "/actions/runs/" + runId;
  const providerIntegrationRunId = 42349999999;
  const processReportArtifactId = "evidence-processrestartvisibility";
  const evidenceTypes = {
    atomicBootstrapAndCompareAndSet: "multi-client-concurrency-report",
    multiClientLinearizability: "multi-client-concurrency-report",
    processRestartVisibility: "process-restart-report",
    ambiguousWriteRecovery: "ambiguous-write-report",
    independentAnchorCustody: "anchor-independence-review",
    backupRestoreRollbackResistance: "backup-restore-rollback-report",
    authenticatedClientIdentity: "authenticated-client-identity-review",
    transportSecurity: "transport-security-review",
    leastPrivilegeAuthorization: "least-privilege-review",
    keyCustodyAndRotation: "key-custody-rotation-review",
    auditRetention: "audit-retention-review",
    operationalRecovery: "operational-recovery-review",
    independentSecurityReview: "independent-security-review",
  };

  try {
    const runner = spawnSync(process.execPath, [
      runnerScript,
      "--provider-module", fixtureModule,
      "--allow-env", "D3M26_TEST_PROVIDER_STATE_FILE",
      "--source-sha", sourceCommitSha,
      "--provider-instance-fingerprint-sha256", providerInstanceFingerprintSha256,
      "--provider-namespace-fingerprint-sha256", providerNamespaceFingerprintSha256,
      "--report", reportPath,
    ], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
      env: {
        ...process.env,
        D3M26_TEST_PROVIDER_STATE_FILE: stateFile,
      },
    });
    assert.equal(runner.status, 0, runner.stderr);
    const processReportBytes = await readFile(reportPath);
    const processReport = JSON.parse(processReportBytes.toString("utf8"));
    assert.equal(processReport.schemaVersion, "1.1.0");
    assert.equal(processReport.sourceCommitSha, sourceCommitSha);
    assert.equal(processReport.providerId, "d3m26-file-backed-test-provider");
    assert.equal(processReport.adapterDeclaredSyntheticOnly, true);
    assert.equal(processReport.providerInstanceFingerprintSha256, providerInstanceFingerprintSha256);
    assert.equal(processReport.providerNamespaceFingerprintSha256, providerNamespaceFingerprintSha256);
    assert.ok(processReport.workerProcessesStarted >= 30);
    assert.equal(processReport.uniqueWorkerInstances, processReport.workerProcessesStarted);
    assert.ok(processReport.uniqueWorkerProcessIds >= 2);

    const pushRunId = 42349999997;
    const pullRequestRunId = 42349999998;
    const manifest = {
      schemaVersion: "1.1.0",
      manifestId: "d3m27-e2e-" + digest(processReportBytes).slice(0, 24),
      generatedAtUtc: "2026-11-07T06:00:00.000Z",
      source: {
        repository,
        branch: "feat/d3m-engine27-process-qualification-report-bridge-20261107",
        commitSha: sourceCommitSha,
      },
      provider: {
        status: "provisioned",
        providerId: processReport.providerId,
        implementation: "file-backed synthetic test provider",
        version: "1.1.0",
        environment: "staging",
        instanceFingerprintSha256: providerInstanceFingerprintSha256,
        namespaceFingerprintSha256: providerNamespaceFingerprintSha256,
        endpointOrigin: "https://provider.example",
        adapterModuleSha256: processReport.adapterModuleSha256,
        syntheticOnly: true,
      },
      conformanceCi: {
        push: {
          runId: pushRunId,
          runUrl: runUrl(pushRunId),
          event: "push",
          headSha: sourceCommitSha,
          fullRunConclusion: "success",
          providerConformanceStepConclusion: "success",
          syntheticOnly: true,
        },
        pullRequest: {
          runId: pullRequestRunId,
          runUrl: runUrl(pullRequestRunId),
          event: "pull_request",
          headSha: sourceCommitSha,
          fullRunConclusion: "success",
          providerConformanceStepConclusion: "success",
          syntheticOnly: true,
        },
      },
      providerIntegration: {
        status: "passed",
        runId: providerIntegrationRunId,
        runUrl: runUrl(providerIntegrationRunId),
        headSha: sourceCommitSha,
        fullRunConclusion: "success",
        suiteConclusion: "success",
        syntheticOnly: true,
        providerInstanceFingerprintSha256,
        providerNamespaceFingerprintSha256,
        processReportArtifactId,
      },
      artifacts: [],
      evidence: {},
    };

    await mkdir(artifactRoot, { recursive: true });
    for (const key of TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS) {
      const id = "evidence-" + key.toLowerCase();
      const bytes = key === "processRestartVisibility"
        ? processReportBytes
        : Buffer.from(JSON.stringify({ syntheticTestOnly: true, evidenceKey: key }) + "\n", "utf8");
      const relativePath = "evidence/" + id + ".json";
      const target = path.join(artifactRoot, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      manifest.artifacts.push({
        id,
        type: evidenceTypes[key],
        status: "present",
        relativePath,
        sha256: digest(bytes),
        bytes: bytes.length,
        sourceUrl: key === "processRestartVisibility"
          ? manifest.providerIntegration.runUrl
          : "https://evidence.example/" + id,
        sourceCommitSha,
      });
      manifest.evidence[key] = {
        status: "synthetic-only",
        artifactIds: [id],
        verificationKind: "synthetic-test",
      };
    }

    const verification = await verifyTrustRegistryProviderQualificationArtifacts(manifest, artifactRoot);
    assert.deepEqual(verification.failures, []);
    assert.ok(verification.verifiedArtifactIds.includes(processReportArtifactId));
    const assessment = assessTrustRegistryProviderQualification(manifest, {
      artifactVerification: verification,
    });
    assert.equal(assessment.status, "blocked");
    assert.ok(assessment.blockers.includes("provider-is-synthetic-only"));
    assert.ok(assessment.blockers.includes("provider-integration-is-synthetic-only"));
    assert.ok(assessment.blockers.includes("evidence-synthetic-only:processRestartVisibility"));
    assert.equal(assessment.productionQualificationEligible, false);
    assert.deepEqual(assessment.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
