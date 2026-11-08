import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson } from "./generation-artifact-receipt.mjs";
import { parseTrustedReconstructionReviewerKeys } from "./source-bound-authenticated-review.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isCanonicalTimestamp = (value) => isTimestamp(value) && new Date(value).toISOString() === value;
const HASH = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const V2_DOMAIN = Buffer.from("3d-geospatial-platform/building-review-package-signature/v2\0", "utf8");
const V2_PURPOSE = "package-integrity-attestation-not-release-approval";
const V2_NOTE = "The active trusted-reviewer registry key signed exact package-manifest bytes and signer context. This attests package integrity only; it is not a human release approval, survey certification or accuracy claim.";
const V2_FIELDS = [
  "schemaVersion", "engine", "algorithm", "signaturePurpose", "manifestFilename",
  "manifestSha256", "reviewerId", "keyId", "registryId", "publicKeyFingerprintSha256",
  "registryIssuedAtUtc", "registryExpiresAtUtc", "keyValidFromUtc", "keyValidUntilUtc",
  "signedAt", "publicationEligible", "signatureBase64", "note",
];

function publicKeyFingerprint(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return digest(der);
}

function signingContext(envelope) {
  return {
    schemaVersion: envelope.schemaVersion,
    engine: envelope.engine,
    algorithm: envelope.algorithm,
    signaturePurpose: envelope.signaturePurpose,
    manifestFilename: envelope.manifestFilename,
    manifestSha256: envelope.manifestSha256,
    reviewerId: envelope.reviewerId,
    keyId: envelope.keyId,
    registryId: envelope.registryId,
    publicKeyFingerprintSha256: envelope.publicKeyFingerprintSha256,
    registryIssuedAtUtc: envelope.registryIssuedAtUtc,
    registryExpiresAtUtc: envelope.registryExpiresAtUtc,
    keyValidFromUtc: envelope.keyValidFromUtc,
    keyValidUntilUtc: envelope.keyValidUntilUtc,
    signedAt: envelope.signedAt,
    publicationEligible: envelope.publicationEligible,
    note: envelope.note,
  };
}

function v2SigningBytes(manifestBytes, context) {
  return Buffer.concat([
    V2_DOMAIN,
    Buffer.from(canonicalJson(context), "utf8"),
    Buffer.from("\0", "utf8"),
    manifestBytes,
  ]);
}

function registryAt(trustedReviewerRegistry, now) {
  if (typeof trustedReviewerRegistry === "string" &&
      Buffer.byteLength(trustedReviewerRegistry, "utf8") > 64 * 1024) {
    throw new RangeError("Trusted reviewer registry exceeds the 64 KiB configuration limit.");
  }
  return parseTrustedReconstructionReviewerKeys(trustedReviewerRegistry, {
    now,
    allowLegacy: false,
  });
}

function makeChecks() {
  const checks = [];
  const errors = [];
  const check = (id, passed, message) => {
    const entry = { id, status: passed ? "passed" : "failed", message };
    checks.push(entry);
    if (!passed) errors.push(entry);
    return entry;
  };
  return { checks, errors, check };
}

/**
 * Legacy v1 signer retained for verification/migration fixtures only.
 * New CLI signing uses the registry-bound v2 function below.
 */
export function signBuildingReviewPackageManifest({ manifestBytes, privateKeyPem, signedAt = new Date().toISOString() }) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length === 0) {
    throw new TypeError("manifestBytes must be a non-empty Buffer");
  }
  if (typeof privateKeyPem !== "string" || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new TypeError("privateKeyPem must be a PEM private key");
  }
  if (!isTimestamp(signedAt)) throw new TypeError("signedAt must be a valid timestamp");

  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("review-package-signature-requires-ed25519-private-key");
  }
  const publicKey = createPublicKey(privateKey);
  const manifestSha256 = digest(manifestBytes);
  const signature = sign(null, manifestBytes, privateKey);

  return {
    schemaVersion: "1.0.0",
    engine: "building-review-package-signature-v1",
    algorithm: "Ed25519",
    manifestFilename: "package-manifest.json",
    manifestSha256,
    publicKeyFingerprintSha256: publicKeyFingerprint(publicKey),
    signedAt: new Date(signedAt).toISOString(),
    signatureBase64: signature.toString("base64"),
    publicationEligible: false,
    note: "Detached Ed25519 signature over exact package-manifest.json bytes. The corresponding public key must be trusted independently.",
  };
}

/**
 * Creates a v2 package-integrity attestation using only the active key resolved
 * from the existing server-controlled reviewer registry. The registry contains
 * public keys only; the caller retains the private key.
 */
export function signBuildingReviewPackageManifestWithTrustedRegistry({
  manifestBytes,
  privateKeyPem,
  reviewerId,
  trustedReviewerRegistry,
  signedAt = new Date().toISOString(),
}) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length === 0) {
    throw new TypeError("manifestBytes must be a non-empty Buffer");
  }
  if (typeof privateKeyPem !== "string" || !privateKeyPem.includes("PRIVATE KEY")) {
    throw new TypeError("privateKeyPem must be a PEM private key");
  }
  if (typeof reviewerId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(reviewerId)) {
    throw new TypeError("reviewerId must be a safe registered reviewer identifier");
  }
  if (!isCanonicalTimestamp(signedAt)) {
    throw new TypeError("signedAt must be a canonical UTC timestamp with milliseconds");
  }

  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("review-package-signature-requires-ed25519-private-key");
  }
  const derivedPublicKey = createPublicKey(privateKey);
  const derivedFingerprint = publicKeyFingerprint(derivedPublicKey);
  const activeKeys = registryAt(trustedReviewerRegistry, signedAt);
  const matches = activeKeys.filter((entry) => entry.reviewerId === reviewerId);
  if (matches.length !== 1) {
    throw new Error("review-package-signer-not-uniquely-active-in-trusted-registry");
  }
  const trusted = matches[0];
  const canonicalRegistryIds = [trusted.reviewerId, trusted.keyId, trusted.registryId]
    .every((value) => /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value));
  if (!canonicalRegistryIds) {
    throw new Error("review-package-trusted-registry-identifiers-must-use-canonical-lowercase-ids");
  }
  if (trusted.publicKeyFingerprintSha256 !== derivedFingerprint) {
    throw new Error("review-package-private-key-does-not-match-active-registry-key");
  }

  const context = {
    schemaVersion: "2.0.0",
    engine: "building-review-package-signature-v2",
    algorithm: "Ed25519",
    signaturePurpose: V2_PURPOSE,
    manifestFilename: "package-manifest.json",
    manifestSha256: digest(manifestBytes),
    reviewerId: trusted.reviewerId,
    keyId: trusted.keyId,
    registryId: trusted.registryId,
    publicKeyFingerprintSha256: trusted.publicKeyFingerprintSha256,
    registryIssuedAtUtc: trusted.registryIssuedAtUtc,
    registryExpiresAtUtc: trusted.registryExpiresAtUtc,
    keyValidFromUtc: trusted.validFromUtc,
    keyValidUntilUtc: trusted.validUntilUtc,
    signedAt,
    publicationEligible: false,
    note: V2_NOTE,
  };
  const signature = sign(null, v2SigningBytes(manifestBytes, context), privateKey);
  return {
    ...context,
    signatureBase64: signature.toString("base64"),
  };
}

/**
 * Verifies a v2 signature only against a currently active key in the supplied
 * strict registry. Registry parse errors become a fail-closed verification
 * result; they are never echoed with secret-bearing parser input.
 */
export function verifyBuildingReviewPackageSignatureWithTrustedRegistry({
  manifestBytes,
  signatureEnvelope,
  trustedReviewerRegistry,
  now = new Date(),
}) {
  const { checks, errors, check } = makeChecks();
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length === 0) {
    throw new TypeError("manifestBytes must be a non-empty Buffer");
  }

  if (!isObject(signatureEnvelope)) {
    check("signature-envelope", false, "Signature envelope must be a JSON object.");
  } else {
    const keys = Object.keys(signatureEnvelope).sort();
    const expectedKeys = [...V2_FIELDS].sort();
    const exactFieldSet = keys.length === expectedKeys.length &&
      keys.every((key, index) => key === expectedKeys[index]);
    const validEnvelope = exactFieldSet &&
      signatureEnvelope.schemaVersion === "2.0.0" &&
      signatureEnvelope.engine === "building-review-package-signature-v2" &&
      signatureEnvelope.algorithm === "Ed25519" &&
      signatureEnvelope.signaturePurpose === V2_PURPOSE &&
      signatureEnvelope.manifestFilename === "package-manifest.json" &&
      HASH.test(signatureEnvelope.manifestSha256 ?? "") &&
      /^[a-z0-9][a-z0-9._-]{0,79}$/.test(signatureEnvelope.reviewerId ?? "") &&
      /^[a-z0-9][a-z0-9._-]{0,79}$/.test(signatureEnvelope.keyId ?? "") &&
      /^[a-z0-9][a-z0-9._-]{0,79}$/.test(signatureEnvelope.registryId ?? "") &&
      HASH.test(signatureEnvelope.publicKeyFingerprintSha256 ?? "") &&
      isCanonicalTimestamp(signatureEnvelope.registryIssuedAtUtc) &&
      isCanonicalTimestamp(signatureEnvelope.registryExpiresAtUtc) &&
      isCanonicalTimestamp(signatureEnvelope.keyValidFromUtc) &&
      isCanonicalTimestamp(signatureEnvelope.keyValidUntilUtc) &&
      isCanonicalTimestamp(signatureEnvelope.signedAt) &&
      signatureEnvelope.publicationEligible === false &&
      signatureEnvelope.note === V2_NOTE &&
      typeof signatureEnvelope.signatureBase64 === "string" &&
      BASE64.test(signatureEnvelope.signatureBase64) &&
      signatureEnvelope.signatureBase64.length > 0;
    check("signature-envelope", validEnvelope,
      "Signature envelope must use the exact supported v2 fields, Ed25519 package-integrity purpose and canonical timestamps.");
    check("signature-manifest-hash", signatureEnvelope.manifestSha256 === digest(manifestBytes),
      "Exact package-manifest.json bytes must match the hash covered by the signature.");
    if (!validEnvelope) {
      check("trusted-reviewer-registry-key", false, "Signer metadata cannot be resolved from an invalid signature envelope.");
      check("signer-validity-window", false, "Signer metadata cannot be checked until the signature envelope is valid.");
      check("ed25519-signature", false, "Signature bytes cannot be verified until the signature envelope is valid.");
    } else {
      let activeKeys = [];
      let registryError = null;
      try {
        activeKeys = registryAt(trustedReviewerRegistry, now);
      } catch {
        registryError = "Trusted reviewer registry is missing, invalid, expired or not yet valid.";
      }
      if (registryError) {
        check("trusted-reviewer-registry-key", false, registryError);
      } else {
        const matches = activeKeys.filter((entry) =>
          entry.reviewerId === signatureEnvelope.reviewerId &&
          entry.keyId === signatureEnvelope.keyId &&
          entry.registryId === signatureEnvelope.registryId &&
          entry.publicKeyFingerprintSha256 === signatureEnvelope.publicKeyFingerprintSha256 &&
          entry.registryIssuedAtUtc === signatureEnvelope.registryIssuedAtUtc &&
          entry.registryExpiresAtUtc === signatureEnvelope.registryExpiresAtUtc &&
          entry.validFromUtc === signatureEnvelope.keyValidFromUtc &&
          entry.validUntilUtc === signatureEnvelope.keyValidUntilUtc
        );
        check("trusted-reviewer-registry-key", matches.length === 1,
          "Signer reviewerId, keyId, registryId, fingerprint and validity interval must resolve to one currently active registry entry.");
        const signedAt = Date.parse(signatureEnvelope.signedAt);
        const nowDate = new Date(now);
        const nowValid = Number.isFinite(nowDate.getTime());
        const signedWithinKey = signedAt >= Date.parse(signatureEnvelope.keyValidFromUtc) &&
          signedAt < Date.parse(signatureEnvelope.keyValidUntilUtc);
        const signedWithinRegistry = signedAt >= Date.parse(signatureEnvelope.registryIssuedAtUtc) &&
          signedAt < Date.parse(signatureEnvelope.registryExpiresAtUtc);
        const signerNotFuture = nowValid && signedAt <= nowDate.getTime();
        check("signer-validity-window", matches.length === 1 && signedWithinKey && signedWithinRegistry && signerNotFuture,
          "Signature timestamp must be within the active key and registry validity windows and not in the future.");

        let signatureValid = false;
        if (matches.length === 1 && signedWithinKey && signedWithinRegistry && signerNotFuture) {
          try {
            const signatureBytes = Buffer.from(signatureEnvelope.signatureBase64, "base64");
            const canonicalBase64 = signatureBytes.toString("base64") === signatureEnvelope.signatureBase64;
            signatureValid = signatureBytes.length === 64 && canonicalBase64 &&
              verify(null, v2SigningBytes(manifestBytes, signingContext(signatureEnvelope)),
                matches[0].publicKey, signatureBytes);
          } catch {
            signatureValid = false;
          }
        }
        check("ed25519-signature", signatureValid,
          "Ed25519 signature must authenticate exact manifest bytes and signer context using the active registry key.");
      }
    }
  }

  return {
    schemaVersion: "2.0.0",
    engine: "building-review-package-signature-verification-v2",
    status: errors.length === 0 ? "signature-verified" : "signature-invalid",
    valid: errors.length === 0,
    manifestSha256: digest(manifestBytes),
    ...(isObject(signatureEnvelope) ? {
      reviewerId: signatureEnvelope.reviewerId ?? null,
      keyId: signatureEnvelope.keyId ?? null,
      registryId: signatureEnvelope.registryId ?? null,
      publicKeyFingerprintSha256: signatureEnvelope.publicKeyFingerprintSha256 ?? null,
      signedAt: isTimestamp(signatureEnvelope.signedAt) ? new Date(signatureEnvelope.signedAt).toISOString() : null,
    } : {}),
    checks,
    errors,
    publicationEligible: false,
    note: "A valid registry-bound signature attests exact review-package bytes only. It is not release approval, survey certification or proof of architectural accuracy.",
  };
}

/**
 * Legacy v1 verification requires an independently supplied public key.
 * New signing workflows must use the registry-bound v2 interface.
 */
export function verifyBuildingReviewPackageSignature({ manifestBytes, signatureEnvelope, trustedPublicKeyPem }) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length === 0) {
    throw new TypeError("manifestBytes must be a non-empty Buffer");
  }
  if (!isObject(signatureEnvelope)) throw new TypeError("signatureEnvelope must be an object");
  if (typeof trustedPublicKeyPem !== "string" || !trustedPublicKeyPem.includes("PUBLIC KEY")) {
    throw new TypeError("trustedPublicKeyPem must be a PEM public key");
  }

  const { checks, errors, check } = makeChecks();
  const expectedManifestHash = digest(manifestBytes);
  const validEnvelope = signatureEnvelope.schemaVersion === "1.0.0" &&
    signatureEnvelope.engine === "building-review-package-signature-v1" &&
    signatureEnvelope.algorithm === "Ed25519" &&
    signatureEnvelope.manifestFilename === "package-manifest.json" &&
    typeof signatureEnvelope.signatureBase64 === "string" &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(signatureEnvelope.signatureBase64) &&
    signatureEnvelope.signatureBase64.length > 0 &&
    isTimestamp(signatureEnvelope.signedAt);
  check("signature-envelope", validEnvelope,
    "Legacy v1 signature envelope must use the supported Ed25519 schema and timestamp.");
  check("signature-manifest-hash", signatureEnvelope.manifestSha256 === expectedManifestHash,
    "Exact package-manifest.json bytes must match the SHA-256 digest covered by the signature envelope.");

  const publicKey = createPublicKey(trustedPublicKeyPem);
  const keyTypeValid = publicKey.asymmetricKeyType === "ed25519";
  check("trusted-public-key-type", keyTypeValid,
    "Trusted verification key must be an Ed25519 public key.");
  const fingerprint = keyTypeValid ? publicKeyFingerprint(publicKey) : null;
  check("trusted-public-key-fingerprint", keyTypeValid &&
    signatureEnvelope.publicKeyFingerprintSha256 === fingerprint,
  "The trusted public key fingerprint must match the signer fingerprint recorded in the envelope.");

  let cryptographicSignatureValid = false;
  if (validEnvelope && keyTypeValid &&
    signatureEnvelope.manifestSha256 === expectedManifestHash &&
    signatureEnvelope.publicKeyFingerprintSha256 === fingerprint) {
    try {
      const signatureBytes = Buffer.from(signatureEnvelope.signatureBase64, "base64");
      cryptographicSignatureValid = signatureBytes.length === 64 &&
        signatureBytes.toString("base64") === signatureEnvelope.signatureBase64 &&
        verify(null, manifestBytes, publicKey, signatureBytes);
    } catch {
      cryptographicSignatureValid = false;
    }
  }
  check("ed25519-signature", cryptographicSignatureValid,
    "Ed25519 signature must verify against the exact manifest bytes with the explicitly supplied legacy public key.");

  return {
    schemaVersion: "1.0.0",
    engine: "building-review-package-signature-verification-v1",
    status: errors.length === 0 ? "signature-verified" : "signature-invalid",
    valid: errors.length === 0,
    manifestSha256: expectedManifestHash,
    trustedPublicKeyFingerprintSha256: fingerprint,
    signedAt: isTimestamp(signatureEnvelope.signedAt) ? new Date(signatureEnvelope.signedAt).toISOString() : null,
    checks,
    errors,
    publicationEligible: false,
    note: "Legacy v1 verification uses an explicitly supplied public key; it does not record registry-backed reviewer identity.",
  };
}
