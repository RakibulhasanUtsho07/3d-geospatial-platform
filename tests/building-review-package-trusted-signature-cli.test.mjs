import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  signBuildingReviewPackageManifestWithTrustedRegistry,
  signBuildingReviewPackageManifest,
} from "../src/core/building-generation/building-review-package-signature.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGN_CLI = path.join(ROOT, "scripts/sign-building-review-package.mjs");
const VERIFY_CLI = path.join(ROOT, "scripts/verify-building-review-package-signature.mjs");
const VERIFY_SIGNED_CLI = path.join(ROOT, "scripts/verify-signed-building-review-package.mjs");
const REGISTRY_ENV = "RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON";

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function registry(publicKeyPem) {
  return {
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "cli-test-registry-2026-11",
    issuedAtUtc: "2026-11-01T00:00:00.000Z",
    expiresAtUtc: "2026-12-01T00:00:00.000Z",
    entries: [{
      reviewerId: "reviewer-cli-test",
      keyId: "reviewer-cli-key-01",
      status: "active",
      publicKeyPem,
      validFromUtc: "2026-11-01T00:00:00.000Z",
      validUntilUtc: "2026-12-01T00:00:00.000Z",
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
  };
}

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

async function makePackage(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m11-signed-review-package-"));
  const packageDir = path.join(root, "review-package");
  await mkdir(packageDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: "1.0.0",
    engine: "building-review-package-v1",
    buildingId: "cli-test-building",
    packagePurpose: "final-human-release-review",
    readiness: {
      status: "ready-for-final-human-review",
      finalHumanReviewRequired: true,
      publicationEligible: false,
    },
    artifacts: [],
    policy: {
      assetPublished: false,
      publicationEligible: false,
      finalHumanReviewRequired: true,
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(path.join(packageDir, "package-manifest.json"), manifestBytes, { flag: "wx" });
  return { root, packageDir, manifestBytes };
}

test("signing CLI refuses to sign an incomplete package; registry signature verifier still verifies signature-only path", async (t) => {
  const pair = keyPair();
  const trustedRegistry = registry(pair.publicKeyPem);
  const registryJson = JSON.stringify(trustedRegistry);
  const { packageDir, manifestBytes } = await makePackage(t);
  const privateKeyPath = path.join(path.dirname(packageDir), "reviewer-private.pem");
  const signaturePath = path.join(packageDir, "package-manifest.sig.json");
  await writeFile(privateKeyPath, pair.privateKeyPem, { mode: 0o600 });
  const env = { NODE_ENV: "production", [REGISTRY_ENV]: registryJson };

  const refused = run(SIGN_CLI, [
    packageDir,
    privateKeyPath,
    "--reviewer-id",
    "reviewer-cli-test",
  ], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /review-package-integrity-preflight-failed:before-signing/);
  assert.equal(refused.stdout.includes(registryJson), false);
  assert.equal(refused.stderr.includes(pair.privateKeyPem), false);
  await assert.rejects(lstat(signaturePath), { code: "ENOENT" });

  // Exercise the independent signature verifier with a synthetic envelope;
  // signer CLI itself correctly refuses this incomplete package.
  const envelope = signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes,
    privateKeyPem: pair.privateKeyPem,
    reviewerId: "reviewer-cli-test",
    trustedReviewerRegistry: trustedRegistry,
    signedAt: "2026-11-04T13:00:00.000Z",
  });
  await writeFile(signaturePath, JSON.stringify(envelope, null, 2) + "\n", { flag: "wx" });

  const verified = run(VERIFY_CLI, [packageDir], env);
  assert.equal(verified.status, 0, verified.stderr);
  const summary = JSON.parse(verified.stdout);
  assert.equal(summary.valid, true);
  assert.equal(summary.reviewerId, "reviewer-cli-test");
  assert.equal(verified.stdout.includes(registryJson), false);
  assert.equal(verified.stdout.includes(pair.publicKeyPem), false);

  const combined = run(VERIFY_SIGNED_CLI, [packageDir], env);
  assert.equal(combined.status, 2, combined.stderr);
  const combinedSummary = JSON.parse(combined.stdout);
  assert.equal(combinedSummary.signature, "signature-verified");
  assert.equal(combinedSummary.packageIntegrity, "tampered-or-invalid");
  assert.equal(combinedSummary.publicationEligible, false);
  assert.equal(combined.stdout.includes(registryJson), false);
  assert.equal(combined.stdout.includes(pair.privateKeyPem), false);
});

test("signing and signature verification fail closed when the trusted registry secret is missing", async (t) => {
  const pair = keyPair();
  const { packageDir, manifestBytes } = await makePackage(t);
  const privateKeyPath = path.join(path.dirname(packageDir), "reviewer-private.pem");
  await writeFile(privateKeyPath, pair.privateKeyPem, { mode: 0o600 });
  const env = { NODE_ENV: "production", [REGISTRY_ENV]: "" };

  const signAttempt = run(SIGN_CLI, [
    packageDir,
    privateKeyPath,
    "--reviewer-id",
    "reviewer-cli-test",
  ], env);
  assert.equal(signAttempt.status, 1);
  assert.match(signAttempt.stderr, /review-package-integrity-preflight-failed:before-signing/);
  assert.equal(signAttempt.stderr.includes(pair.privateKeyPem), false);

  const envelope = signBuildingReviewPackageManifestWithTrustedRegistry({
    manifestBytes,
    privateKeyPem: pair.privateKeyPem,
    reviewerId: "reviewer-cli-test",
    trustedReviewerRegistry: registry(pair.publicKeyPem),
    signedAt: "2026-11-04T13:00:00.000Z",
  });
  await writeFile(path.join(packageDir, "package-manifest.sig.json"), JSON.stringify(envelope, null, 2) + "\n", { flag: "wx" });

  const verifyAttempt = run(VERIFY_CLI, [packageDir], env);
  assert.equal(verifyAttempt.status, 1);
  assert.match(verifyAttempt.stderr, /trusted-reviewer-registry-secret-missing/);
  assert.equal(verifyAttempt.stderr.includes(pair.privateKeyPem), false);
});

test("legacy v1 verification requires an explicit public-key path", async (t) => {
  const pair = keyPair();
  const { packageDir, manifestBytes } = await makePackage(t);
  const legacy = signBuildingReviewPackageManifest({
    manifestBytes,
    privateKeyPem: pair.privateKeyPem,
    signedAt: "2026-11-04T13:00:00.000Z",
  });
  await writeFile(path.join(packageDir, "package-manifest.sig.json"), JSON.stringify(legacy, null, 2) + "\n", { flag: "wx" });
  const publicKeyPath = path.join(path.dirname(packageDir), "legacy-public.pem");
  await writeFile(publicKeyPath, pair.publicKeyPem);

  const withoutFlag = run(VERIFY_CLI, [packageDir], { NODE_ENV: "production" });
  assert.equal(withoutFlag.status, 1);
  assert.match(withoutFlag.stderr, /legacy-v1-signature-requires-explicit/);

  const withFlag = run(VERIFY_CLI, [packageDir, "--legacy-public-key", publicKeyPath], { NODE_ENV: "production" });
  assert.equal(withFlag.status, 0, withFlag.stderr);
  assert.equal(JSON.parse(withFlag.stdout).schemaVersion, "1.0.0");
});
