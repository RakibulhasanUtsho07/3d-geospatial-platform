import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const CONCLUSIONS = new Set(["success", "failure", "in_progress", "queued", "pending"]);
const STEP_CONCLUSIONS = new Set(["success", "failure", "skipped", "pending"]);
const ARTIFACT_TYPES = new Set([
  "multi-client-concurrency-report",
  "process-restart-report",
  "ambiguous-write-report",
  "anchor-independence-review",
  "backup-restore-rollback-report",
  "authenticated-client-identity-review",
  "transport-security-review",
  "least-privilege-review",
  "key-custody-rotation-review",
  "audit-retention-review",
  "operational-recovery-review",
  "independent-security-review",
  "other",
]);
const EVIDENCE_TYPES = Object.freeze({
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
});
const EVIDENCE_STATUS = new Set(["verified", "missing", "failed", "synthetic-only", "not-run"]);
const VERIFICATION_KIND = new Set(["provider-test", "independent-audit", "synthetic-test", "none"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const hashOk = (value) => typeof value === "string" && SHA256.test(value);
const commitOk = (value) => typeof value === "string" && COMMIT.test(value);
const ID_OK = (value) => typeof value === "string" && ID.test(value);
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 512 * 1024 * 1024;

function requireObject(value, label) {
  if (!object(value)) throw new TypeError(label + " must be an object");
  return value;
}

function exactKeys(value, expected, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(label + " must contain exactly: " + keys.join(", "));
  }
}

function requireId(value, label) {
  if (!ID_OK(value)) throw new TypeError(label + " must be a safe identifier");
  return value;
}

function requireCommit(value, label) {
  if (!commitOk(value)) throw new TypeError(label + " must be a full 40-character lowercase Git commit SHA");
  return value;
}

function requireHttpsUrl(value, label) {
  if (!nonEmpty(value) || value.length > 2048) throw new TypeError(label + " must be a bounded HTTPS URL");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(label + " must be a valid HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError(label + " must use HTTPS and must not contain credentials, query strings or fragments");
  }
  return parsed.toString();
}

function validUtc(value, label) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(label + " must be a canonical UTC timestamp");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError(label + " must be a valid UTC timestamp");
  }
  return value;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") ||
      /^[a-z]:/i.test(value)) {
    throw new TypeError(label + " must be a safe project-relative path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(part) ||
      part === "." || part === "..")) {
    throw new TypeError(label + " contains an unsafe path segment");
  }
  return value;
}

function normalizeProvider(raw) {
  exactKeys(raw, [
    "status", "providerId", "implementation", "version", "environment",
    "instanceFingerprintSha256", "namespaceFingerprintSha256", "endpointOrigin", "syntheticOnly",
  ], "provider");
  if (!["not-provisioned", "provisioned"].includes(raw.status)) {
    throw new TypeError("provider.status is unsupported");
  }
  if (typeof raw.syntheticOnly !== "boolean") throw new TypeError("provider.syntheticOnly must be boolean");
  if (raw.status === "not-provisioned") {
    if (raw.providerId !== null || raw.implementation !== null || raw.version !== null ||
        raw.environment !== "not-provisioned" || raw.instanceFingerprintSha256 !== null ||
        raw.namespaceFingerprintSha256 !== null || raw.endpointOrigin !== null || raw.syntheticOnly !== true) {
      throw new TypeError("not-provisioned provider must not claim a deployment identity or endpoint");
    }
    return {
      status: "not-provisioned", providerId: null, implementation: null, version: null,
      environment: "not-provisioned", instanceFingerprintSha256: null,
      namespaceFingerprintSha256: null, endpointOrigin: null, syntheticOnly: true,
    };
  }
  const providerId = requireId(raw.providerId, "provider.providerId");
  for (const key of ["implementation", "version"]) {
    if (!nonEmpty(raw[key]) || raw[key].length > 160 ||
        !/^[A-Za-z0-9][A-Za-z0-9 .+_:/-]{0,159}$/.test(raw[key])) {
      throw new TypeError("provider." + key + " must be a bounded, non-secret identifier");
    }
  }
  if (!["development", "staging", "production"].includes(raw.environment)) {
    throw new TypeError("provider.environment is unsupported");
  }
  if (!hashOk(raw.instanceFingerprintSha256) || !hashOk(raw.namespaceFingerprintSha256)) {
    throw new TypeError("provisioned provider requires SHA-256 instance and namespace fingerprints");
  }
  const endpointUrl = new URL(requireHttpsUrl(raw.endpointOrigin, "provider.endpointOrigin"));
  const hostname = endpointUrl.hostname.toLowerCase().replaceAll("[", "").replaceAll("]", "");
  const ipv4Parts = hostname.split(".");
  const isLoopbackIpv4 = ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255) &&
    Number(ipv4Parts[0]) === 127;
  if (endpointUrl.pathname !== "/" || hostname === "localhost" ||
      hostname.endsWith(".localhost") || hostname === "::1" ||
      isLoopbackIpv4 || hostname === "0.0.0.0") {
    throw new TypeError("provider.endpointOrigin must be a remote HTTPS origin, not a local/loopback endpoint");
  }
  const endpointOrigin = endpointUrl.origin;
  return {
    status: "provisioned",
    providerId,
    implementation: raw.implementation.trim(),
    version: raw.version.trim(),
    environment: raw.environment,
    instanceFingerprintSha256: raw.instanceFingerprintSha256,
    namespaceFingerprintSha256: raw.namespaceFingerprintSha256,
    endpointOrigin,
    syntheticOnly: raw.syntheticOnly,
  };
}

function normalizeCiRun(raw, label, expectedEvent) {
  exactKeys(raw, [
    "runId", "runUrl", "event", "headSha", "fullRunConclusion",
    "providerConformanceStepConclusion", "syntheticOnly",
  ], label);
  if (!Number.isSafeInteger(raw.runId) || raw.runId < 1) throw new TypeError(label + ".runId must be positive");
  const runUrl = requireHttpsUrl(raw.runUrl, label + ".runUrl");
  if (runUrl !== "https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/" + raw.runId) {
    throw new TypeError(label + ".runUrl must identify the declared repository workflow run");
  }
  if (raw.event !== expectedEvent) throw new TypeError(label + ".event must be " + expectedEvent);
  requireCommit(raw.headSha, label + ".headSha");
  if (!CONCLUSIONS.has(raw.fullRunConclusion)) throw new TypeError(label + ".fullRunConclusion is unsupported");
  if (!STEP_CONCLUSIONS.has(raw.providerConformanceStepConclusion)) {
    throw new TypeError(label + ".providerConformanceStepConclusion is unsupported");
  }
  if (typeof raw.syntheticOnly !== "boolean") throw new TypeError(label + ".syntheticOnly must be boolean");
  return { ...raw, runUrl };
}

function normalizeProviderIntegration(raw) {
  exactKeys(raw, [
    "status", "runId", "runUrl", "headSha", "suiteConclusion", "syntheticOnly",
    "providerInstanceFingerprintSha256", "providerNamespaceFingerprintSha256",
  ], "providerIntegration");
  if (!["not-run", "passed", "failed", "pending"].includes(raw.status)) {
    throw new TypeError("providerIntegration.status is unsupported");
  }
  if (typeof raw.syntheticOnly !== "boolean") throw new TypeError("providerIntegration.syntheticOnly must be boolean");
  if (raw.status === "not-run") {
    if (raw.runId !== null || raw.runUrl !== null || raw.headSha !== null ||
        raw.suiteConclusion !== "not-run" || raw.syntheticOnly !== true ||
        raw.providerInstanceFingerprintSha256 !== null ||
        raw.providerNamespaceFingerprintSha256 !== null) {
      throw new TypeError("not-run provider integration must not claim a run, provider identity or real-provider result");
    }
    return {
      status: "not-run", runId: null, runUrl: null, headSha: null,
      suiteConclusion: "not-run", syntheticOnly: true,
      providerInstanceFingerprintSha256: null,
      providerNamespaceFingerprintSha256: null,
    };
  }
  if (!Number.isSafeInteger(raw.runId) || raw.runId < 1) throw new TypeError("providerIntegration.runId must be positive");
  const runUrl = requireHttpsUrl(raw.runUrl, "providerIntegration.runUrl");
  if (runUrl !== "https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/" + raw.runId) {
    throw new TypeError("providerIntegration.runUrl must identify the declared repository workflow run");
  }
  requireCommit(raw.headSha, "providerIntegration.headSha");
  if (!hashOk(raw.providerInstanceFingerprintSha256) ||
      !hashOk(raw.providerNamespaceFingerprintSha256)) {
    throw new TypeError("provider integration must identify its exact provider instance and isolated namespace fingerprints");
  }
  if (!["success", "failure", "pending"].includes(raw.suiteConclusion)) {
    throw new TypeError("providerIntegration.suiteConclusion is unsupported");
  }
  if ((raw.status === "passed" && raw.suiteConclusion !== "success") ||
      (raw.status === "failed" && raw.suiteConclusion !== "failure") ||
      (raw.status === "pending" && raw.suiteConclusion !== "pending")) {
    throw new TypeError("providerIntegration.status and suiteConclusion must agree");
  }
  return { ...raw, runUrl };
}

function normalizeArtifact(raw, index) {
  const label = "artifacts[" + index + "]";
  requireObject(raw, label);
  const status = raw.status;
  if (!["present", "missing"].includes(status)) throw new TypeError(label + ".status must be present or missing");
  const id = requireId(raw.id, label + ".id");
  if (!ARTIFACT_TYPES.has(raw.type)) throw new TypeError(label + ".type is unsupported");
  if (status === "missing") {
    exactKeys(raw, ["id", "type", "status", "reason"], label);
    if (!nonEmpty(raw.reason) || raw.reason.length > 500) {
      throw new TypeError(label + ".reason must explain the missing evidence");
    }
    return { id, type: raw.type, status, reason: raw.reason.trim() };
  }
  exactKeys(raw, ["id", "type", "status", "relativePath", "sha256", "bytes", "sourceUrl", "sourceCommitSha"], label);
  const relativePath = safeRelativePath(raw.relativePath, label + ".relativePath");
  if (!hashOk(raw.sha256)) throw new TypeError(label + ".sha256 must be a lowercase SHA-256 digest");
  if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 1 || raw.bytes > MAX_ARTIFACT_BYTES) {
    throw new TypeError(label + ".bytes must be between 1 byte and 128 MiB");
  }
  const sourceUrl = requireHttpsUrl(raw.sourceUrl, label + ".sourceUrl");
  const sourceCommitSha = requireCommit(raw.sourceCommitSha, label + ".sourceCommitSha");
  return { id, type: raw.type, status, relativePath, sha256: raw.sha256,
    bytes: raw.bytes, sourceUrl, sourceCommitSha };
}

function normalizeEvidence(raw, artifactsById, indexLabel) {
  exactKeys(raw, ["status", "artifactIds", "verificationKind"], "evidence." + indexLabel);
  if (!EVIDENCE_STATUS.has(raw.status)) throw new TypeError("evidence." + indexLabel + ".status is unsupported");
  if (!VERIFICATION_KIND.has(raw.verificationKind)) {
    throw new TypeError("evidence." + indexLabel + ".verificationKind is unsupported");
  }
  if (!Array.isArray(raw.artifactIds) || raw.artifactIds.length > 30) {
    throw new TypeError("evidence." + indexLabel + ".artifactIds must be an array of at most 30 IDs");
  }
  const artifactIds = raw.artifactIds.map((id, index) => requireId(id, "evidence." + indexLabel + ".artifactIds[" + index + "]"));
  if (new Set(artifactIds).size !== artifactIds.length) {
    throw new TypeError("evidence." + indexLabel + ".artifactIds must be unique");
  }
  for (const id of artifactIds) {
    const artifact = artifactsById.get(id);
    if (!artifact) throw new TypeError("evidence." + indexLabel + " references unknown artifact: " + id);
    if (artifact.type !== EVIDENCE_TYPES[indexLabel]) {
      throw new TypeError("evidence." + indexLabel + " references an artifact of the wrong evidence type: " + id);
    }
    if (artifact.status !== "present") {
      throw new TypeError("evidence." + indexLabel + " cannot claim a missing artifact as evidence: " + id);
    }
  }
  if (raw.status === "verified") {
    if (artifactIds.length === 0 || !["provider-test", "independent-audit"].includes(raw.verificationKind)) {
      throw new TypeError("verified evidence requires present artifacts and provider-test or independent-audit provenance");
    }
  } else if (raw.status === "synthetic-only") {
    if (artifactIds.length === 0 || raw.verificationKind !== "synthetic-test") {
      throw new TypeError("synthetic-only evidence must identify its synthetic test artifacts");
    }
  } else if (raw.status === "failed") {
    if (artifactIds.length === 0 || !["provider-test", "independent-audit"].includes(raw.verificationKind)) {
      throw new TypeError("failed evidence must retain its provider-test or independent-audit artifacts");
    }
  } else if (artifactIds.length !== 0 || raw.verificationKind !== "none") {
    throw new TypeError("missing/not-run evidence cannot claim supporting artifacts or verification provenance");
  }
  return { status: raw.status, artifactIds, verificationKind: raw.verificationKind };
}

/**
 * Normalize the D3M-25 provider qualification manifest.
 * This checks claims and evidence links; it does not establish the truth of an audit report.
 */
export function normalizeTrustRegistryProviderQualificationManifest(input = {}) {
  exactKeys(input, [
    "schemaVersion", "manifestId", "generatedAtUtc", "source", "provider",
    "conformanceCi", "providerIntegration", "artifacts", "evidence",
  ], "provider qualification manifest");
  if (input.schemaVersion !== "1.0.0") throw new TypeError("schemaVersion must be 1.0.0");
  const manifestId = requireId(input.manifestId, "manifestId");
  const generatedAtUtc = validUtc(input.generatedAtUtc, "generatedAtUtc");

  exactKeys(input.source, ["repository", "branch", "commitSha"], "source");
  if (input.source.repository !== "RakibulhasanUtsho07/3d-geospatial-platform") {
    throw new TypeError("source.repository must identify the reviewed repository");
  }
  if (!nonEmpty(input.source.branch) || input.source.branch.length > 200 ||
      !/^[A-Za-z0-9._/-]+$/.test(input.source.branch) || input.source.branch.includes("..")) {
    throw new TypeError("source.branch must be a safe branch identifier");
  }
  const source = {
    repository: input.source.repository,
    branch: input.source.branch,
    commitSha: requireCommit(input.source.commitSha, "source.commitSha"),
  };
  const provider = normalizeProvider(input.provider);

  exactKeys(input.conformanceCi, ["push", "pullRequest"], "conformanceCi");
  const conformanceCi = {
    push: normalizeCiRun(input.conformanceCi.push, "conformanceCi.push", "push"),
    pullRequest: normalizeCiRun(input.conformanceCi.pullRequest, "conformanceCi.pullRequest", "pull_request"),
  };

  const providerIntegration = normalizeProviderIntegration(input.providerIntegration);
  if (providerIntegration.status !== "not-run" && provider.status !== "provisioned") {
    throw new TypeError("provider integration cannot claim a run when the provider is not provisioned");
  }
  if (providerIntegration.status !== "not-run" &&
      (providerIntegration.providerInstanceFingerprintSha256 !== provider.instanceFingerprintSha256 ||
       providerIntegration.providerNamespaceFingerprintSha256 !== provider.namespaceFingerprintSha256)) {
    throw new TypeError("provider integration evidence is bound to a different provider instance or namespace");
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 100) {
    throw new TypeError("artifacts must be an array of at most 100 records");
  }
  const artifacts = input.artifacts.map(normalizeArtifact);
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) {
    throw new TypeError("artifact IDs must be unique");
  }
  if (new Set(artifacts.filter((item) => item.status === "present").map((item) => item.relativePath)).size !==
      artifacts.filter((item) => item.status === "present").length) {
    throw new TypeError("present evidence artifact paths must be unique");
  }
  for (const artifact of artifacts) {
    if (artifact.status === "present" && artifact.sourceCommitSha !== source.commitSha) {
      throw new TypeError("artifact " + artifact.id + " is bound to a different source commit");
    }
  }
  const totalArtifactBytes = artifacts.reduce((total, artifact) =>
    total + (artifact.status === "present" ? artifact.bytes : 0), 0);
  if (totalArtifactBytes > MAX_TOTAL_ARTIFACT_BYTES) {
    throw new TypeError("present evidence artifacts exceed the 512 MiB aggregate size limit");
  }
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  exactKeys(input.evidence, Object.keys(EVIDENCE_TYPES), "evidence");
  const evidence = {};
  for (const key of Object.keys(EVIDENCE_TYPES)) {
    evidence[key] = normalizeEvidence(input.evidence[key], artifactsById, key);
  }

  return {
    schemaVersion: "1.0.0",
    manifestId,
    generatedAtUtc,
    source,
    provider,
    conformanceCi,
    providerIntegration,
    artifacts,
    evidence,
  };
}

export function assessTrustRegistryProviderQualification(manifestInput, {
  verifiedArtifactIds = new Set(),
  artifactVerificationFailures = [],
} = {}) {
  const manifest = normalizeTrustRegistryProviderQualificationManifest(manifestInput);
  const suppliedVerified = verifiedArtifactIds instanceof Set
    ? verifiedArtifactIds
    : new Set(verifiedArtifactIds);
  const presentArtifactIds = new Set(manifest.artifacts
    .filter((artifact) => artifact.status === "present")
    .map((artifact) => artifact.id));
  const verified = new Set([...suppliedVerified].filter((id) => presentArtifactIds.has(id)));
  if (!Array.isArray(artifactVerificationFailures)) {
    throw new TypeError("artifactVerificationFailures must be an array");
  }
  const blockers = [];
  const add = (value) => { if (!blockers.includes(value)) blockers.push(value); };

  if (manifest.provider.status !== "provisioned") add("real-provider-not-provisioned");
  if (manifest.provider.syntheticOnly) add("provider-is-synthetic-only");
  if (manifest.provider.status === "provisioned" && manifest.provider.environment === "development") {
    add("provider-environment-is-not-staging-or-production");
  }
  for (const [name, run] of Object.entries(manifest.conformanceCi)) {
    if (run.headSha !== manifest.source.commitSha) add("conformance-ci-" + name + "-head-sha-mismatch");
    if (run.fullRunConclusion !== "success") add("conformance-ci-" + name + "-full-run-not-success");
    if (run.providerConformanceStepConclusion !== "success") {
      add("conformance-ci-" + name + "-provider-conformance-step-not-success");
    }
  }
  const integration = manifest.providerIntegration;
  if (integration.status !== "passed" || integration.suiteConclusion !== "success") {
    add("real-provider-integration-suite-not-passed");
  }
  if (integration.status !== "not-run" && integration.headSha !== manifest.source.commitSha) {
    add("provider-integration-head-sha-mismatch");
  }
  if (integration.syntheticOnly) add("provider-integration-is-synthetic-only");

  for (const key of Object.keys(EVIDENCE_TYPES)) {
    const item = manifest.evidence[key];
    if (item.status !== "verified") {
      add("evidence-" + item.status + ":" + key);
      continue;
    }
    for (const artifactId of item.artifactIds) {
      if (!verified.has(artifactId)) add("evidence-artifact-not-byte-verified:" + artifactId);
    }
  }
  for (const failure of artifactVerificationFailures) {
    add("artifact-verification-failed:" + String(failure.id ?? "unknown") + ":" + String(failure.code ?? "unknown"));
  }

  return Object.freeze({
    manifestId: manifest.manifestId,
    status: blockers.length === 0 ? "ready-for-independent-review" : "blocked",
    blockers,
    productionQualificationEligible: false,
    releaseFlags: Object.freeze({
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    }),
    verifiedArtifactCount: verified.size,
    requiredEvidenceCount: Object.keys(EVIDENCE_TYPES).length,
    verifiedEvidenceCount: Object.values(manifest.evidence).filter((item) => item.status === "verified").length,
  });
}

/**
 * Verify each present artifact without following a final-component symlink.
 * This establishes byte integrity inside a supplied local evidence directory,
 * not authenticity or truth of the artifact's claims.
 */
export async function verifyTrustRegistryProviderQualificationArtifacts(manifestInput, artifactRoot) {
  const manifest = normalizeTrustRegistryProviderQualificationManifest(manifestInput);
  const root = await realpath(path.resolve(artifactRoot));
  const verifiedArtifactIds = [];
  const failures = [];
  for (const artifact of manifest.artifacts) {
    if (artifact.status !== "present") continue;
    const parts = artifact.relativePath.split("/");
    let target = root;
    try {
      for (let index = 0; index < parts.length; index += 1) {
        target = path.join(target, parts[index]);
        const info = await lstat(target);
        if (info.isSymbolicLink()) throw Object.assign(new Error("symlink evidence path is not permitted"), { code: "symlink" });
        if (index < parts.length - 1 && !info.isDirectory()) {
          throw Object.assign(new Error("evidence path parent is not a directory"), { code: "not-directory" });
        }
      }
      const resolved = await realpath(target);
      if (resolved !== target || !resolved.startsWith(root + path.sep)) {
        throw Object.assign(new Error("evidence path resolves outside the artifact root"), { code: "path-escape" });
      }
      const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw Object.assign(new Error("evidence artifact is not a regular file"), { code: "not-file" });
        if (info.size !== artifact.bytes) throw Object.assign(new Error("evidence artifact byte count mismatch"), { code: "byte-count-mismatch" });
        if (info.size > MAX_ARTIFACT_BYTES) throw Object.assign(new Error("evidence artifact exceeds the size limit"), { code: "too-large" });
        const bytes = await handle.readFile();
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== artifact.sha256) throw Object.assign(new Error("evidence artifact SHA-256 mismatch"), { code: "sha256-mismatch" });
      } finally {
        await handle.close();
      }
      verifiedArtifactIds.push(artifact.id);
    } catch (error) {
      const code = error && typeof error === "object" && typeof error.code === "string"
        ? error.code
        : "read-failed";
      const safeMessages = {
        symlink: "symlink evidence path is not permitted",
        "not-directory": "evidence path parent is not a directory",
        "path-escape": "evidence path resolves outside the artifact root",
        "not-file": "evidence artifact is not a regular file",
        "byte-count-mismatch": "evidence artifact byte count mismatch",
        "too-large": "evidence artifact exceeds the size limit",
        "sha256-mismatch": "evidence artifact SHA-256 mismatch",
        ENOENT: "evidence artifact is missing",
        EACCES: "evidence artifact cannot be read",
        ELOOP: "evidence artifact path contains a symlink",
      };
      failures.push({
        id: artifact.id,
        code,
        message: safeMessages[code] ?? "evidence artifact could not be verified",
      });
    }
  }
  return Object.freeze({ verifiedArtifactIds, failures });
}

export const TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS = Object.freeze(Object.keys(EVIDENCE_TYPES));
