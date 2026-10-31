import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("../scripts/validate-trusted-reviewer-registry.mjs", import.meta.url));
const ENV_NAME = "RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON";

function makeKeyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function makeRegistry(keyPair, status = "active") {
  const now = Date.now();
  const issuedAtUtc = new Date(now - 60_000).toISOString();
  const expiresAtUtc = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "production-reviewers-preflight-test",
    issuedAtUtc,
    expiresAtUtc,
    entries: [{
      reviewerId: "reviewer-opaque-01",
      keyId: "reviewer-key-2026-01",
      status,
      publicKeyPem: keyPair.publicKeyPem,
      validFromUtc: issuedAtUtc,
      validUntilUtc: expiresAtUtc,
      revokedAtUtc: status === "revoked" ? new Date(now - 30_000).toISOString() : null,
      replacesKeyId: null,
    }],
  };
}

function runCli(overrides = {}) {
  const env = { ...process.env, NODE_ENV: "production" };
  delete env[ENV_NAME];
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [CLI], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
}

function outputText(result) {
  return (result.stdout ?? "") + (result.stderr ?? "");
}

test("prints only approved non-secret metadata for a valid production registry", () => {
  const pair = makeKeyPair();
  const registry = makeRegistry(pair);
  const raw = JSON.stringify(registry);
  const result = runCli({ [ENV_NAME]: raw });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "valid-active-registry");
  assert.equal(summary.runtimeMode, "production");
  assert.equal(summary.registry.registryId, registry.registryId);
  assert.equal(summary.registry.totalKeyRecordCount, 1);
  assert.equal(summary.registry.activeKeyRecordCount, 1);
  assert.equal(summary.registry.revokedKeyRecordCount, 0);
  assert.equal(summary.registry.activeReviewerCount, 1);
  assert.equal(summary.activeKeys.length, 1);
  assert.equal(summary.activeKeys[0].keyId, "reviewer-key-2026-01");
  assert.match(summary.activeKeys[0].fingerprintSha256, /^[a-f0-9]{64}$/);
  assert.equal(summary.activeKeys[0].validFromUtc, registry.issuedAtUtc);
  assert.equal(summary.activeKeys[0].validUntilUtc, registry.expiresAtUtc);
  assert.doesNotMatch(outputText(result), /BEGIN PUBLIC KEY|BEGIN PRIVATE KEY|publicKeyPem|privateKeyPem/i);
  assert.equal(outputText(result).includes(raw), false);
  assert.equal(outputText(result).includes(pair.publicKeyPem), false);
  assert.equal(outputText(result).includes(pair.privateKeyPem), false);
});

test("reports a valid all-revoked registry as an emergency lockout and exits non-zero", () => {
  const pair = makeKeyPair();
  const registry = makeRegistry(pair, "revoked");
  const result = runCli({ [ENV_NAME]: JSON.stringify(registry) });

  assert.equal(result.status, 3);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "valid-emergency-lockout");
  assert.equal(summary.registry.activeKeyRecordCount, 0);
  assert.equal(summary.registry.revokedKeyRecordCount, 1);
  assert.deepEqual(summary.activeKeys, []);
  assert.doesNotMatch(outputText(result), /BEGIN PUBLIC KEY|BEGIN PRIVATE KEY|publicKeyPem/i);
});

test("fails closed when the production registry secret is missing", () => {
  const result = runCli();
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).errorCode, "registry-secret-missing");
  assert.equal(result.stdout, "");
});

test("requires NODE_ENV=production even when a valid registry value is present", () => {
  const pair = makeKeyPair();
  const registry = makeRegistry(pair);
  const result = runCli({
    NODE_ENV: "development",
    [ENV_NAME]: JSON.stringify(registry),
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).errorCode, "production-mode-required");
  assert.doesNotMatch(outputText(result), /BEGIN PUBLIC KEY|BEGIN PRIVATE KEY|publicKeyPem/i);
});

test("redacts malformed registry content and legacy array values from errors", () => {
  const malformed = '{"privateMaterial":"never-print-this"';
  const malformedResult = runCli({ [ENV_NAME]: malformed });
  assert.equal(malformedResult.status, 2);
  assert.equal(JSON.parse(malformedResult.stderr).errorCode, "registry-json-invalid");
  assert.equal(outputText(malformedResult).includes(malformed), false);
  assert.equal(outputText(malformedResult).includes("never-print-this"), false);

  const pair = makeKeyPair();
  const legacy = JSON.stringify([{ reviewerId: "reviewer-01", publicKeyPem: pair.publicKeyPem }]);
  const legacyResult = runCli({ [ENV_NAME]: legacy });
  assert.equal(legacyResult.status, 2);
  assert.equal(JSON.parse(legacyResult.stderr).errorCode, "registry-contract-validation-failed");
  assert.equal(outputText(legacyResult).includes(legacy), false);
  assert.equal(outputText(legacyResult).includes(pair.publicKeyPem), false);
});

test("rejects oversized registry values without echoing their contents", () => {
  const oversized = "x".repeat(2 * 1024 * 1024 + 1);
  const result = runCli({ [ENV_NAME]: oversized });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).errorCode, "registry-secret-exceeds-size-limit");
  assert.equal(outputText(result).includes(oversized), false);
});

test("rejects private-key material and withholds the parser's detailed failure", () => {
  const pair = makeKeyPair();
  const registry = makeRegistry(pair);
  registry.entries[0].publicKeyPem = pair.privateKeyPem;
  const raw = JSON.stringify(registry);
  const result = runCli({ [ENV_NAME]: raw });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).errorCode, "registry-contract-validation-failed");
  assert.equal(outputText(result).includes(raw), false);
  assert.equal(outputText(result).includes(pair.privateKeyPem), false);
  assert.doesNotMatch(outputText(result), /BEGIN PRIVATE KEY/i);
});
