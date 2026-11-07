import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { canonicalJson } from "./generation-artifact-receipt.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const DOMAIN = Buffer.from("3d-geospatial-platform/d3m29-independent-anchor-witness/v1\\0", "utf8");
const PURPOSE = "independent-anchor-fresh-challenge-response-not-provider-qualification";
const REGISTRY_MAX_BYTES = 64 * 1024;
const CHALLENGE_MAX_BYTES = 64 * 1024;
const WITNESS_MAX_BYTES = 64 * 1024;
const MAX_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_KEYS = Object.freeze([
  "schemaVersion", "engine", "challengeId", "nonceHex", "issuedAtUtc", "expiresAtUtc",
  "sourceCommitSha", "providerId", "adapterModuleSha256", "syntheticOnly",
  "providerInstanceFingerprintSha256", "providerNamespaceFingerprintSha256",
]);
const WITNESS_KEYS = Object.freeze([
  "schemaVersion", "engine", "algorithm", "signaturePurpose", "challengeSha256",
  "challengeId", "nonceHex", "issuedAtUtc", "expiresAtUtc", "observedAtUtc",
  "sourceCommitSha", "providerId", "adapterModuleSha256", "syntheticOnly",
  "providerInstanceFingerprintSha256", "providerNamespaceFingerprintSha256",
  "anchorId", "keyId", "registryId", "registrySetId",
  "governancePublicKeyFingerprintSha256", "providerVersion", "monotonicSequence",
  "authoritativeStateSha256", "signatureBase64",
]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function exactKeys(value, expected, label) {
  if (!isObject(value)) throw new TypeError(label + " must be an object");
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(label + " has unsupported or missing fields");
  }
}

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a canonical safe identifier");
  }
  return value;
}

function safeHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(label + " must be a lowercase SHA-256 digest");
  }
  return value;
}

function safeCommit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new TypeError(label + " must be a full lowercase Git commit SHA");
  }
  return value;
}

function utc(value, label) {
  if (typeof value !== "string" ||
      !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value)) {
    throw new TypeError(label + " must be a canonical UTC timestamp with milliseconds");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(label + " must be a valid canonical UTC timestamp");
  }
  return parsed.getTime();
}

function parseJsonBytes(bytes, maxBytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maxBytes) {
    throw new TypeError(label + " must be a non-empty Buffer within the " + maxBytes + "-byte limit");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError(label + " must be valid UTF-8 JSON");
  }
}

function normalizeContext(context) {
  exactKeys(context, [
    "sourceCommitSha", "providerId", "adapterModuleSha256", "syntheticOnly",
    "instanceFingerprintSha256", "namespaceFingerprintSha256",
  ], "provider challenge context");
  if (typeof context.syntheticOnly !== "boolean") throw new TypeError("syntheticOnly must be boolean");
  return Object.freeze({
    sourceCommitSha: safeCommit(context.sourceCommitSha, "sourceCommitSha"),
    providerId: safeId(context.providerId, "providerId"),
    adapterModuleSha256: safeHash(context.adapterModuleSha256, "adapterModuleSha256"),
    syntheticOnly: context.syntheticOnly,
    instanceFingerprintSha256: safeHash(context.instanceFingerprintSha256, "instanceFingerprintSha256"),
    namespaceFingerprintSha256: safeHash(context.namespaceFingerprintSha256, "namespaceFingerprintSha256"),
  });
}

/**
 * Create a fresh 256-bit challenge for one exact, provisioned provider identity.
 * The caller must keep the resulting challenge bytes unchanged and give them to
 * the independently operated anchor. This function does not contact a provider.
 */
export function createTrustRegistryGovernanceProviderAnchorChallenge({
  sourceCommitSha,
  providerId,
  adapterModuleSha256,
  syntheticOnly,
  instanceFingerprintSha256,
  namespaceFingerprintSha256,
  ttlSeconds = 300,
  now = new Date(),
}) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 600) {
    throw new RangeError("ttlSeconds must be between 1 and 600");
  }
  const nowDate = new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new TypeError("now must be a valid date");
  const context = normalizeContext({
    sourceCommitSha, providerId, adapterModuleSha256, syntheticOnly,
    instanceFingerprintSha256, namespaceFingerprintSha256,
  });
  const issuedAtUtc = nowDate.toISOString();
  const expiresAtUtc = new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString();
  const challenge = Object.freeze({
    schemaVersion: "1.0.0",
    engine: "d3m29-independent-anchor-challenge-v1",
    challengeId: randomUUID(),
    nonceHex: randomBytes(32).toString("hex"),
    issuedAtUtc,
    expiresAtUtc,
    ...context,
    providerInstanceFingerprintSha256: context.instanceFingerprintSha256,
    providerNamespaceFingerprintSha256: context.namespaceFingerprintSha256,
  });
  const bytes = Buffer.from(canonicalJson(challenge) + "\\n", "utf8");
  return Object.freeze({
    challenge,
    bytes,
    challengeSha256: sha256(bytes),
    productionQualificationEligible: false,
  });
}

function signingContext(witness) {
  const context = {};
  for (const key of WITNESS_KEYS) {
    if (key !== "signatureBase64") context[key] = witness[key];
  }
  return context;
}

/**
 * Build the exact bytes an independent anchor must sign. The anchor's private
 * key must remain outside this application and its repository/CI environment.
 */
export function buildTrustRegistryGovernanceProviderAnchorWitnessSigningBytes({
  challengeBytes,
  witness,
}) {
  if (!Buffer.isBuffer(challengeBytes) || challengeBytes.length < 1 ||
      challengeBytes.length > CHALLENGE_MAX_BYTES) {
    throw new TypeError("challengeBytes must be a bounded non-empty Buffer");
  }
  exactKeys(witness, WITNESS_KEYS, "anchor witness");
  return Buffer.concat([
    DOMAIN,
    Buffer.from(canonicalJson(signingContext(witness)), "utf8"),
    Buffer.from("\\0", "utf8"),
    challengeBytes,
  ]);
}

function parseAnchorRegistry(input, nowDate) {
  if (typeof input === "string" && Buffer.byteLength(input, "utf8") > REGISTRY_MAX_BYTES) {
    throw new RangeError("Independent-anchor registry exceeds the 64 KiB limit");
  }
  let registry = input;
  if (typeof input === "string") {
    try {
      registry = JSON.parse(input);
    } catch {
      throw new TypeError("D3M29_INDEPENDENT_ANCHOR_KEYS_JSON must be valid JSON");
    }
  }
  exactKeys(registry, [
    "schemaVersion", "recordType", "registryId", "registrySetId",
    "governancePublicKeyFingerprintSha256", "issuedAtUtc", "expiresAtUtc", "entries",
  ], "independent-anchor registry");
  if (registry.schemaVersion !== "1.0.0" ||
      registry.recordType !== "d3m29-independent-anchor-key-registry") {
    throw new TypeError("independent-anchor registry schemaVersion or recordType is unsupported");
  }
  const registryId = safeId(registry.registryId, "registryId");
  const registrySetId = safeId(registry.registrySetId, "registrySetId");
  const governanceFingerprint = safeHash(
    registry.governancePublicKeyFingerprintSha256,
    "governancePublicKeyFingerprintSha256",
  );
  const issued = utc(registry.issuedAtUtc, "registry.issuedAtUtc");
  const expires = utc(registry.expiresAtUtc, "registry.expiresAtUtc");
  if (expires <= issued || expires - issued > 90 * 24 * 60 * 60 * 1000) {
    throw new TypeError("independent-anchor registry validity must be positive and at most 90 days");
  }
  const now = nowDate.getTime();
  if (now < issued || now >= expires) throw new Error("independent-anchor registry is outside its validity window");
  if (!Array.isArray(registry.entries) || registry.entries.length < 1 || registry.entries.length > 100) {
    throw new TypeError("independent-anchor registry entries must contain 1–100 key records");
  }
  const fields = [
    "anchorId", "keyId", "status", "publicKeyPem", "validFromUtc",
    "validUntilUtc", "revokedAtUtc", "replacesKeyId",
  ];
  const entries = [];
  const keyIds = new Set();
  const fingerprints = new Set();
  const activeCounts = new Map();
  for (let index = 0; index < registry.entries.length; index += 1) {
    const entry = registry.entries[index];
    exactKeys(entry, fields, "independent-anchor registry entry " + index);
    const anchorId = safeId(entry.anchorId, "entry.anchorId");
    const keyId = safeId(entry.keyId, "entry.keyId");
    if (!["active", "revoked"].includes(entry.status)) throw new TypeError("anchor key status must be active or revoked");
    if (typeof entry.publicKeyPem !== "string" || entry.publicKeyPem.length < 64 ||
        entry.publicKeyPem.length > 16 * 1024 || /PRIVATE KEY/.test(entry.publicKeyPem)) {
      throw new TypeError("anchor registry entries must contain public-key PEM only");
    }
    const validFrom = utc(entry.validFromUtc, "entry.validFromUtc");
    const validUntil = utc(entry.validUntilUtc, "entry.validUntilUtc");
    if (validUntil <= validFrom || validUntil > expires) throw new TypeError("anchor key validity window is invalid");
    if (entry.replacesKeyId !== null) safeId(entry.replacesKeyId, "entry.replacesKeyId");
    if (keyIds.has(keyId)) throw new TypeError("anchor key IDs must be unique");
    keyIds.add(keyId);
    let publicKey;
    try {
      publicKey = createPublicKey(entry.publicKeyPem);
    } catch {
      throw new TypeError("anchor public key PEM is invalid");
    }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new TypeError("independent anchor keys must use Ed25519");
    const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
    if (fingerprints.has(fingerprint)) throw new TypeError("anchor public-key fingerprints must be unique");
    fingerprints.add(fingerprint);
    let revokedAt = null;
    if (entry.status === "active") {
      if (entry.revokedAtUtc !== null) throw new TypeError("active anchor key revokedAtUtc must be null");
      if (validFrom > now || validUntil <= now) throw new Error("active anchor key is outside its validity window");
      activeCounts.set(anchorId, (activeCounts.get(anchorId) ?? 0) + 1);
    } else {
      revokedAt = utc(entry.revokedAtUtc, "entry.revokedAtUtc");
      if (revokedAt < validFrom || revokedAt > now) throw new TypeError("revoked anchor key timestamp is invalid");
    }
    entries.push({
      anchorId, keyId, status: entry.status, replacesKeyId: entry.replacesKeyId,
      revokedAt, validFrom, validUntil, publicKey, publicKeyFingerprintSha256: fingerprint,
    });
  }
  for (const [anchorId, count] of activeCounts) {
    if (count !== 1) throw new TypeError("anchor " + anchorId + " must have exactly one active key");
  }
  const byKey = new Map(entries.map((entry) => [entry.keyId, entry]));
  const replaced = new Set();
  for (const entry of entries) {
    if (entry.replacesKeyId === null) continue;
    const previous = byKey.get(entry.replacesKeyId);
    if (!previous || previous.anchorId !== entry.anchorId || previous.status !== "revoked" ||
        previous.revokedAt === null || previous.revokedAt > entry.validFrom || replaced.has(previous.keyId)) {
      throw new TypeError("anchor key replacement must reference one revoked key for the same anchor");
    }
    replaced.add(previous.keyId);
  }
  const byAnchor = new Map();
  for (const entry of entries) {
    const list = byAnchor.get(entry.anchorId) ?? [];
    list.push(entry);
    byAnchor.set(entry.anchorId, list);
  }
  for (const [anchorId, list] of byAnchor) {
    const roots = list.filter((entry) => entry.replacesKeyId === null);
    if (roots.length !== 1) throw new TypeError("anchor " + anchorId + " key history must have one root");
    const successor = new Map();
    for (const entry of list) {
      if (entry.replacesKeyId === null) continue;
      if (successor.has(entry.replacesKeyId)) throw new TypeError("anchor key history cannot fork");
      successor.set(entry.replacesKeyId, entry);
    }
    const visited = new Set();
    let current = roots[0];
    while (current) {
      if (visited.has(current.keyId)) throw new TypeError("anchor key history cannot contain a cycle");
      visited.add(current.keyId);
      current = successor.get(current.keyId) ?? null;
    }
    if (visited.size !== list.length) throw new TypeError("anchor key history contains an orphaned key");
  }
  return Object.freeze({
    registryId,
    registrySetId,
    governancePublicKeyFingerprintSha256: governanceFingerprint,
    entries: Object.freeze(entries.filter((entry) => entry.status === "active").map((entry) =>
      Object.freeze({
        anchorId: entry.anchorId,
        keyId: entry.keyId,
        publicKey: entry.publicKey,
        publicKeyFingerprintSha256: entry.publicKeyFingerprintSha256,
        validFromUtc: entry.validFrom,
        validUntilUtc: entry.validUntil,
      }))),
  });
}

function parseChallenge(bytes, nowDate) {
  const challenge = parseJsonBytes(bytes, CHALLENGE_MAX_BYTES, "anchor challenge");
  exactKeys(challenge, CHALLENGE_KEYS, "anchor challenge");
  if (challenge.schemaVersion !== "1.0.0" || challenge.engine !== "d3m29-independent-anchor-challenge-v1") {
    throw new TypeError("anchor challenge schema or engine is unsupported");
  }
  safeId(challenge.challengeId, "challengeId");
  if (typeof challenge.nonceHex !== "string" || !/^[a-f0-9]{64}$/.test(challenge.nonceHex)) {
    throw new TypeError("challenge nonce must be 256-bit lowercase hexadecimal");
  }
  const issued = utc(challenge.issuedAtUtc, "challenge.issuedAtUtc");
  const expires = utc(challenge.expiresAtUtc, "challenge.expiresAtUtc");
  if (expires <= issued || expires - issued > MAX_CHALLENGE_TTL_MS) {
    throw new TypeError("challenge validity must be positive and no longer than 10 minutes");
  }
  const now = nowDate.getTime();
  if (issued > now || expires <= now) throw new Error("anchor challenge is not fresh or has expired");
  const context = normalizeContext({
    sourceCommitSha: challenge.sourceCommitSha,
    providerId: challenge.providerId,
    adapterModuleSha256: challenge.adapterModuleSha256,
    syntheticOnly: challenge.syntheticOnly,
    instanceFingerprintSha256: challenge.providerInstanceFingerprintSha256,
    namespaceFingerprintSha256: challenge.providerNamespaceFingerprintSha256,
  });
  return { challenge, issued, expires, context };
}

/**
 * Verify an independent anchor's detached Ed25519 witness against the exact
 * fresh challenge bytes and a separately operator-pinned public-key registry.
 * A valid witness is a signed statement, not proof of organizational or
 * physical independence of the configured anchor authority.
 */
export function verifyTrustRegistryGovernanceProviderAnchorWitness({
  challengeBytes,
  witnessBytes,
  independentAnchorKeyRegistry,
  expectedContext,
  now = new Date(),
}) {
  const errors = [];
  const checks = [];
  const check = (code, ok, message) => {
    checks.push(Object.freeze({ code, passed: Boolean(ok) }));
    if (!ok) errors.push(Object.freeze({ code, message }));
  };
  let nowDate;
  try {
    nowDate = new Date(now);
  } catch {
    nowDate = new Date(Number.NaN);
  }
  check("verification-time", Number.isFinite(nowDate.getTime()), "Verification time must be valid.");
  let parsedChallenge = null;
  try {
    parsedChallenge = parseChallenge(challengeBytes, nowDate);
  } catch (error) {
    errors.push(Object.freeze({
      code: "challenge-invalid",
      message: error instanceof Error ? error.message : "Anchor challenge is invalid.",
    }));
  }
  let context = null;
  try {
    context = normalizeContext(expectedContext);
  } catch {
    errors.push(Object.freeze({ code: "expected-provider-context", message: "Expected provider context is invalid." }));
  }
  const contextMatches = Boolean(parsedChallenge && context &&
    Object.keys(context).every((key) => context[key] === parsedChallenge.context[key]));
  check("challenge-provider-context", contextMatches,
    "Challenge must bind the exact expected source, provider, adapter, instance and namespace.");
  let witness = null;
  try {
    witness = parseJsonBytes(witnessBytes, WITNESS_MAX_BYTES, "anchor witness receipt");
    exactKeys(witness, WITNESS_KEYS, "anchor witness receipt");
  } catch (error) {
    errors.push(Object.freeze({
      code: "witness-invalid",
      message: error instanceof Error ? error.message : "Anchor witness receipt is invalid.",
    }));
  }
  let envelopeValid = false;
  if (witness) {
    try {
      envelopeValid = witness.schemaVersion === "1.0.0" &&
        witness.engine === "d3m29-independent-anchor-witness-v1" &&
        witness.algorithm === "Ed25519" &&
        witness.signaturePurpose === PURPOSE &&
        SHA256.test(witness.challengeSha256 ?? "") &&
        SAFE_ID.test(witness.challengeId ?? "") &&
        /^[a-f0-9]{64}$/.test(witness.nonceHex ?? "") &&
        COMMIT.test(witness.sourceCommitSha ?? "") &&
        SAFE_ID.test(witness.providerId ?? "") &&
        SHA256.test(witness.adapterModuleSha256 ?? "") &&
        typeof witness.syntheticOnly === "boolean" &&
        SHA256.test(witness.providerInstanceFingerprintSha256 ?? "") &&
        SHA256.test(witness.providerNamespaceFingerprintSha256 ?? "") &&
        SAFE_ID.test(witness.anchorId ?? "") &&
        SAFE_ID.test(witness.keyId ?? "") &&
        SAFE_ID.test(witness.registryId ?? "") &&
        SAFE_ID.test(witness.registrySetId ?? "") &&
        SHA256.test(witness.governancePublicKeyFingerprintSha256 ?? "") &&
        typeof witness.providerVersion === "string" &&
        witness.providerVersion.length >= 1 && witness.providerVersion.length <= 256 &&
        /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/.test(witness.providerVersion) &&
        Number.isSafeInteger(witness.monotonicSequence) && witness.monotonicSequence >= 1 &&
        SHA256.test(witness.authoritativeStateSha256 ?? "") &&
        Number.isFinite(utc(witness.issuedAtUtc, "witness.issuedAtUtc")) &&
        Number.isFinite(utc(witness.expiresAtUtc, "witness.expiresAtUtc")) &&
        Number.isFinite(utc(witness.observedAtUtc, "witness.observedAtUtc")) &&
        typeof witness.signatureBase64 === "string" &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(witness.signatureBase64);
    } catch {
      envelopeValid = false;
    }
  }
  check("witness-envelope", envelopeValid, "Witness receipt must use the exact D3M-29 Ed25519 envelope.");
  const challengeHash = Buffer.isBuffer(challengeBytes) ? sha256(challengeBytes) : null;
  const challengeMatches = Boolean(parsedChallenge && witness && envelopeValid &&
    witness.challengeSha256 === challengeHash &&
    witness.challengeId === parsedChallenge.challenge.challengeId &&
    witness.nonceHex === parsedChallenge.challenge.nonceHex &&
    witness.issuedAtUtc === parsedChallenge.challenge.issuedAtUtc &&
    witness.expiresAtUtc === parsedChallenge.challenge.expiresAtUtc);
  check("fresh-challenge-binding", challengeMatches,
    "Witness must bind the exact challenge bytes, nonce, identifier and validity window.");
  const providerMatches = Boolean(parsedChallenge && witness && envelopeValid &&
    witness.sourceCommitSha === parsedChallenge.context.sourceCommitSha &&
    witness.providerId === parsedChallenge.context.providerId &&
    witness.adapterModuleSha256 === parsedChallenge.context.adapterModuleSha256 &&
    witness.syntheticOnly === parsedChallenge.context.syntheticOnly &&
    witness.providerInstanceFingerprintSha256 === parsedChallenge.context.instanceFingerprintSha256 &&
    witness.providerNamespaceFingerprintSha256 === parsedChallenge.context.namespaceFingerprintSha256 &&
    context && Object.keys(context).every((key) => context[key] === parsedChallenge.context[key]));
  check("provider-identity-binding", providerMatches,
    "Witness must bind the same exact provider, source, adapter and deployment fingerprints.");
  let observationWindow = false;
  if (parsedChallenge && witness && envelopeValid) {
    const observed = utc(witness.observedAtUtc, "witness.observedAtUtc");
    observationWindow = observed >= parsedChallenge.issued && observed <= parsedChallenge.expires &&
      observed <= nowDate.getTime();
  }
  check("witness-observation-window", observationWindow,
    "Anchor observation must occur after challenge issue, before expiry and not in the future.");
  let registry = null;
  try {
    registry = parseAnchorRegistry(independentAnchorKeyRegistry, nowDate);
  } catch (error) {
    errors.push(Object.freeze({
      code: "independent-anchor-registry-invalid",
      message: error instanceof Error ? error.message : "Independent-anchor registry is invalid.",
    }));
  }
  let matchingKeys = [];
  if (registry && witness && envelopeValid) {
    matchingKeys = registry.entries.filter((entry) =>
      entry.anchorId === witness.anchorId &&
      entry.keyId === witness.keyId &&
      entry.publicKeyFingerprintSha256 === witness.anchorPublicKeyFingerprintSha256
    );
  }
  // The key fingerprint is part of the signed envelope schema; reject an omitted or
  // substituted value before signature verification even if its registry lookup fails.
  check("anchor-registry-binding", Boolean(registry && witness && envelopeValid &&
    witness.registryId === registry.registryId &&
    witness.registrySetId === registry.registrySetId &&
    witness.governancePublicKeyFingerprintSha256 === registry.governancePublicKeyFingerprintSha256 &&
    matchingKeys.length === 1),
  "Anchor, key, registry-set and independently pinned governance-key identities must match one active registry key.");
  let keyWindowValid = false;
  if (matchingKeys.length === 1 && witness && envelopeValid) {
    const observed = Date.parse(witness.observedAtUtc);
    keyWindowValid = observed >= matchingKeys[0].validFromUtc &&
      observed < matchingKeys[0].validUntilUtc;
  }
  check("anchor-key-validity", keyWindowValid, "Witness time must fall within the active anchor-key validity window.");
  let signatureValid = false;
  if (matchingKeys.length === 1 && witness && envelopeValid && challengeMatches &&
      providerMatches && observationWindow && keyWindowValid) {
    try {
      const bytes = Buffer.from(witness.signatureBase64, "base64");
      signatureValid = bytes.length === 64 && bytes.toString("base64") === witness.signatureBase64 &&
        verify(null, buildTrustRegistryGovernanceProviderAnchorWitnessSigningBytes({
          challengeBytes, witness,
        }), matchingKeys[0].publicKey, bytes);
    } catch {
      signatureValid = false;
    }
  }
  check("ed25519-anchor-signature", signatureValid,
    "Ed25519 witness signature must authenticate exact challenge bytes and witness context.");
  return Object.freeze({
    schemaVersion: "1.0.0",
    engine: "d3m29-independent-anchor-witness-verification-v1",
    status: errors.length === 0 ? "witness-verified" : "witness-invalid",
    valid: errors.length === 0,
    anchorId: witness && SAFE_ID.test(witness.anchorId ?? "") ? witness.anchorId : null,
    keyId: witness && SAFE_ID.test(witness.keyId ?? "") ? witness.keyId : null,
    registryId: registry?.registryId ?? null,
    challengeSha256: challengeHash,
    witnessSha256: Buffer.isBuffer(witnessBytes) ? sha256(witnessBytes) : null,
    checks: Object.freeze(checks),
    errors: Object.freeze(errors),
    productionQualificationEligible: false,
  });
}

export const TRUST_REGISTRY_GOVERNANCE_PROVIDER_ANCHOR_WITNESS_SCHEMA_VERSION = "1.0.0";
