import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isTimestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

function publicKeyFingerprint(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" });
  return digest(der);
}

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

export function verifyBuildingReviewPackageSignature({ manifestBytes, signatureEnvelope, trustedPublicKeyPem }) {
  if (!Buffer.isBuffer(manifestBytes) || manifestBytes.length === 0) {
    throw new TypeError("manifestBytes must be a non-empty Buffer");
  }
  if (!isObject(signatureEnvelope)) throw new TypeError("signatureEnvelope must be an object");
  if (typeof trustedPublicKeyPem !== "string" || !trustedPublicKeyPem.includes("PUBLIC KEY")) {
    throw new TypeError("trustedPublicKeyPem must be a PEM public key");
  }

  const errors = [];
  const check = (id, passed, message) => {
    const entry = { id, status: passed ? "passed" : "failed", message };
    if (!passed) errors.push(entry);
    return entry;
  };
  const checks = [];
  const expectedManifestHash = digest(manifestBytes);
  const validEnvelope = signatureEnvelope.schemaVersion === "1.0.0" &&
    signatureEnvelope.engine === "building-review-package-signature-v1" &&
    signatureEnvelope.algorithm === "Ed25519" &&
    signatureEnvelope.manifestFilename === "package-manifest.json" &&
    typeof signatureEnvelope.signatureBase64 === "string" &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(signatureEnvelope.signatureBase64) &&
    signatureEnvelope.signatureBase64.length > 0 &&
    isTimestamp(signatureEnvelope.signedAt);
  checks.push(check("signature-envelope", validEnvelope,
    "Signature envelope must use the supported schema, Ed25519 algorithm, expected manifest filename and valid timestamp."));
  checks.push(check("signature-manifest-hash", signatureEnvelope.manifestSha256 === expectedManifestHash,
    "Exact package-manifest.json bytes must match the SHA-256 digest covered by the signature envelope."));

  const publicKey = createPublicKey(trustedPublicKeyPem);
  const keyTypeValid = publicKey.asymmetricKeyType === "ed25519";
  checks.push(check("trusted-public-key-type", keyTypeValid,
    "Trusted verification key must be an Ed25519 public key."));
  const fingerprint = keyTypeValid ? publicKeyFingerprint(publicKey) : null;
  checks.push(check("trusted-public-key-fingerprint", keyTypeValid &&
    signatureEnvelope.publicKeyFingerprintSha256 === fingerprint,
  "The trusted public key fingerprint must match the signer fingerprint recorded in the envelope."));

  let cryptographicSignatureValid = false;
  if (validEnvelope && keyTypeValid &&
    signatureEnvelope.manifestSha256 === expectedManifestHash &&
    signatureEnvelope.publicKeyFingerprintSha256 === fingerprint) {
    try {
      const signatureBytes = Buffer.from(signatureEnvelope.signatureBase64, "base64");
      cryptographicSignatureValid = signatureBytes.length > 0 &&
        verify(null, manifestBytes, publicKey, signatureBytes);
    } catch {
      cryptographicSignatureValid = false;
    }
  }
  checks.push(check("ed25519-signature", cryptographicSignatureValid,
    "Ed25519 signature must verify against the exact manifest bytes with the independently trusted public key."));

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
    note: "A valid signature authenticates these manifest bytes relative to the trusted public key; it is not release approval or proof of architectural accuracy.",
  };
}
