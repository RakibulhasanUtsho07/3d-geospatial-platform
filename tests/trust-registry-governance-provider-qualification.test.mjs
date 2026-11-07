import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessTrustRegistryProviderQualification,
  normalizeTrustRegistryProviderQualificationManifest,
  TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS,
  verifyTrustRegistryProviderQualificationArtifacts,
} from "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs";
import { signTrustRegistryGovernanceProviderProcessReport } from "../src/core/building-generation/trust-registry-governance-provider-process-report-signature.mjs";
import {
  buildTrustRegistryGovernanceProviderAnchorWitnessSigningBytes,
  createTrustRegistryGovernanceProviderAnchorChallenge,
} from "../src/core/building-generation/trust-registry-governance-provider-anchor-witness.mjs";

const repository = "RakibulhasanUtsho07/3d-geospatial-platform";
const sourceCommitSha = "786d901e5a7ed4effddbbbb563533820276fb4ba";
const reviewerPair = generateKeyPairSync("ed25519");
const reviewerPrivateKeyPem = reviewerPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const reviewerPublicKeyPem = reviewerPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const trustedReviewerRegistry = {
  schemaVersion: "1.0.0",
  recordType: "reconstruction-trusted-reviewer-key-registry",
  registryId: "d3m25-test-reviewers",
  issuedAtUtc: "2026-11-01T00:00:00.000Z",
  expiresAtUtc: "2026-12-01T00:00:00.000Z",
  entries: [{
    reviewerId: "d3m25-test-reviewer", keyId: "d3m25-test-key", status: "active",
    publicKeyPem: reviewerPublicKeyPem, validFromUtc: "2026-11-01T00:00:00.000Z",
    validUntilUtc: "2026-12-01T00:00:00.000Z", revokedAtUtc: null, replacesKeyId: null,
  }],
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
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

function processReport(manifest) {
  return {
    schemaVersion: "1.1.0",
    sourceCommitSha,
    providerId: manifest.provider.providerId,
    adapterModuleSha256: manifest.provider.adapterModuleSha256,
    adapterDeclaredSyntheticOnly: manifest.provider.syntheticOnly,
    providerInstanceFingerprintSha256: manifest.provider.instanceFingerprintSha256,
    providerNamespaceFingerprintSha256: manifest.provider.namespaceFingerprintSha256,
    executionMode: "fresh-node-child-process-per-provider-operation",
    processIsolationVerified: true,
    workerProcessesStarted: 43,
    uniqueWorkerInstances: 43,
    uniqueWorkerProcessIds: 8,
    conformance: {
      providerId: manifest.provider.providerId,
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
    trustBoundary: "Software conformance only. Adapter declarations are not independently authenticated. This report does not prove provider deployment, independent anchor custody, rollback resistance, security controls or production durability.",
  };
}

function processReportBytes(manifest) {
  return Buffer.from(JSON.stringify(processReport(manifest)) + "\n");
}

function processReportSignatureBytes(manifest) {
  const envelope = signTrustRegistryGovernanceProviderProcessReport({
    reportBytes: processReportBytes(manifest),
    privateKeyPem: reviewerPrivateKeyPem,
    reviewerId: "d3m25-test-reviewer",
    trustedReviewerRegistry,
    signedAt: "2026-11-07T04:00:00.000Z",
  });
  return Buffer.from(JSON.stringify(envelope, null, 2) + "\n");
}

async function verifyArtifacts(manifest, root, registry = trustedReviewerRegistry, extra = {}) {
  return verifyTrustRegistryProviderQualificationArtifacts(manifest, root, {
    trustedReviewerRegistry: registry,
    ...extra,
  });
}

function run({ id, event, conclusion = "success", headSha = sourceCommitSha } ) {
  return {
    runId: id,
    runUrl: "https://github.com/" + repository + "/actions/runs/" + id,
    event,
    headSha,
    fullRunConclusion: conclusion,
    providerConformanceStepConclusion: "success",
    syntheticOnly: true,
  };
}

function currentManifest() {
  return {
    schemaVersion: "1.0.0",
    manifestId: "qualification-" + randomUUID(),
    generatedAtUtc: "2026-11-07T04:15:10.000Z",
    source: {
      repository,
      branch: "feat/d3m-engine24-provider-conformance-20261105",
      commitSha: sourceCommitSha,
    },
    provider: {
      status: "not-provisioned",
      providerId: null,
      implementation: null,
      version: null,
      environment: "not-provisioned",
      instanceFingerprintSha256: null,
      namespaceFingerprintSha256: null,
      endpointOrigin: null,
      syntheticOnly: true,
    },
    conformanceCi: {
      push: run({ id: 42337017403, event: "push", conclusion: "in_progress" }),
      pullRequest: run({ id: 42337019776, event: "pull_request" }),
    },
    providerIntegration: {
      status: "not-run",
      runId: null,
      runUrl: null,
      headSha: null,
      fullRunConclusion: "not-run",
      suiteConclusion: "not-run",
      syntheticOnly: true,
    },
    artifacts: [],
    evidence: Object.fromEntries(TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS.map((key) => [
      key, { status: "missing", artifactIds: [], verificationKind: "none" },
    ])),
  };
}

function completeManifest() {
  const manifest = currentManifest();
  manifest.schemaVersion = "1.2.0";
  manifest.provider = {
    status: "provisioned",
    providerId: "provider-staging-a",
    implementation: "example-external-monotonic-store",
    version: "1.2.3",
    environment: "staging",
    instanceFingerprintSha256: digest("provider instance"),
    namespaceFingerprintSha256: digest("isolated provider namespace"),
    endpointOrigin: "https://provider.example",
    adapterModuleSha256: digest("provider adapter module"),
    syntheticOnly: false,
  };
  manifest.conformanceCi.push.fullRunConclusion = "success";
  manifest.conformanceCi.pullRequest.fullRunConclusion = "success";
  manifest.providerIntegration = {
    status: "passed",
    runId: 42339999999,
    runUrl: "https://github.com/" + repository + "/actions/runs/42339999999",
    headSha: sourceCommitSha,
    fullRunConclusion: "success",
    suiteConclusion: "success",
    syntheticOnly: false,
    providerInstanceFingerprintSha256: manifest.provider.instanceFingerprintSha256,
    providerNamespaceFingerprintSha256: manifest.provider.namespaceFingerprintSha256,
    processReportArtifactId: "evidence-processrestartvisibility",
    processReportSignatureArtifactId: "evidence-process-report-signature",
  };
  manifest.artifacts = [];
  for (const key of TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS) {
    const id = "evidence-" + key.toLowerCase();
    const bytes = key === "processRestartVisibility"
      ? processReportBytes(manifest)
      : "independent provider evidence for " + key;
    manifest.artifacts.push({
      id,
      type: evidenceTypes[key],
      status: "present",
      relativePath: key === "processRestartVisibility"
        ? "evidence/provider-process-conformance.json"
        : "evidence/" + id + ".json",
      sha256: digest(bytes),
      bytes: Buffer.byteLength(bytes),
      sourceUrl: key === "processRestartVisibility"
        ? manifest.providerIntegration.runUrl
        : "https://evidence.example/" + id,
      sourceCommitSha,
    });
    manifest.evidence[key] = {
      status: "verified",
      artifactIds: [id],
      verificationKind: key === "independentSecurityReview" ? "independent-audit" : "provider-test",
    };
  }
  const signatureBytes = processReportSignatureBytes(manifest);
  manifest.artifacts.push({
    id: manifest.providerIntegration.processReportSignatureArtifactId,
    type: "process-report-signature",
    status: "present",
    relativePath: "evidence/process-report-signature.json",
    sha256: digest(signatureBytes),
    bytes: signatureBytes.length,
    sourceUrl: manifest.providerIntegration.runUrl,
    sourceCommitSha,
  });
  return manifest;
}

test("qualification schema evidence keys stay aligned with the evaluator", async () => {
  const schemaPath = new URL("../trust-registry-governance-provider-qualification.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const evaluatorKeys = [...TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS].sort();
  assert.equal(schema.properties.evidence.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties.evidence.properties).sort(), evaluatorKeys);
  assert.deepEqual([...schema.properties.evidence.required].sort(), evaluatorKeys);
  assert.deepEqual(schema.properties.schemaVersion.enum, ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]);
  assert.ok(schema.properties.provider.required.includes("adapterModuleSha256") === false,
    "D3M-25 schema 1.0.0 remains backward compatible");
  assert.ok(schema.properties.providerIntegration.properties.processReportArtifactId);
  assert.ok(schema.properties.providerIntegration.properties.processReportSignatureArtifactId);
  assert.ok(schema.$defs.presentArtifact.properties.type.enum.includes("process-report-signature"));
  assert.ok(schema.$defs.missingArtifact.properties.type.enum.includes("process-report-signature"));
  assert.ok(schema.$defs.presentArtifact.properties.type.enum.includes("anchor-witness-challenge"));
  assert.ok(schema.$defs.missingArtifact.properties.type.enum.includes("anchor-witness-challenge"));
  assert.ok(schema.properties.independentAnchorWitness);
  const provisionedAdapterRule = schema.allOf.find((rule) =>
    rule.if?.properties?.provider?.properties?.status?.const === "provisioned");
  assert.equal(
    provisionedAdapterRule.then.properties.provider.properties.adapterModuleSha256.type,
    "string",
    "a schema-1.1 provisioned provider must have a non-null adapter SHA-256",
  );
  const unprovisionedAdapterRule = schema.allOf.find((rule) =>
    rule.if?.properties?.provider?.properties?.status?.const === "not-provisioned");
  assert.equal(unprovisionedAdapterRule.then.properties.provider.properties.adapterModuleSha256.const, null);
  const passedIntegrationRule = schema.allOf.find((rule) =>
    rule.if?.properties?.providerIntegration?.properties?.status?.const === "passed" &&
    rule.then?.properties?.providerIntegration?.properties?.providerInstanceFingerprintSha256);
  assert.equal(
    passedIntegrationRule.then.properties.providerIntegration.properties.processReportArtifactId.type,
    "string",
    "a passed schema-1.1 integration must have a non-null process-report artifact ID",
  );
  assert.equal(
    passedIntegrationRule.then.properties.providerIntegration.properties.providerInstanceFingerprintSha256.type,
    "string",
  );
  assert.equal(
    passedIntegrationRule.then.properties.providerIntegration.properties.providerNamespaceFingerprintSha256.type,
    "string",
  );
  const signedRule = schema.allOf.find((rule) => rule.if?.properties?.schemaVersion?.enum?.includes("1.2.0") && rule.if?.properties?.providerIntegration?.properties?.status?.const === "passed");
  assert.equal(signedRule.then.properties.providerIntegration.properties.processReportSignatureArtifactId.type, "string");
  assert.equal(schema.$defs.ciRun.properties.syntheticOnly.const, true);
  assert.ok(schema.properties.providerIntegration.required.includes("fullRunConclusion"));
  assert.equal(
    schema.properties.evidence.properties.independentSecurityReview.allOf[1].then.properties.verificationKind.const,
    "independent-audit",
  );
});

test("checked-in provider qualification state is valid but blocked without a real provider", async () => {
  const manifestPath = new URL("../benchmarks/trust-registry-governance/provider-qualification-current.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const report = assessTrustRegistryProviderQualification(manifest);
  assert.equal(report.status, "blocked");
  assert.equal(report.productionQualificationEligible, false);
  assert.ok(report.blockers.includes("real-provider-not-provisioned"));
  assert.ok(report.blockers.includes("real-provider-integration-suite-not-passed"));
  assert.equal(report.blockers.includes("conformance-ci-push-full-run-not-success"), false,
    "the checked-in D3M-24 Push Full CI record must reflect its completed exact-head success");
  assert.equal(report.blockers.includes("conformance-ci-pullRequest-full-run-not-success"), false,
    "the checked-in D3M-24 PR Full CI record must reflect its completed exact-head success");
  assert.ok(report.blockers.includes("evidence-missing:independentAnchorCustody"));
  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
});

test("complete hash-bound provider evidence reaches review only, never production approval", async () => {
  const manifest = completeManifest();
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m25-qualification-"));
  try {
    for (const artifact of manifest.artifacts) {
      const target = path.join(root, artifact.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      const key = TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS.find((candidate) =>
        artifact.id === "evidence-" + candidate.toLowerCase());
      const bytes = artifact.type === "process-report-signature"
        ? processReportSignatureBytes(manifest)
        : key === "processRestartVisibility"
          ? processReportBytes(manifest)
          : "independent provider evidence for " + key;
      await writeFile(target, bytes);
    }
    const verified = await verifyArtifacts(manifest, root);
    assert.equal(verified.failures.length, 0);
    assert.ok(verified.verifiedArtifactIds.includes(manifest.providerIntegration.processReportSignatureArtifactId),
      "the signature is verified only through the linked report verification path");
    assert.equal(Object.isFrozen(verified), true);
    assert.equal(Object.isFrozen(verified.verifiedArtifactIds), true);
    const report = assessTrustRegistryProviderQualification(manifest, {
      artifactVerification: verified,
    });
    assert.equal(report.status, "ready-for-independent-review");
    assert.equal(report.productionQualificationEligible, false);
    assert.deepEqual(report.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });
    const alteredManifest = { ...manifest, manifestId: manifest.manifestId + "-altered" };
    const staleVerification = assessTrustRegistryProviderQualification(alteredManifest, {
      artifactVerification: verified,
    });
    assert.equal(staleVerification.status, "blocked");
    assert.ok(staleVerification.blockers.includes("artifact-verification-manifest-mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic provider evidence cannot qualify as a real provider integration", () => {
  const manifest = completeManifest();
  manifest.provider.syntheticOnly = true;
  manifest.providerIntegration.syntheticOnly = true;
  const report = assessTrustRegistryProviderQualification(manifest, {
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("provider-is-synthetic-only"));
  assert.ok(report.blockers.includes("provider-integration-is-synthetic-only"));
});

test("provider integration must match the exact evaluated source commit", () => {
  const manifest = completeManifest();
  manifest.providerIntegration.headSha = "0".repeat(40);
  const report = assessTrustRegistryProviderQualification(manifest, {
  });
  assert.ok(report.blockers.includes("provider-integration-head-sha-mismatch"));
});

test("D3M-24 CI evidence cannot be relabeled as non-synthetic", () => {
  const manifest = completeManifest();
  manifest.conformanceCi.push.syntheticOnly = false;
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest),
    /syntheticOnly must be true/);
});

test("provider integration full workflow must succeed independently of its focused suite", () => {
  const manifest = completeManifest();
  manifest.providerIntegration.fullRunConclusion = "failure";
  const report = assessTrustRegistryProviderQualification(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("real-provider-integration-full-run-not-success"));
});

test("D3M-24 synthetic conformance workflow runs cannot be reused as a provider integration run", () => {
  const manifest = completeManifest();
  manifest.providerIntegration.runId = manifest.conformanceCi.push.runId;
  manifest.providerIntegration.runUrl = manifest.conformanceCi.push.runUrl;
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest), /separate run from the D3M-24 synthetic conformance workflows/);
});

test("provider integration evidence must match the exact provisioned instance and namespace", () => {
  const wrongInstance = completeManifest();
  wrongInstance.providerIntegration.providerInstanceFingerprintSha256 = digest("different instance");
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(wrongInstance), /different provider instance or namespace/);

  const wrongNamespace = completeManifest();
  wrongNamespace.providerIntegration.providerNamespaceFingerprintSha256 = digest("different namespace");
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(wrongNamespace), /different provider instance or namespace/);
});

test("an integration run cannot be claimed before a provider is provisioned", () => {
  const manifest = currentManifest();
  manifest.schemaVersion = "1.1.0";
  manifest.provider.adapterModuleSha256 = null;
  manifest.providerIntegration = completeManifest().providerIntegration;
  delete manifest.providerIntegration.processReportSignatureArtifactId;
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest), /provider integration cannot claim a run when the provider is not provisioned/);
});

test("both D3M-24 Full CI runs must finish successfully on the exact source SHA", () => {
  const manifest = completeManifest();
  manifest.conformanceCi.push.fullRunConclusion = "in_progress";
  manifest.conformanceCi.pullRequest.headSha = "0".repeat(40);
  const report = assessTrustRegistryProviderQualification(manifest, {
  });
  assert.ok(report.blockers.includes("conformance-ci-push-full-run-not-success"));
  assert.ok(report.blockers.includes("conformance-ci-pullRequest-head-sha-mismatch"));
});

test("a successful Full CI run cannot hide a failed provider-conformance step", () => {
  const manifest = completeManifest();
  manifest.conformanceCi.push.providerConformanceStepConclusion = "failure";
  const report = assessTrustRegistryProviderQualification(manifest);
  assert.ok(report.blockers.includes("conformance-ci-push-provider-conformance-step-not-success"));
});

test("missing independent evidence classes remain explicit blockers", () => {
  const manifest = completeManifest();
  manifest.evidence.independentAnchorCustody = {
    status: "missing", artifactIds: [], verificationKind: "none",
  };
  const report = assessTrustRegistryProviderQualification(manifest, {
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("evidence-missing:independentAnchorCustody"));
});

test("unknown and duplicate evidence artifact references are rejected", () => {
  const unknown = completeManifest();
  unknown.evidence.multiClientLinearizability.artifactIds = ["unknown-artifact"];
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(unknown), /unknown artifact/);

  const duplicate = completeManifest();
  duplicate.artifacts.push({ ...duplicate.artifacts[0] });
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(duplicate), /artifact IDs must be unique/);
});

test("evidence artifact source commits must match the qualified provider source commit", () => {
  const manifest = completeManifest();
  manifest.artifacts[0].sourceCommitSha = "0".repeat(40);
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest), /bound to a different source commit/);
});

test("provider endpoint origins reject credentials, paths, query strings and non-HTTPS URLs", () => {
  for (const endpointOrigin of [
    "https://user:password@provider.example",
    "https://provider.example/private",
    "https://provider.example?token=secret",
    "http://provider.example",
  ]) {
    const manifest = completeManifest();
    manifest.provider.endpointOrigin = endpointOrigin;
    assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest), /HTTPS|origin only/);
  }
});

test("unsafe and absolute artifact paths are rejected", () => {
  for (const relativePath of ["../escape.json", "/tmp/evidence.json", "C:/evidence.json", "evidence\\secret.json"]) {
    const manifest = completeManifest();
    manifest.artifacts[0].relativePath = relativePath;
    assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest), /safe project-relative path|unsafe path segment/);
  }
});

test("missing and present evidence artifacts cannot be confused", () => {
  const manifest = completeManifest();
  manifest.artifacts[0] = {
    id: manifest.artifacts[0].id,
    type: manifest.artifacts[0].type,
    status: "missing",
    reason: "Not provisioned",
  };
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest), /cannot claim a missing artifact/);
});

test("artifact verification rejects symlinks, byte-count mismatches and hash mismatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m25-artifact-check-"));
  try {
    const manifest = completeManifest();
    const first = manifest.artifacts[0];
    const target = path.join(root, first.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "different evidence bytes");
    let result = await verifyArtifacts(manifest, root);
    assert.ok(result.failures.some((failure) => failure.id === first.id &&
      ["byte-count-mismatch", "sha256-mismatch"].includes(failure.code)));

    await rm(target, { force: true });
    await symlink(path.join(root, "missing-target"), target);
    result = await verifyArtifacts(manifest, root);
    const symlinkFailure = result.failures.find((failure) => failure.id === first.id && failure.code === "symlink");
    assert.ok(symlinkFailure);
    assert.equal(symlinkFailure.message.includes(root), false,
      "artifact diagnostics must not leak absolute local paths");

    await rm(path.dirname(target), { recursive: true, force: true });
    const outsideDirectory = path.join(root, "outside");
    await mkdir(outsideDirectory, { recursive: true });
    const evidenceKey = TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS.find((key) =>
      first.id === "evidence-" + key.toLowerCase());
    await writeFile(path.join(outsideDirectory, path.basename(target)),
      "independent provider evidence for " + evidenceKey);
    await symlink(outsideDirectory, path.dirname(target), "dir");
    result = await verifyArtifacts(manifest, root);
    const parentSymlinkFailure = result.failures.find((failure) =>
      failure.id === first.id && failure.code === "symlink");
    assert.ok(parentSymlinkFailure, "parent-directory symlinks must be rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider identity must not expose secrets or self-assert as an unqualified environment", () => {
  const incomplete = completeManifest();
  incomplete.provider.instanceFingerprintSha256 = null;
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(incomplete), /fingerprints/);

  const development = completeManifest();
  development.provider.environment = "development";
  const report = assessTrustRegistryProviderQualification(development, {
  });
  assert.ok(report.blockers.includes("provider-environment-is-not-staging-or-production"));

  for (const endpointOrigin of ["https://localhost", "https://127.0.0.1", "https://node.localhost"]) {
    const local = completeManifest();
    local.provider.endpointOrigin = endpointOrigin;
    assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(local), /remote HTTPS origin/);
  }
});

test("aggregate evidence size is bounded before any file bytes are opened", () => {
  const manifest = completeManifest();
  for (const artifact of manifest.artifacts) artifact.bytes = 128 * 1024 * 1024;
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest), /512 MiB aggregate/);
});

test("independent security review cannot be self-attested as a provider test", () => {
  const manifest = completeManifest();
  manifest.evidence.independentSecurityReview.verificationKind = "provider-test";
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest),
    /independentSecurityReview requires independent-audit provenance/);
});

test("assessment rejects caller-supplied artifact IDs as byte-verification proof", () => {
  const manifest = completeManifest();
  const actualIds = manifest.artifacts.map((artifact) => artifact.id);
  assert.throws(() => assessTrustRegistryProviderQualification(manifest, {
    verifiedArtifactIds: new Set([...actualIds, "not-a-manifest-artifact"]),
  }), /unsupported assessment option: verifiedArtifactIds/);
  const report = assessTrustRegistryProviderQualification(manifest);
  assert.equal(report.verifiedArtifactCount, 0);
  assert.ok(report.blockers.includes("artifact-verification-not-performed"));
});
const cliPath = fileURLToPath(new URL("../scripts/validate-trust-registry-governance-provider-qualification.mjs", import.meta.url));
const currentManifestPath = fileURLToPath(new URL(
  "../benchmarks/trust-registry-governance/provider-qualification-current.json",
  import.meta.url,
));

function runQualificationCli(args, cwd) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

test("qualification validator CLI help is available without a manifest", () => {
  const result = runQualificationCli(["--help"], process.cwd());
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Usage: node scripts/validate-trust-registry-governance-provider-qualification.mjs"));
});

test("qualification validator CLI emits a hash-bound blocked report and never overwrites it", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "d3m25-qualification-cli-"));
  try {
    const relativeReport = "reports/current-qualification.json";
    const first = runQualificationCli([currentManifestPath, "--report", relativeReport], cwd);
    assert.equal(first.status, 0, first.stderr);
    const summary = JSON.parse(first.stdout);
    assert.equal(summary.status, "blocked");
    assert.equal(summary.productionQualificationEligible, false);
    assert.equal(summary.releaseFlags.mapReady, false);

    const reportPath = path.join(cwd, relativeReport);
    const reportBytes = await readFile(reportPath);
    const report = JSON.parse(reportBytes.toString("utf8"));
    assert.equal(
      report.manifestSha256,
      createHash("sha256").update(await readFile(currentManifestPath)).digest("hex"),
    );
    assert.equal(
      report.reportSha256,
      createHash("sha256").update(JSON.stringify({ ...report, reportSha256: undefined })).digest("hex"),
    );

    const second = runQualificationCli([currentManifestPath, "--report", relativeReport], cwd);
    assert.equal(second.status, 2);
    assert.match(second.stderr, /EEXIST|already exists/i);
    assert.deepEqual(await readFile(reportPath), reportBytes);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("qualification validator CLI rejects report-parent symlinks and traversal", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "d3m25-report-path-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "d3m25-report-outside-"));
  try {
    const traversal = runQualificationCli([currentManifestPath, "--report", "../escape.json"], cwd);
    assert.equal(traversal.status, 2);
    assert.match(traversal.stderr, /safe relative path|escapes/i);

    await symlink(outside, path.join(cwd, "redirected"), "dir");
    const redirected = runQualificationCli([currentManifestPath, "--report", "redirected/report.json"], cwd);
    assert.equal(redirected.status, 2);
    assert.match(redirected.stderr, /symbolic link|outside/i);
    await assert.rejects(readFile(path.join(outside, "report.json")), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("qualification validator CLI rejects symlinked, oversized and malformed manifests", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "d3m25-manifest-input-"));
  try {
    const malformedPath = path.join(cwd, "malformed.json");
    await writeFile(malformedPath, "{not-json");
    const malformed = runQualificationCli([malformedPath], cwd);
    assert.equal(malformed.status, 2);

    const oversizedPath = path.join(cwd, "oversized.json");
    await writeFile(oversizedPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const oversized = runQualificationCli([oversizedPath], cwd);
    assert.equal(oversized.status, 2);
    assert.match(oversized.stderr, /1 MiB input limit/);

    const symlinkPath = path.join(cwd, "manifest-link.json");
    await symlink(currentManifestPath, symlinkPath);
    const symlinked = runQualificationCli([symlinkPath], cwd);
    assert.equal(symlinked.status, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});


test("legacy D3M-25 passed provider manifests remain readable but cannot skip the D3M-27 process-report binding", () => {
  const manifest = completeManifest();
  manifest.schemaVersion = "1.0.0";
  delete manifest.provider.adapterModuleSha256;
  delete manifest.providerIntegration.processReportArtifactId;
  delete manifest.providerIntegration.processReportSignatureArtifactId;
  const normalized = normalizeTrustRegistryProviderQualificationManifest(manifest);
  assert.equal(normalized.schemaVersion, "1.0.0");
  const report = assessTrustRegistryProviderQualification(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("provider-process-report-not-bound"));
  assert.equal(report.productionQualificationEligible, false);
  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
});


test("D3M-28 blocks a legacy 1.1 passed integration that has no trusted report signature", () => {
  const manifest = completeManifest();
  manifest.schemaVersion = "1.1.0";
  delete manifest.providerIntegration.processReportSignatureArtifactId;
  manifest.artifacts = manifest.artifacts.filter((artifact) => artifact.type !== "process-report-signature");
  const normalized = normalizeTrustRegistryProviderQualificationManifest(manifest);
  assert.equal(normalized.schemaVersion, "1.1.0");
  const report = assessTrustRegistryProviderQualification(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("provider-process-report-signature-not-bound"));
  assert.equal(report.productionQualificationEligible, false);
  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
});

test("D3M-27 refuses a process report artifact that is not bound to processRestartVisibility evidence", () => {
  const manifest = completeManifest();
  manifest.evidence.processRestartVisibility = {
    status: "missing",
    artifactIds: [],
    verificationKind: "none",
  };
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest),
    /processRestartVisibility evidence must reference the exact provider integration report artifact/i);
});

test("D3M-27 refuses a passed provider integration without its report artifact", () => {
  const manifest = completeManifest();
  manifest.providerIntegration.processReportArtifactId = "missing-process-report";
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest),
    /present process-restart-report artifact/i);
});

test("D3M-27 byte verification also validates process report semantics and exact provider identity", async () => {
  const manifest = completeManifest();
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m27-report-semantic-"));
  try {
    for (const artifact of manifest.artifacts) {
      const target = path.join(root, artifact.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      const key = TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS.find((candidate) =>
        artifact.id === "evidence-" + candidate.toLowerCase());
      let bytes = artifact.type === "process-report-signature"
        ? processReportSignatureBytes(manifest)
        : key === "processRestartVisibility"
          ? processReportBytes(manifest)
          : "independent provider evidence for " + key;
      await writeFile(target, bytes);
    }
    let result = await verifyArtifacts(manifest, root);
    assert.equal(result.failures.length, 0);
    assert.ok(result.verifiedArtifactIds.includes(manifest.providerIntegration.processReportArtifactId));

    const reportArtifact = manifest.artifacts.find((artifact) =>
      artifact.id === manifest.providerIntegration.processReportArtifactId);
    const reportPath = path.join(root, reportArtifact.relativePath);
    const tamperedReport = processReport(manifest);
    tamperedReport.providerNamespaceFingerprintSha256 = digest("substituted namespace");
    await writeFile(reportPath, JSON.stringify(tamperedReport) + "\n");
    result = await verifyArtifacts(manifest, root);
    assert.ok(result.failures.some((failure) =>
      failure.id === reportArtifact.id && failure.code === "sha256-mismatch"));

    reportArtifact.bytes = Buffer.byteLength(JSON.stringify(tamperedReport) + "\n");
    reportArtifact.sha256 = digest(JSON.stringify(tamperedReport) + "\n");
    result = await verifyArtifacts(manifest, root);
    assert.ok(result.failures.some((failure) =>
      failure.id === reportArtifact.id && failure.code === "process-report-invalid"),
    "a correctly re-hashed but semantically substituted report must remain invalid");
    const assessment = assessTrustRegistryProviderQualification(manifest, { artifactVerification: result });
    assert.equal(assessment.status, "blocked");
    assert.ok(assessment.blockers.includes("evidence-artifact-not-byte-verified:" + reportArtifact.id));
    assert.ok(assessment.blockers.includes("artifact-verification-failed:" + reportArtifact.id + ":process-report-invalid"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("D3M-28 rejects additional unsigned process reports in verified restart evidence", () => {
  const manifest = completeManifest();
  const extraBytes = processReportBytes(manifest);
  manifest.artifacts.push({
    id: "unbound-process-report",
    type: "process-restart-report",
    status: "present",
    relativePath: "evidence/unbound-process-report.json",
    sha256: digest(extraBytes),
    bytes: extraBytes.length,
    sourceUrl: manifest.providerIntegration.runUrl,
    sourceCommitSha,
  });
  manifest.evidence.processRestartVisibility.artifactIds.push("unbound-process-report");
  assert.throws(
    () => normalizeTrustRegistryProviderQualificationManifest(manifest),
    /must reference only the exact signed provider integration report/i,
  );
});

test("D3M-28 artifact verification rejects a changed or untrusted report signature", async () => {
  const manifest = completeManifest();
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m28-signature-verification-"));
  try {
    for (const artifact of manifest.artifacts) {
      const target = path.join(root, artifact.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      const key = TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS.find((candidate) =>
        artifact.id === "evidence-" + candidate.toLowerCase());
      const bytes = artifact.type === "process-report-signature"
        ? processReportSignatureBytes(manifest)
        : key === "processRestartVisibility"
          ? processReportBytes(manifest)
          : "independent provider evidence for " + key;
      await writeFile(target, bytes);
    }
    let result = await verifyArtifacts(manifest, root);
    assert.equal(result.failures.length, 0);
    assert.ok(result.verifiedArtifactIds.includes(manifest.providerIntegration.processReportSignatureArtifactId));

    const signatureArtifact = manifest.artifacts.find((artifact) =>
      artifact.id === manifest.providerIntegration.processReportSignatureArtifactId);
    const signaturePath = path.join(root, signatureArtifact.relativePath);
    const alteredEnvelope = JSON.parse((await readFile(signaturePath, "utf8")));
    alteredEnvelope.signatureBase64 = Buffer.alloc(64, 0x31).toString("base64");
    const alteredBytes = Buffer.from(JSON.stringify(alteredEnvelope, null, 2) + "\n");
    await writeFile(signaturePath, alteredBytes);
    signatureArtifact.bytes = alteredBytes.length;
    signatureArtifact.sha256 = digest(alteredBytes);
    result = await verifyArtifacts(manifest, root);
    assert.ok(result.failures.some((failure) =>
      failure.id === signatureArtifact.id && failure.code === "process-report-signature-invalid"));
    const assessment = assessTrustRegistryProviderQualification(manifest, { artifactVerification: result });
    assert.equal(assessment.status, "blocked");
    assert.ok(assessment.blockers.includes("artifact-verification-failed:" + signatureArtifact.id + ":process-report-signature-invalid"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D3M-27 process report artifact must originate from the exact provider integration workflow", () => {
  const manifest = completeManifest();
  const reportArtifact = manifest.artifacts.find((artifact) =>
    artifact.id === manifest.providerIntegration.processReportArtifactId);
  reportArtifact.sourceUrl = "https://evidence.example/substituted-run";
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest),
    /source URL must identify the exact provider integration workflow run/i);
});


test("D3M-29 qualifies independentAnchorCustody only after a fresh signed witness and exact artifact binding", async () => {
  const manifest = completeManifest();
  manifest.schemaVersion = "1.3.0";
  const anchorPair = generateKeyPairSync("ed25519");
  const anchorPublicKeyPem = anchorPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const anchorPublicKeyFingerprintSha256 = digest(
    anchorPair.publicKey.export({ type: "spki", format: "der" }),
  );
  const verificationNow = new Date("2026-11-07T04:00:02.000Z");
  const challengeNow = new Date("2026-11-07T04:00:00.000Z");
  const governancePublicKeyFingerprintSha256 = digest("independently pinned test governance key");
  const independentAnchorKeyRegistry = {
    schemaVersion: "1.0.0",
    recordType: "d3m29-independent-anchor-key-registry",
    registryId: "d3m29-test-anchor-registry",
    registrySetId: "d3m29-test-registry-set",
    governancePublicKeyFingerprintSha256,
    issuedAtUtc: "2026-11-01T00:00:00.000Z",
    expiresAtUtc: "2026-12-01T00:00:00.000Z",
    entries: [{
      anchorId: "external-anchor-01",
      keyId: "external-anchor-key-01",
      status: "active",
      publicKeyPem: anchorPublicKeyPem,
      validFromUtc: "2026-11-01T00:00:00.000Z",
      validUntilUtc: "2026-12-01T00:00:00.000Z",
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  };
  const challenge = createTrustRegistryGovernanceProviderAnchorChallenge({
    sourceCommitSha: manifest.source.commitSha,
    providerId: manifest.provider.providerId,
    adapterModuleSha256: manifest.provider.adapterModuleSha256,
    syntheticOnly: manifest.provider.syntheticOnly,
    instanceFingerprintSha256: manifest.provider.instanceFingerprintSha256,
    namespaceFingerprintSha256: manifest.provider.namespaceFingerprintSha256,
    ttlSeconds: 300,
    now: challengeNow,
  });
  const unsignedWitness = {
    schemaVersion: "1.0.0",
    engine: "d3m29-independent-anchor-witness-v1",
    algorithm: "Ed25519",
    signaturePurpose: "independent-anchor-fresh-challenge-response-not-provider-qualification",
    challengeSha256: challenge.challengeSha256,
    challengeId: challenge.challenge.challengeId,
    nonceHex: challenge.challenge.nonceHex,
    issuedAtUtc: challenge.challenge.issuedAtUtc,
    expiresAtUtc: challenge.challenge.expiresAtUtc,
    observedAtUtc: verificationNow.toISOString(),
    sourceCommitSha: manifest.source.commitSha,
    providerId: manifest.provider.providerId,
    adapterModuleSha256: manifest.provider.adapterModuleSha256,
    syntheticOnly: manifest.provider.syntheticOnly,
    providerInstanceFingerprintSha256: manifest.provider.instanceFingerprintSha256,
    providerNamespaceFingerprintSha256: manifest.provider.namespaceFingerprintSha256,
    anchorId: "external-anchor-01",
    keyId: "external-anchor-key-01",
    anchorPublicKeyFingerprintSha256,
    registryId: independentAnchorKeyRegistry.registryId,
    registrySetId: independentAnchorKeyRegistry.registrySetId,
    governancePublicKeyFingerprintSha256,
    providerVersion: "monotonic-version-42",
    monotonicSequence: 42,
    authoritativeStateSha256: digest("independently anchored provider state"),
    signatureBase64: "",
  };
  const signature = sign(null, buildTrustRegistryGovernanceProviderAnchorWitnessSigningBytes({
    challengeBytes: challenge.bytes,
    witness: unsignedWitness,
  }), anchorPair.privateKey);
  const witnessBytes = Buffer.from(JSON.stringify({
    ...unsignedWitness,
    signatureBase64: signature.toString("base64"),
  }, null, 2) + "\\n", "utf8");

  const oldAnchorArtifact = manifest.artifacts.find((item) => item.id === "evidence-independentanchorcustody");
  manifest.artifacts = manifest.artifacts.filter((item) => item !== oldAnchorArtifact);
  manifest.artifacts.push({
    id: "d3m29-anchor-challenge",
    type: "anchor-witness-challenge",
    status: "present",
    relativePath: "evidence/anchor-challenge.json",
    sha256: digest(challenge.bytes),
    bytes: challenge.bytes.length,
    sourceUrl: manifest.providerIntegration.runUrl,
    sourceCommitSha,
  });
  manifest.artifacts.push({
    id: "d3m29-anchor-witness",
    type: "anchor-independence-review",
    status: "present",
    relativePath: "evidence/anchor-witness.json",
    sha256: digest(witnessBytes),
    bytes: witnessBytes.length,
    sourceUrl: manifest.providerIntegration.runUrl,
    sourceCommitSha,
  });
  manifest.evidence.independentAnchorCustody = {
    status: "verified",
    artifactIds: ["d3m29-anchor-witness"],
    verificationKind: "independent-audit",
  };
  manifest.independentAnchorWitness = {
    status: "verified",
    challengeArtifactId: "d3m29-anchor-challenge",
    witnessArtifactId: "d3m29-anchor-witness",
  };

  const root = await mkdtemp(path.join(os.tmpdir(), "d3m29-qualification-"));
  try {
    for (const artifact of manifest.artifacts) {
      const target = path.join(root, artifact.relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      const evidenceKey = TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS.find((key) =>
        artifact.id === "evidence-" + key.toLowerCase());
      const bytes = artifact.id === "d3m29-anchor-challenge"
        ? challenge.bytes
        : artifact.id === "d3m29-anchor-witness"
          ? witnessBytes
          : artifact.type === "process-report-signature"
            ? processReportSignatureBytes(manifest)
            : evidenceKey === "processRestartVisibility"
              ? processReportBytes(manifest)
              : "independent provider evidence for " + evidenceKey;
      await writeFile(target, bytes);
    }
    const verification = await verifyArtifacts(manifest, root, trustedReviewerRegistry, {
      independentAnchorKeyRegistry,
      now: verificationNow,
    });
    assert.deepEqual(verification.failures, []);
    assert.ok(verification.verifiedArtifactIds.includes("d3m29-anchor-challenge"));
    assert.ok(verification.verifiedArtifactIds.includes("d3m29-anchor-witness"));
    const assessment = assessTrustRegistryProviderQualification(manifest, {
      artifactVerification: verification,
    });
    assert.equal(assessment.status, "ready-for-independent-review");
    assert.equal(assessment.productionQualificationEligible, false);
    assert.deepEqual(assessment.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });

    const witnessPath = path.join(root, "evidence/anchor-witness.json");
    const altered = JSON.parse(await readFile(witnessPath, "utf8"));
    altered.signatureBase64 = Buffer.alloc(64, 0x77).toString("base64");
    const alteredBytes = Buffer.from(JSON.stringify(altered, null, 2) + "\\n", "utf8");
    await writeFile(witnessPath, alteredBytes);
    const witnessArtifact = manifest.artifacts.find((item) => item.id === "d3m29-anchor-witness");
    witnessArtifact.bytes = alteredBytes.length;
    witnessArtifact.sha256 = digest(alteredBytes);
    const rejected = await verifyArtifacts(manifest, root, trustedReviewerRegistry, {
      independentAnchorKeyRegistry,
      now: verificationNow,
    });
    assert.ok(rejected.failures.some((item) =>
      item.id === "d3m29-anchor-witness" && item.code === "independent-anchor-witness-invalid"));
    const blocked = assessTrustRegistryProviderQualification(manifest, { artifactVerification: rejected });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blockers.includes("artifact-verification-failed:d3m29-anchor-witness:independent-anchor-witness-invalid"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D3M-29 blocks legacy qualification manifests that claim verified independent anchor custody", () => {
  const manifest = completeManifest();
  assert.throws(() => normalizeTrustRegistryProviderQualificationManifest(manifest), 
    /provider qualification manifest must contain exactly/i,
  );
  manifest.evidence.independentAnchorCustody.verificationKind = "independent-audit";
  const report = assessTrustRegistryProviderQualification(manifest);
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("independent-anchor-witness-not-bound"));
});
