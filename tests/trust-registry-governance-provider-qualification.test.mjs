import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assessTrustRegistryProviderQualification,
  normalizeTrustRegistryProviderQualificationManifest,
  TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS,
  verifyTrustRegistryProviderQualificationArtifacts,
} from "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs";

const repository = "RakibulhasanUtsho07/3d-geospatial-platform";
const sourceCommitSha = "786d901e5a7ed4effddbbbb563533820276fb4ba";
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
  manifest.provider = {
    status: "provisioned",
    providerId: "provider-staging-a",
    implementation: "example-external-monotonic-store",
    version: "1.2.3",
    environment: "staging",
    instanceFingerprintSha256: digest("provider instance"),
    namespaceFingerprintSha256: digest("isolated provider namespace"),
    endpointOrigin: "https://provider.example",
    syntheticOnly: false,
  };
  manifest.conformanceCi.push.fullRunConclusion = "success";
  manifest.conformanceCi.pullRequest.fullRunConclusion = "success";
  manifest.providerIntegration = {
    status: "passed",
    runId: 42339999999,
    runUrl: "https://github.com/" + repository + "/actions/runs/42339999999",
    headSha: sourceCommitSha,
    suiteConclusion: "success",
    syntheticOnly: false,
  };
  manifest.artifacts = [];
  for (const key of TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS) {
    const id = "evidence-" + key.toLowerCase();
    const bytes = "independent provider evidence for " + key;
    manifest.artifacts.push({
      id,
      type: evidenceTypes[key],
      status: "present",
      relativePath: "evidence/" + id + ".json",
      sha256: digest(bytes),
      bytes: Buffer.byteLength(bytes),
      sourceUrl: "https://evidence.example/" + id,
      sourceCommitSha,
    });
    manifest.evidence[key] = {
      status: "verified",
      artifactIds: [id],
      verificationKind: key === "independentSecurityReview" ? "independent-audit" : "provider-test",
    };
  }
  return manifest;
}

test("qualification schema evidence keys stay aligned with the evaluator", async () => {
  const schemaPath = new URL("../trust-registry-governance-provider-qualification.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const evaluatorKeys = [...TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS].sort();
  assert.equal(schema.properties.evidence.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties.evidence.properties).sort(), evaluatorKeys);
  assert.deepEqual([...schema.properties.evidence.required].sort(), evaluatorKeys);
  assert.equal(schema.properties.schemaVersion.const, "1.0.0");
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
      const bytes = "independent provider evidence for " +
        TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS.find((key) =>
          artifact.id === "evidence-" + key.toLowerCase());
      await writeFile(target, bytes);
    }
    const verified = await verifyTrustRegistryProviderQualificationArtifacts(manifest, root);
    assert.equal(verified.failures.length, 0);
    const report = assessTrustRegistryProviderQualification(manifest, {
      verifiedArtifactIds: new Set(verified.verifiedArtifactIds),
    });
    assert.equal(report.status, "ready-for-independent-review");
    assert.equal(report.productionQualificationEligible, false);
    assert.deepEqual(report.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic provider evidence cannot qualify as a real provider integration", () => {
  const manifest = completeManifest();
  manifest.provider.syntheticOnly = true;
  manifest.providerIntegration.syntheticOnly = true;
  const report = assessTrustRegistryProviderQualification(manifest, {
    verifiedArtifactIds: new Set(manifest.artifacts.map((item) => item.id)),
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.includes("provider-is-synthetic-only"));
  assert.ok(report.blockers.includes("provider-integration-is-synthetic-only"));
});

test("provider integration must match the exact evaluated source commit", () => {
  const manifest = completeManifest();
  manifest.providerIntegration.headSha = "0".repeat(40);
  const report = assessTrustRegistryProviderQualification(manifest, {
    verifiedArtifactIds: new Set(manifest.artifacts.map((item) => item.id)),
  });
  assert.ok(report.blockers.includes("provider-integration-head-sha-mismatch"));
});

test("both D3M-24 Full CI runs must finish successfully on the exact source SHA", () => {
  const manifest = completeManifest();
  manifest.conformanceCi.push.fullRunConclusion = "in_progress";
  manifest.conformanceCi.pullRequest.headSha = "0".repeat(40);
  const report = assessTrustRegistryProviderQualification(manifest, {
    verifiedArtifactIds: new Set(manifest.artifacts.map((item) => item.id)),
  });
  assert.ok(report.blockers.includes("conformance-ci-push-full-run-not-success"));
  assert.ok(report.blockers.includes("conformance-ci-pullRequest-head-sha-mismatch"));
});

test("missing independent evidence classes remain explicit blockers", () => {
  const manifest = completeManifest();
  manifest.evidence.independentAnchorCustody = {
    status: "missing", artifactIds: [], verificationKind: "none",
  };
  const report = assessTrustRegistryProviderQualification(manifest, {
    verifiedArtifactIds: new Set(manifest.artifacts.map((item) => item.id)),
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
    let result = await verifyTrustRegistryProviderQualificationArtifacts(manifest, root);
    assert.ok(result.failures.some((failure) => failure.id === first.id &&
      ["byte-count-mismatch", "sha256-mismatch"].includes(failure.code)));

    await rm(target, { force: true });
    await symlink(path.join(root, "missing-target"), target);
    result = await verifyTrustRegistryProviderQualificationArtifacts(manifest, root);
    const symlinkFailure = result.failures.find((failure) => failure.id === first.id && failure.code === "symlink");
    assert.ok(symlinkFailure);
    assert.equal(symlinkFailure.message.includes(root), false,
      "artifact diagnostics must not leak absolute local paths");
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
    verifiedArtifactIds: new Set(development.artifacts.map((item) => item.id)),
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

test("caller-supplied verified IDs cannot inflate the verified artifact count", () => {
  const manifest = completeManifest();
  const actualIds = manifest.artifacts.map((artifact) => artifact.id);
  const report = assessTrustRegistryProviderQualification(manifest, {
    verifiedArtifactIds: new Set([...actualIds, "not-a-manifest-artifact"]),
  });
  assert.equal(report.verifiedArtifactCount, actualIds.length);
});
