import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson } from "./generation-artifact-receipt.mjs";
import { parseTrustedReconstructionReviewerKeys } from "./source-bound-authenticated-review.mjs";
import { validateTrustRegistryGovernanceProviderProcessReport } from "./trust-registry-governance-provider-process-report.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const DOMAIN = Buffer.from("3d-geospatial-platform/trust-registry-governance-provider-process-report-signature/v1\0", "utf8");
const PURPOSE = "d3m28-process-report-attestation-not-provider-qualification";
const NOTE = "An active trusted-reviewer key attested to exact process-report bytes and context. This does not prove provider truth, independent anchor custody, rollback resistance or production qualification.";
const TRUSTED_REGISTRY_MAX_BYTES = 64 * 1024;
const REPORT_MAX_BYTES = 1024 * 1024;
const ENVELOPE_KEYS = Object.freeze([
  "schemaVersion", "engine", "algorithm", "signaturePurpose", "reportFilename",
  "processReportSha256", "sourceCommitSha", "providerId", "adapterModuleSha256",
  "adapterDeclaredSyntheticOnly", "providerInstanceFingerprintSha256",
  "providerNamespaceFingerprintSha256", "reviewerId", "keyId", "registryId",
  "publicKeyFingerprintSha256", "registryIssuedAtUtc", "registryExpiresAtUtc",
  "keyValidFromUtc", "keyValidUntilUtc", "signedAt", "productionQualificationEligible",
  "signatureBase64", "note",
]);

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonicalTimestamp = (value) => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new TypeError(label + " must be an object");
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(label + " has unsupported or missing fields");
  }
}

function readReport(reportBytes) {
  if (!Buffer.isBuffer(reportBytes) || reportBytes.length < 1 || reportBytes.length > REPORT_MAX_BYTES) {
    throw new TypeError("process report must be a non-empty Buffer no larger than 1 MiB");
  }
  let report;
  try {
    report = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reportBytes));
  } catch {
    throw new TypeError("process report must be valid UTF-8 JSON");
  }
  if (!isObject(report)) throw new TypeError("process report must be a JSON object");
  const context = {
    sourceCommitSha: report.sourceCommitSha,
    providerId: report.providerId,
    adapterModuleSha256: report.adapterModuleSha256,
    syntheticOnly: report.adapterDeclaredSyntheticOnly,
    instanceFingerprintSha256: report.providerInstanceFingerprintSha256,
    namespaceFingerprintSha256: report.providerNamespaceFingerprintSha256,
  };
  validateTrustRegistryGovernanceProviderProcessReport(report, context);
  return { report, context };
}

function registryAt(input, now) {
  if (typeof input === "string" && Buffer.byteLength(input, "utf8") > TRUSTED_REGISTRY_MAX_BYTES) {
    throw new RangeError("Trusted reviewer registry exceeds the 64 KiB limit.");
  }
  return parseTrustedReconstructionReviewerKeys(input, { now, allowLegacy: false });
}

function signingContext(envelope) {
  const context = {};
  for (const key of ENVELOPE_KEYS) {
    if (key !== "signatureBase64") context[key] = envelope[key];
  }
  return context;
}

function signingBytes(reportBytes, context) {
  return Buffer.concat([
    DOMAIN,
    Buffer.from(canonicalJson(context), "utf8"),
    Buffer.from("\0", "utf8"),
    reportBytes,
  ]);
}

/**
 * Sign exact D3M-26 report bytes using an active Ed25519 key from the
 * server-controlled, versioned trusted-reviewer registry.
 */
export function signTrustRegistryGovernanceProviderProcessReport({
  reportBytes,
  privateKeyPem,
  reviewerId,
  trustedReviewerRegistry,
  signedAt = new Date().toISOString(),
}) {
  const { report, context: reportContext } = readReport(reportBytes);
  if (typeof reviewerId !== "string" || !SAFE_ID.test(reviewerId)) {
    throw new TypeError("reviewerId must be a safe registered reviewer identifier");
  }
  if (typeof privateKeyPem !== "string" || !privateKeyPem.includes("PRIVATE KEY") ||
      privateKeyPem.includes("PUBLIC KEY")) {
    throw new TypeError("privateKeyPem must be an Ed25519 private-key PEM");
  }
  if (!canonicalTimestamp(signedAt)) {
    throw new TypeError("signedAt must be a canonical UTC timestamp with milliseconds");
  }
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("process-report-signature-requires-ed25519-private-key");
  }
  const derivedPublicKey = createPublicKey(privateKey);
  const fingerprint = digest(derivedPublicKey.export({ type: "spki", format: "der" }));
  const activeKeys = registryAt(trustedReviewerRegistry, signedAt);
  const matches = activeKeys.filter((entry) => entry.reviewerId === reviewerId);
  if (matches.length !== 1) {
    throw new Error("process-report-signer-not-uniquely-active-in-trusted-registry");
  }
  const trusted = matches[0];
  if (trusted.publicKeyFingerprintSha256 !== fingerprint) {
    throw new Error("process-report-private-key-does-not-match-active-registry-key");
  }
  const ids = [trusted.reviewerId, trusted.keyId, trusted.registryId];
  if (ids.some((value) => !SAFE_ID.test(value))) {
    throw new Error("trusted reviewer registry identifiers are not canonical");
  }
  const envelope = {
    schemaVersion: "1.0.0",
    engine: "d3m28-trust-registry-provider-process-report-signature-v1",
    algorithm: "Ed25519",
    signaturePurpose: PURPOSE,
    reportFilename: "provider-process-conformance.json",
    processReportSha256: digest(reportBytes),
    sourceCommitSha: reportContext.sourceCommitSha,
    providerId: reportContext.providerId,
    adapterModuleSha256: reportContext.adapterModuleSha256,
    adapterDeclaredSyntheticOnly: reportContext.syntheticOnly,
    providerInstanceFingerprintSha256: reportContext.instanceFingerprintSha256,
    providerNamespaceFingerprintSha256: reportContext.namespaceFingerprintSha256,
    reviewerId: trusted.reviewerId,
    keyId: trusted.keyId,
    registryId: trusted.registryId,
    publicKeyFingerprintSha256: trusted.publicKeyFingerprintSha256,
    registryIssuedAtUtc: trusted.registryIssuedAtUtc,
    registryExpiresAtUtc: trusted.registryExpiresAtUtc,
    keyValidFromUtc: trusted.validFromUtc,
    keyValidUntilUtc: trusted.validUntilUtc,
    signedAt,
    productionQualificationEligible: false,
    note: NOTE,
  };
  const signature = sign(null, signingBytes(reportBytes, envelope), privateKey);
  return Object.freeze({ ...envelope, signatureBase64: signature.toString("base64") });
}

/**
 * Verify the detached report attestation against exact report bytes, expected
 * provider context and the current active trusted-reviewer registry.
 */
export function verifyTrustRegistryGovernanceProviderProcessReportSignature({
  reportBytes,
  signatureEnvelope,
  trustedReviewerRegistry,
  expectedContext,
  now = new Date(),
}) {
  const checks = [];
  const errors = [];
  const check = (id, passed, message) => {
    const value = { id, status: passed ? "passed" : "failed", message };
    checks.push(value);
    if (!passed) errors.push(value);
  };
  let report;
  let reportContext;
  let reportReadError = null;
  try {
    const parsed = readReport(reportBytes);
    report = parsed.report;
    reportContext = parsed.context;
  } catch {
    reportReadError = true;
  }
  check("process-report", !reportReadError,
    "Process report must be bounded UTF-8 JSON and pass the D3M-26 semantic validator.");

  let expectedValid = isObject(expectedContext);
  const expectedKeys = [
    "sourceCommitSha", "providerId", "adapterModuleSha256", "syntheticOnly",
    "instanceFingerprintSha256", "namespaceFingerprintSha256",
  ];
  if (expectedValid) {
    try {
      exactKeys(expectedContext, expectedKeys, "expected provider context");
      expectedValid = COMMIT.test(expectedContext.sourceCommitSha ?? "") &&
        SAFE_ID.test(expectedContext.providerId ?? "") &&
        SHA256.test(expectedContext.adapterModuleSha256 ?? "") &&
        typeof expectedContext.syntheticOnly === "boolean" &&
        (expectedContext.syntheticOnly
          ? [expectedContext.instanceFingerprintSha256, expectedContext.namespaceFingerprintSha256]
            .every((value) => value === null || SHA256.test(value))
          : SHA256.test(expectedContext.instanceFingerprintSha256 ?? "") &&
            SHA256.test(expectedContext.namespaceFingerprintSha256 ?? ""));
    } catch {
      expectedValid = false;
    }
  }
  const contextMatches = !reportReadError && expectedValid &&
    expectedKeys.every((key) => reportContext[ key ] === expectedContext[key]);
  check("expected-provider-context", contextMatches,
    "Report source, provider, adapter and privacy-safe instance/namespace fingerprints must match the qualification manifest.");

  let envelopeValid = false;
  if (isObject(signatureEnvelope)) {
    try {
      exactKeys(signatureEnvelope, ENVELOPE_KEYS, "process report signature envelope");
      envelopeValid = signatureEnvelope.schemaVersion === "1.0.0" &&
        signatureEnvelope.engine === "d3m28-trust-registry-provider-process-report-signature-v1" &&
        signatureEnvelope.algorithm === "Ed25519" &&
        signatureEnvelope.signaturePurpose === PURPOSE &&
        signatureEnvelope.reportFilename === "provider-process-conformance.json" &&
        SHA256.test(signatureEnvelope.processReportSha256 ?? "") &&
        COMMIT.test(signatureEnvelope.sourceCommitSha ?? "") &&
        SAFE_ID.test(signatureEnvelope.providerId ?? "") &&
        SHA256.test(signatureEnvelope.adapterModuleSha256 ?? "") &&
        typeof signatureEnvelope.adapterDeclaredSyntheticOnly === "boolean" &&
        (signatureEnvelope.providerInstanceFingerprintSha256 === null ||
          SHA256.test(signatureEnvelope.providerInstanceFingerprintSha256)) &&
        (signatureEnvelope.providerNamespaceFingerprintSha256 === null ||
          SHA256.test(signatureEnvelope.providerNamespaceFingerprintSha256)) &&
        SAFE_ID.test(signatureEnvelope.reviewerId ?? "") &&
        SAFE_ID.test(signatureEnvelope.keyId ?? "") &&
        SAFE_ID.test(signatureEnvelope.registryId ?? "") &&
        SHA256.test(signatureEnvelope.publicKeyFingerprintSha256 ?? "") &&
        canonicalTimestamp(signatureEnvelope.registryIssuedAtUtc) &&
        canonicalTimestamp(signatureEnvelope.registryExpiresAtUtc) &&
        canonicalTimestamp(signatureEnvelope.keyValidFromUtc) &&
        canonicalTimestamp(signatureEnvelope.keyValidUntilUtc) &&
        canonicalTimestamp(signatureEnvelope.signedAt) &&
        signatureEnvelope.productionQualificationEligible === false &&
        signatureEnvelope.note === NOTE &&
        typeof signatureEnvelope.signatureBase64 === "string" &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signatureEnvelope.signatureBase64);
    } catch {
      envelopeValid = false;
    }
  }
  check("signature-envelope", envelopeValid,
    "Signature envelope must use the exact D3M-28 schema and package-integrity-only purpose.");
  const reportHashMatches = !reportReadError && envelopeValid &&
    signatureEnvelope.processReportSha256 === digest(reportBytes);
  check("report-byte-hash", reportHashMatches,
    "Signature must bind the exact process-report bytes.");
  const envelopeContextMatches = !reportReadError && envelopeValid && expectedValid &&
    signatureEnvelope.sourceCommitSha === reportContext.sourceCommitSha &&
    signatureEnvelope.providerId === reportContext.providerId &&
    signatureEnvelope.adapterModuleSha256 === reportContext.adapterModuleSha256 &&
    signatureEnvelope.adapterDeclaredSyntheticOnly === reportContext.syntheticOnly &&
    signatureEnvelope.providerInstanceFingerprintSha256 === reportContext.instanceFingerprintSha256 &&
    signatureEnvelope.providerNamespaceFingerprintSha256 === reportContext.namespaceFingerprintSha256 &&
    expectedKeys.every((key) => ({
      sourceCommitSha: signatureEnvelope.sourceCommitSha,
      providerId: signatureEnvelope.providerId,
      adapterModuleSha256: signatureEnvelope.adapterModuleSha256,
      syntheticOnly: signatureEnvelope.adapterDeclaredSyntheticOnly,
      instanceFingerprintSha256: signatureEnvelope.providerInstanceFingerprintSha256,
      namespaceFingerprintSha256: signatureEnvelope.providerNamespaceFingerprintSha256,
    })[key] === expectedContext[key]);
  check("report-context-binding", envelopeContextMatches,
    "Signature context must match both the exact report and qualification provider identity.");

  let nowDate;
  try {
    nowDate = new Date(now);
  } catch {
    nowDate = new Date(Number.NaN);
  }
  let activeKeys = [];
  let registryValid = false;
  try {
    activeKeys = registryAt(trustedReviewerRegistry, nowDate);
    registryValid = true;
  } catch {
    registryValid = false;
  }
  check("trusted-reviewer-registry", registryValid,
    "Current versioned trusted-reviewer registry must be valid and active.");
  let matchingKeys = [];
  if (registryValid && envelopeValid) {
    matchingKeys = activeKeys.filter((entry) =>
      entry.reviewerId === signatureEnvelope.reviewerId &&
      entry.keyId === signatureEnvelope.keyId &&
      entry.registryId === signatureEnvelope.registryId &&
      entry.publicKeyFingerprintSha256 === signatureEnvelope.publicKeyFingerprintSha256 &&
      entry.registryIssuedAtUtc === signatureEnvelope.registryIssuedAtUtc &&
      entry.registryExpiresAtUtc === signatureEnvelope.registryExpiresAtUtc &&
      entry.validFromUtc === signatureEnvelope.keyValidFromUtc &&
      entry.validUntilUtc === signatureEnvelope.keyValidUntilUtc
    );
  }
  check("trusted-reviewer-key", matchingKeys.length === 1,
    "Reviewer, key, registry, fingerprint and validity window must resolve to one active trusted key.");
  const signedAt = envelopeValid ? Date.parse(signatureEnvelope.signedAt) : Number.NaN;
  const currentTime = nowDate.getTime();
  const keyWindowValid = matchingKeys.length === 1 &&
    signedAt >= Date.parse(signatureEnvelope.keyValidFromUtc) &&
    signedAt < Date.parse(signatureEnvelope.keyValidUntilUtc) &&
    signedAt >= Date.parse(signatureEnvelope.registryIssuedAtUtc) &&
    signedAt < Date.parse(signatureEnvelope.registryExpiresAtUtc) &&
    Number.isFinite(currentTime) && signedAt <= currentTime;
  check("signer-validity-window", keyWindowValid,
    "Signature time must be within the active key and registry windows and not in the future.");

  let cryptographicValid = false;
  if (envelopeValid && reportHashMatches && envelopeContextMatches && matchingKeys.length === 1 && keyWindowValid) {
    try {
      const signatureBytes = Buffer.from(signatureEnvelope.signatureBase64, "base64");
      cryptographicValid = signatureBytes.length === 64 &&
        signatureBytes.toString("base64") === signatureEnvelope.signatureBase64 &&
        verify(null, signingBytes(reportBytes, signingContext(signatureEnvelope)),
          matchingKeys[0].publicKey, signatureBytes);
    } catch {
      cryptographicValid = false;
    }
  }
  check("ed25519-signature", cryptographicValid,
    "Ed25519 signature must authenticate exact report bytes and D3M-28 signer context.");
  return Object.freeze({
    schemaVersion: "1.0.0",
    engine: "d3m28-trust-registry-provider-process-report-signature-verification-v1",
    status: errors.length === 0 ? "signature-verified" : "signature-invalid",
    valid: errors.length === 0,
    reviewerId: envelopeValid ? signatureEnvelope.reviewerId : null,
    keyId: envelopeValid ? signatureEnvelope.keyId : null,
    registryId: envelopeValid ? signatureEnvelope.registryId : null,
    reportSha256: Buffer.isBuffer(reportBytes) ? digest(reportBytes) : null,
    checks: Object.freeze(checks),
    errors: Object.freeze(errors),
    productionQualificationEligible: false,
  });
}

export const TRUST_REGISTRY_GOVERNANCE_PROVIDER_PROCESS_REPORT_SIGNATURE_SCHEMA_VERSION = "1.0.0";
