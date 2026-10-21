import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  signBuildingReviewPackageManifest,
  verifyBuildingReviewPackageSignature,
} from "../src/core/building-generation/building-review-package-signature.mjs";

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function signFixture(manifestBytes = Buffer.from('{"schemaVersion":"1.0.0","buildingId":"test"}')) {
  const keyPair = keys();
  const signatureEnvelope = signBuildingReviewPackageManifest({
    manifestBytes,
    privateKeyPem: keyPair.privateKeyPem,
    signedAt: "2026-10-21T12:00:00Z",
  });
  return { manifestBytes, signatureEnvelope, ...keyPair };
}

test("signs exact manifest bytes and verifies with a trusted Ed25519 public key", () => {
  const fixture = signFixture();
  const result = verifyBuildingReviewPackageSignature(fixture);
  assert.equal(result.status, "signature-verified");
  assert.equal(result.valid, true);
  assert.equal(result.manifestSha256, fixture.signatureEnvelope.manifestSha256);
  assert.equal(result.publicationEligible, false);
});

test("rejects changed manifest bytes", () => {
  const fixture = signFixture();
  const result = verifyBuildingReviewPackageSignature({
    ...fixture,
    manifestBytes: Buffer.concat([fixture.manifestBytes, Buffer.from(" ") ]),
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "signature-manifest-hash"));
});

test("rejects the wrong trusted public key", () => {
  const fixture = signFixture();
  const result = verifyBuildingReviewPackageSignature({
    ...fixture,
    trustedPublicKeyPem: keys().publicKeyPem,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "trusted-public-key-fingerprint"));
  assert.ok(result.errors.some((item) => item.id === "ed25519-signature"));
});

test("rejects signature payload tampering", () => {
  const fixture = signFixture();
  const result = verifyBuildingReviewPackageSignature({
    ...fixture,
    signatureEnvelope: {
      ...fixture.signatureEnvelope,
      signatureBase64: Buffer.alloc(64, 1).toString("base64"),
    },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "ed25519-signature"));
});

test("rejects a key from a different algorithm", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => signBuildingReviewPackageManifest({
    manifestBytes: Buffer.from("{}"),
    privateKeyPem,
  }), /requires-ed25519/);
});

test("rejects malformed inputs and unsupported envelope schemas", () => {
  assert.throws(() => signBuildingReviewPackageManifest({ manifestBytes: Buffer.alloc(0), privateKeyPem: keys().privateKeyPem }), /non-empty Buffer/);
  const fixture = signFixture();
  const invalid = verifyBuildingReviewPackageSignature({
    ...fixture,
    signatureEnvelope: { ...fixture.signatureEnvelope, algorithm: "RSA" },
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((item) => item.id === "signature-envelope"));
});
