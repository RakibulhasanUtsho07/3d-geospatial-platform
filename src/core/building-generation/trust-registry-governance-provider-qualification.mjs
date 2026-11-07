import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { validateTrustRegistryGovernanceProviderProcessReport } from "./trust-registry-governance-provider-process-report.mjs";
import { verifyTrustRegistryGovernanceProviderProcessReportSignature } from "./trust-registry-governance-provider-process-report-signature.mjs";
import { verifyTrustRegistryGovernanceProviderAnchorWitness } from "./trust-registry-governance-provider-anchor-witness.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const CONCLUSIONS = new Set(["success", "failure", "in_progress", "queued", "pending"]);
const STEP_CONCLUSIONS = new Set(["success", "failure", "skipped", "pending"]);
const ARTIFACT_TYPES = new Set([
  "multi-client-concurrency-report",
  "process-restart-report",
  "process-report-signature",
  "anchor-witness-challenge",
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
const ARTIFACT_VERIFICATION_RESULTS = new WeakMap();

function normalizedManifestDigest(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

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

function normalizeProvider(raw, schemaVersion) {
  const expectedKeys = [
    "status", "providerId", "implementation", "version", "environment",
    "instanceFingerprintSha256", "namespaceFingerprintSha256", "endpointOrigin", "syntheticOnly",
  ];
  if (schemaVersion !== "1.0.0") expectedKeys.push("adapterModuleSha256");
  exactKeys(raw, expectedKeys, "provider");
  if (!["not-provisioned", "provisioned"].includes(raw.status)) {
    throw new TypeError("provider.status is unsupported");
  }
  if (typeof raw.syntheticOnly !== "boolean") throw new TypeError("provider.syntheticOnly must be boolean");
  if (raw.status === "not-provisioned") {
    if (raw.providerId !== null || raw.implementation !== null || raw.version !== null ||
        raw.environment !== "not-provisioned" || raw.instanceFingerprintSha256 !== null ||
        raw.namespaceFingerprintSha256 !== null || raw.endpointOrigin !== null || raw.syntheticOnly !== true ||
        (schemaVersion !== "1.0.0" && raw.adapterModuleSha256 !== null)) {
      throw new TypeError("not-provisioned provider must not claim a deployment identity or endpoint");
    }
    return {
      status: "not-provisioned", providerId: null, implementation: null, version: null,
      environment: "not-provisioned", instanceFingerprintSha256: null,
      namespaceFingerprintSha256: null, endpointOrigin: null, syntheticOnly: true,
      ...(schemaVersion !== "1.0.0" ? { adapterModuleSha256: null } : {}),
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
  if (schemaVersion !== "1.0.0" && !hashOk(raw.adapterModuleSha256)) {
    throw new TypeError("D3M-27 provisioned provider requires the exact adapter module SHA-256");
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
    ...(schemaVersion !== "1.0.0" ? { adapterModuleSha256: raw.adapterModuleSha256 } : {}),
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
  if (raw.syntheticOnly !== true) {
    throw new TypeError(label + ".syntheticOnly must be true because D3M-24 conformance uses a synthetic provider fixture");
  }
  return { ...raw, runUrl };
}

function normalizeProviderIntegration(raw, schemaVersion) {
  const expectedKeys = [
    "status", "runId", "runUrl", "headSha", "fullRunConclusion", "suiteConclusion", "syntheticOnly",
    "providerInstanceFingerprintSha256", "providerNamespaceFingerprintSha256",
  ];
  if (schemaVersion !== "1.0.0") expectedKeys.push("processReportArtifactId");
  if (["1.2.0", "1.3.0"].includes(schemaVersion)) expectedKeys.push("processReportSignatureArtifactId");
  exactKeys(raw, expectedKeys, "providerIntegration");
  if (!["not-run", "passed", "failed", "pending"].includes(raw.status)) {
    throw new TypeError("providerIntegration.status is unsupported");
  }
  if (typeof raw.syntheticOnly !== "boolean") throw new TypeError("providerIntegration.syntheticOnly must be boolean");
  if (raw.status === "not-run") {
    if (raw.runId !== null || raw.runUrl !== null || raw.headSha !== null ||
        raw.fullRunConclusion !== "not-run" || raw.suiteConclusion !== "not-run" || raw.syntheticOnly !== true ||
        raw.providerInstanceFingerprintSha256 !== null ||
        raw.providerNamespaceFingerprintSha256 !== null ||
        (schemaVersion !== "1.0.0" && raw.processReportArtifactId !== null) ||
        (["1.2.0", "1.3.0"].includes(schemaVersion) && raw.processReportSignatureArtifactId !== null)) {
      throw new TypeError("not-run provider integration must not claim a run, provider identity or real-provider result");
    }
    return {
      status: "not-run", runId: null, runUrl: null, headSha: null,
      fullRunConclusion: "not-run", suiteConclusion: "not-run", syntheticOnly: true,
      providerInstanceFingerprintSha256: null,
      providerNamespaceFingerprintSha256: null,
      ...(schemaVersion !== "1.0.0" ? { processReportArtifactId: null } : {}),
      ...(["1.2.0", "1.3.0"].includes(schemaVersion) ? { processReportSignatureArtifactId: null } : {}),
    };
  }
  if (!Number.isSafeInteger(raw.runId) || raw.runId < 1) throw new TypeError("providerIntegration.runId must be positive");
  const runUrl = requireHttpsUrl(raw.runUrl, "providerIntegration.runUrl");
  if (runUrl !== "https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/" + raw.runId) {
    throw new TypeError("providerIntegration.runUrl must identify the declared repository workflow run");
  }
  requireCommit(raw.headSha, "providerIntegration.headSha");
  if (!CONCLUSIONS.has(raw.fullRunConclusion)) {
    throw new TypeError("providerIntegration.fullRunConclusion is unsupported");
  }
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
  if (schemaVersion !== "1.0.0") {
    if (raw.status === "passed") requireId(raw.processReportArtifactId, "providerIntegration.processReportArtifactId");
    else if (raw.processReportArtifactId !== null) {
      throw new TypeError("providerIntegration.processReportArtifactId must be null unless integration status is passed");
    }
  }
  if (["1.2.0", "1.3.0"].includes(schemaVersion)) {
    if (raw.status === "passed") requireId(raw.processReportSignatureArtifactId, "providerIntegration.processReportSignatureArtifactId");
    else if (raw.processReportSignatureArtifactId !== null) {
      throw new TypeError("providerIntegration.processReportSignatureArtifactId must be null unless integration status is passed");
    }
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
    if (indexLabel === "independentSecurityReview" && raw.verificationKind !== "independent-audit") {
      throw new TypeError("independentSecurityReview requires independent-audit provenance");
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
  const manifestKeys = [
    "schemaVersion", "manifestId", "generatedAtUtc", "source", "provider",
    "conformanceCi", "providerIntegration", "artifacts", "evidence",
  ];
  if (input?.schemaVersion === "1.3.0") manifestKeys.push("independentAnchorWitness");
  exactKeys(input, manifestKeys, "provider qualification manifest");
  if (!["1.0.0", "1.1.0", "1.2.0", "1.3.0"].includes(input.schemaVersion)) {
    throw new TypeError("schemaVersion must be 1.0.0, 1.1.0, 1.2.0 or 1.3.0");
  }
  const schemaVersion = input.schemaVersion;
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
  const provider = normalizeProvider(input.provider, schemaVersion);

  exactKeys(input.conformanceCi, ["push", "pullRequest"], "conformanceCi");
  const conformanceCi = {
    push: normalizeCiRun(input.conformanceCi.push, "conformanceCi.push", "push"),
    pullRequest: normalizeCiRun(input.conformanceCi.pullRequest, "conformanceCi.pullRequest", "pull_request"),
  };

  const providerIntegration = normalizeProviderIntegration(input.providerIntegration, schemaVersion);
  if (providerIntegration.status !== "not-run" && provider.status !== "provisioned") {
    throw new TypeError("provider integration cannot claim a run when the provider is not provisioned");
  }
  if (providerIntegration.status !== "not-run" &&
      (providerIntegration.runId === conformanceCi.push.runId ||
       providerIntegration.runId === conformanceCi.pullRequest.runId)) {
    throw new TypeError("provider integration must use a separate run from the D3M-24 synthetic conformance workflows");
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
  let independentAnchorWitness = null;
  if (schemaVersion === "1.3.0") {
    exactKeys(input.independentAnchorWitness,
      ["status", "challengeArtifactId", "witnessArtifactId"], "independentAnchorWitness");
    if (!["not-run", "verified"].includes(input.independentAnchorWitness.status)) {
      throw new TypeError("independentAnchorWitness.status must be not-run or verified");
    }
    const witnessStatus = input.independentAnchorWitness.status;
    if (witnessStatus === "not-run") {
      if (input.independentAnchorWitness.challengeArtifactId !== null ||
          input.independentAnchorWitness.witnessArtifactId !== null) {
        throw new TypeError("not-run independentAnchorWitness must not reference challenge or witness artifacts");
      }
      independentAnchorWitness = Object.freeze({ status: "not-run", challengeArtifactId: null, witnessArtifactId: null });
    } else {
      const challengeArtifactId = requireId(input.independentAnchorWitness.challengeArtifactId,
        "independentAnchorWitness.challengeArtifactId");
      const witnessArtifactId = requireId(input.independentAnchorWitness.witnessArtifactId,
        "independentAnchorWitness.witnessArtifactId");
      if (challengeArtifactId === witnessArtifactId) {
        throw new TypeError("D3M-29 challenge and witness artifact IDs must be distinct");
      }
      independentAnchorWitness = Object.freeze({ status: "verified", challengeArtifactId, witnessArtifactId });
    }
  }
  exactKeys(input.evidence, Object.keys(EVIDENCE_TYPES), "evidence");
  const evidence = {};
  for (const key of Object.keys(EVIDENCE_TYPES)) {
    evidence[key] = normalizeEvidence(input.evidence[key], artifactsById, key);
  }

  if (schemaVersion !== "1.0.0" && providerIntegration.status === "passed") {
    const reportId = providerIntegration.processReportArtifactId;
    const reportArtifact = artifactsById.get(reportId);
    if (!reportArtifact || reportArtifact.type !== "process-restart-report" || reportArtifact.status !== "present") {
      throw new TypeError("D3M-27 provider integration must reference a present process-restart-report artifact");
    }
    if (!evidence.processRestartVisibility.artifactIds.includes(reportId)) {
      throw new TypeError("D3M-27 processRestartVisibility evidence must reference the exact provider integration report artifact");
    }
    if (schemaVersion === "1.2.0" &&
        (evidence.processRestartVisibility.artifactIds.length !== 1 ||
         evidence.processRestartVisibility.artifactIds[0] !== reportId)) {
      throw new TypeError("D3M-28 processRestartVisibility must reference only the exact signed provider integration report");
    }
    if (schemaVersion === "1.2.0" && path.posix.basename(reportArtifact.relativePath) !== "provider-process-conformance.json") {
      throw new TypeError("D3M-28 process report artifact must use the canonical provider-process-conformance.json filename");
    }
    if (reportArtifact.sourceUrl !== providerIntegration.runUrl) {
      throw new TypeError("D3M-27 process report artifact source URL must identify the exact provider integration workflow run");
    }
  }
  if (schemaVersion !== "1.0.0" && evidence.processRestartVisibility.status === "verified" &&
      (providerIntegration.status !== "passed" ||
       !evidence.processRestartVisibility.artifactIds.includes(providerIntegration.processReportArtifactId))) {
    throw new TypeError("D3M-27 verified processRestartVisibility requires the exact passed provider integration report");
  }

  if (["1.2.0", "1.3.0"].includes(schemaVersion) && providerIntegration.status === "passed") {
    const signatureArtifact = artifactsById.get(providerIntegration.processReportSignatureArtifactId);
    if (!signatureArtifact || signatureArtifact.type !== "process-report-signature" || signatureArtifact.status !== "present") {
      throw new TypeError("D3M-28 provider integration must reference a present process-report-signature artifact");
    }
    if (signatureArtifact.sourceUrl !== providerIntegration.runUrl ||
        signatureArtifact.sourceCommitSha !== source.commitSha) {
      throw new TypeError("D3M-28 process-report signature artifact must identify the exact provider integration workflow run and source commit");
    }
  }

  if (schemaVersion === "1.3.0") {
    const anchorEvidence = evidence.independentAnchorCustody;
    if (independentAnchorWitness.status === "not-run") {
      if (anchorEvidence.status === "verified") {
        throw new TypeError("D3M-29 independentAnchorCustody cannot be verified without a fresh anchor witness binding");
      }
    } else {
      const challengeArtifact = artifactsById.get(independentAnchorWitness.challengeArtifactId);
      const witnessArtifact = artifactsById.get(independentAnchorWitness.witnessArtifactId);
      if (!challengeArtifact || challengeArtifact.status !== "present" ||
          challengeArtifact.type !== "anchor-witness-challenge") {
        throw new TypeError("D3M-29 requires a present anchor-witness-challenge artifact");
      }
      if (!witnessArtifact || witnessArtifact.status !== "present" ||
          witnessArtifact.type !== "anchor-independence-review") {
        throw new TypeError("D3M-29 requires a present anchor-independence-review witness artifact");
      }
      if (providerIntegration.status !== "passed" || providerIntegration.syntheticOnly || provider.syntheticOnly) {
        throw new TypeError("D3M-29 verified witness requires a passed non-synthetic provider integration");
      }
      if (challengeArtifact.sourceUrl !== providerIntegration.runUrl ||
          witnessArtifact.sourceUrl !== providerIntegration.runUrl) {
        throw new TypeError("D3M-29 challenge and witness artifacts must reference the exact provider-integration workflow run");
      }
      if (anchorEvidence.status !== "verified" || anchorEvidence.verificationKind !== "independent-audit" ||
          anchorEvidence.artifactIds.length !== 1 || anchorEvidence.artifactIds[0] !== witnessArtifact.id) {
        throw new TypeError("D3M-29 independentAnchorCustody must reference only the exact witness as independent-audit evidence");
      }
    }
  }

  return {
    schemaVersion,
    manifestId,
    generatedAtUtc,
    source,
    provider,
    conformanceCi,
    providerIntegration,
    artifacts,
    evidence,
    ...(schemaVersion === "1.3.0" ? { independentAnchorWitness } : {}),
  };
}

export function assessTrustRegistryProviderQualification(manifestInput, options = {}) {
  requireObject(options, "assessment options");
  const unsupportedOption = Object.keys(options).find((key) => key !== "artifactVerification");
  if (unsupportedOption) throw new TypeError("unsupported assessment option: " + unsupportedOption);

  const manifest = normalizeTrustRegistryProviderQualificationManifest(manifestInput);
  const blockers = [];
  const add = (value) => { if (!blockers.includes(value)) blockers.push(value); };
  let verified = new Set();
  let artifactVerificationFailures = [];
  const artifactVerification = options.artifactVerification ?? null;

  if (artifactVerification !== null) {
    const verification = ARTIFACT_VERIFICATION_RESULTS.get(artifactVerification);
    if (!verification) {
      throw new TypeError("artifactVerification must be returned by verifyTrustRegistryProviderQualificationArtifacts");
    }
    if (verification.manifestDigest !== normalizedManifestDigest(manifest)) {
      add("artifact-verification-manifest-mismatch");
    } else {
      verified = new Set(verification.verifiedArtifactIds);
      artifactVerificationFailures = verification.failures;
    }
  } else if (manifest.artifacts.some((artifact) => artifact.status === "present")) {
    add("artifact-verification-not-performed");
  }

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
  if (manifest.schemaVersion === "1.0.0" && integration.status === "passed") {
    add("provider-process-report-not-bound");
  }
  if (integration.status === "passed" && !["1.2.0", "1.3.0"].includes(manifest.schemaVersion)) {
    add("provider-process-report-signature-not-bound");
  }
  if (manifest.schemaVersion !== "1.3.0" && manifest.evidence.independentAnchorCustody.status === "verified") {
    add("independent-anchor-witness-not-bound");
  }
  if (manifest.schemaVersion === "1.3.0") {
    if (manifest.independentAnchorWitness.status !== "verified") {
      add("independent-anchor-witness-not-verified");
    } else if (manifest.provider.syntheticOnly || manifest.providerIntegration.syntheticOnly ||
               manifest.providerIntegration.status !== "passed") {
      add("independent-anchor-witness-requires-real-provider-integration");
    }
  }
  if (integration.status !== "passed" || integration.suiteConclusion !== "success") {
    add("real-provider-integration-suite-not-passed");
  }
  if (integration.status !== "not-run" && integration.fullRunConclusion !== "success") {
    add("real-provider-integration-full-run-not-success");
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
export async function verifyTrustRegistryProviderQualificationArtifacts(manifestInput, artifactRoot, options = {}) {
  requireObject(options, "artifact verification options");
  const supportedOptions = new Set(["trustedReviewerRegistry", "independentAnchorKeyRegistry", "now"]);
  const unsupportedOption = Object.keys(options).find((key) => !supportedOptions.has(key));
  if (unsupportedOption) throw new TypeError("unsupported artifact verification option: " + unsupportedOption);
  const trustedReviewerRegistry = options.trustedReviewerRegistry ?? process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
  const independentAnchorKeyRegistry = options.independentAnchorKeyRegistry ?? process.env.D3M29_INDEPENDENT_ANCHOR_KEYS_JSON;
  const verificationNow = options.now ?? new Date();
  const manifest = normalizeTrustRegistryProviderQualificationManifest(manifestInput);
  const root = await realpath(path.resolve(artifactRoot));
  const verifiedArtifactIds = [];
  const failures = [];
  for (const artifact of manifest.artifacts) {
    if (artifact.status !== "present") continue;
    // Detached signatures/witnesses are verified jointly with their exact source bytes;
    // never count their file hash alone as authenticated evidence.
    if (artifact.type === "process-report-signature" ||
        (manifest.schemaVersion === "1.3.0" && artifact.id === manifest.independentAnchorWitness.witnessArtifactId)) continue;
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
        if (artifact.id === manifest.providerIntegration.processReportArtifactId &&
            manifest.providerIntegration.status === "passed") {
          if (bytes.length > 1024 * 1024) {
            throw Object.assign(new Error("process-isolated provider report exceeds the 1 MiB limit"), {
              code: "process-report-too-large",
            });
          }
          let processReport;
          try {
            processReport = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          } catch {
            throw Object.assign(new Error("process-isolated provider report is not valid UTF-8 JSON"), {
              code: "process-report-invalid",
            });
          }
          try {
            validateTrustRegistryGovernanceProviderProcessReport(processReport, {
              sourceCommitSha: manifest.source.commitSha,
              providerId: manifest.provider.providerId,
              adapterModuleSha256: manifest.provider.adapterModuleSha256,
              syntheticOnly: manifest.provider.syntheticOnly,
              instanceFingerprintSha256: manifest.provider.instanceFingerprintSha256,
              namespaceFingerprintSha256: manifest.provider.namespaceFingerprintSha256,
            });
          } catch {
            throw Object.assign(new Error("process-isolated provider report does not match the qualified provider context"), {
              code: "process-report-invalid",
            });
          }
          if (["1.2.0", "1.3.0"].includes(manifest.schemaVersion) && manifest.providerIntegration.status === "passed" &&
              artifact.id === manifest.providerIntegration.processReportArtifactId) {
            const signatureArtifact = manifest.artifacts.find((item) =>
              item.id === manifest.providerIntegration.processReportSignatureArtifactId);
            if (!signatureArtifact || signatureArtifact.status !== "present" ||
                signatureArtifact.type !== "process-report-signature") {
              throw Object.assign(new Error("trusted process-report signature artifact is missing"), {
                code: "process-report-signature-missing",
              });
            }
            const signatureParts = signatureArtifact.relativePath.split("/");
            let signatureTarget = root;
            try {
              for (let partIndex = 0; partIndex < signatureParts.length; partIndex += 1) {
                signatureTarget = path.join(signatureTarget, signatureParts[partIndex]);
                const partInfo = await lstat(signatureTarget);
                if (partInfo.isSymbolicLink()) throw Object.assign(new Error("symlink"), { code: "symlink" });
                if (partIndex < signatureParts.length - 1 && !partInfo.isDirectory()) {
                  throw Object.assign(new Error("not-directory"), { code: "not-directory" });
                }
              }
              const signatureResolved = await realpath(signatureTarget);
              if (signatureResolved !== signatureTarget || !signatureResolved.startsWith(root + path.sep)) {
                throw Object.assign(new Error("path-escape"), { code: "path-escape" });
              }
              const signatureHandle = await open(signatureTarget, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
              let signatureBytes;
              try {
                const signatureInfo = await signatureHandle.stat();
                if (!signatureInfo.isFile() || signatureInfo.size !== signatureArtifact.bytes || signatureInfo.size > 64 * 1024) {
                  throw Object.assign(new Error("signature-size"), { code: "process-report-signature-invalid" });
                }
                signatureBytes = await signatureHandle.readFile();
              } finally {
                await signatureHandle.close();
              }
              if (createHash("sha256").update(signatureBytes).digest("hex") !== signatureArtifact.sha256) {
                throw Object.assign(new Error("signature-hash"), { code: "sha256-mismatch" });
              }
              let signatureEnvelope;
              try {
                signatureEnvelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signatureBytes));
              } catch {
                throw Object.assign(new Error("signature-json"), { code: "process-report-signature-invalid" });
              }
              const signatureVerification = verifyTrustRegistryGovernanceProviderProcessReportSignature({
                reportBytes: bytes,
                signatureEnvelope,
                trustedReviewerRegistry,
                expectedContext: {
                  sourceCommitSha: manifest.source.commitSha,
                  providerId: manifest.provider.providerId,
                  adapterModuleSha256: manifest.provider.adapterModuleSha256,
                  syntheticOnly: manifest.provider.syntheticOnly,
                  instanceFingerprintSha256: manifest.provider.instanceFingerprintSha256,
                  namespaceFingerprintSha256: manifest.provider.namespaceFingerprintSha256,
                },
              });
              if (!signatureVerification.valid) {
                throw new Error("trusted process-report signature did not verify");
              }
              verifiedArtifactIds.push(signatureArtifact.id);
            } catch {
              // Do not expose local path/registry/parser details in qualification diagnostics.
              throw Object.assign(new Error("trusted process-report signature could not be verified"), {
                code: "process-report-signature-invalid",
              });
            }
          }
        }
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
        "process-report-too-large": "process-isolated provider report exceeds the 1 MiB limit",
        "process-report-invalid": "process-isolated provider report does not match the qualified provider context",
        "process-report-signature-missing": "trusted process-report signature artifact is missing",
        "process-report-signature-invalid": "trusted process-report signature could not be verified",
        "independent-anchor-witness-invalid": "independent-anchor witness could not be verified against the exact fresh challenge and active operator-pinned key registry.",
        ENOENT: "evidence artifact is missing",
        EACCES: "evidence artifact cannot be read",
        ELOOP: "evidence artifact path contains a symlink",
      };
      const failureId = ["process-report-signature-invalid", "process-report-signature-missing"].includes(code)
        ? manifest.providerIntegration.processReportSignatureArtifactId ?? artifact.id
        : artifact.id;
      failures.push({
        id: failureId,
        code,
        message: safeMessages[code] ?? "evidence artifact could not be verified",
      });
    }
  }
  if (manifest.schemaVersion === "1.3.0" && manifest.independentAnchorWitness.status === "verified") {
    const challengeArtifact = manifest.artifacts.find((item) =>
      item.id === manifest.independentAnchorWitness.challengeArtifactId);
    const witnessArtifact = manifest.artifacts.find((item) =>
      item.id === manifest.independentAnchorWitness.witnessArtifactId);
    try {
      if (!challengeArtifact || !witnessArtifact || challengeArtifact.status !== "present" ||
          witnessArtifact.status !== "present" || challengeArtifact.type !== "anchor-witness-challenge" ||
          witnessArtifact.type !== "anchor-independence-review") {
        throw new Error("D3M-29 witness artifacts are missing or have incorrect types");
      }
      async function readBoundedArtifact(artifact, maximumBytes) {
        const parts = artifact.relativePath.split("/");
        let target = root;
        for (let index = 0; index < parts.length; index += 1) {
          target = path.join(target, parts[index]);
          const info = await lstat(target);
          if (info.isSymbolicLink()) throw new Error("symlink evidence path is not permitted");
          if (index < parts.length - 1 && !info.isDirectory()) throw new Error("evidence path parent is not a directory");
        }
        const resolved = await realpath(target);
        if (resolved !== target || !resolved.startsWith(root + path.sep)) throw new Error("evidence path escapes its root");
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size !== artifact.bytes || info.size > maximumBytes) {
            throw new Error("evidence artifact size or type is invalid");
          }
          const bytes = await handle.readFile();
          if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
            throw new Error("evidence artifact SHA-256 mismatch");
          }
          return bytes;
        } finally {
          await handle.close();
        }
      }
      const [challengeBytes, witnessBytes] = await Promise.all([
        readBoundedArtifact(challengeArtifact, 64 * 1024),
        readBoundedArtifact(witnessArtifact, 64 * 1024),
      ]);
      const witnessVerification = verifyTrustRegistryGovernanceProviderAnchorWitness({
        challengeBytes,
        witnessBytes,
        independentAnchorKeyRegistry,
        expectedContext: {
          sourceCommitSha: manifest.source.commitSha,
          providerId: manifest.provider.providerId,
          adapterModuleSha256: manifest.provider.adapterModuleSha256,
          syntheticOnly: manifest.provider.syntheticOnly,
          instanceFingerprintSha256: manifest.provider.instanceFingerprintSha256,
          namespaceFingerprintSha256: manifest.provider.namespaceFingerprintSha256,
        },
        now: verificationNow,
      });
      if (!witnessVerification.valid) throw new Error("D3M-29 anchor witness signature or context is invalid");
      verifiedArtifactIds.push(challengeArtifact.id, witnessArtifact.id);
    } catch {
      failures.push({
        id: manifest.independentAnchorWitness.witnessArtifactId,
        code: "independent-anchor-witness-invalid",
        message: "Independent-anchor witness could not be verified against the exact fresh challenge and active operator-pinned key registry.",
      });
    }
  }
  const immutableVerifiedArtifactIds = Object.freeze([...new Set(verifiedArtifactIds)]);
  const immutableFailures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  const result = Object.freeze({
    verifiedArtifactIds: immutableVerifiedArtifactIds,
    failures: immutableFailures,
  });
  ARTIFACT_VERIFICATION_RESULTS.set(result, Object.freeze({
    manifestDigest: normalizedManifestDigest(manifest),
    verifiedArtifactIds: immutableVerifiedArtifactIds,
    failures: immutableFailures,
  }));
  return result;
}

export const TRUST_REGISTRY_PROVIDER_QUALIFICATION_EVIDENCE_KEYS = Object.freeze(Object.keys(EVIDENCE_TYPES));
