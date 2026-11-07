import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  signTrustRegistryGovernanceProviderProcessReport,
  verifyTrustRegistryGovernanceProviderProcessReportSignature,
} from "../src/core/building-generation/trust-registry-governance-provider-process-report-signature.mjs";

const COMMIT = "571b864037d728370bc11dc6504f8d8a8106c588";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGN_CLI = path.join(ROOT, "scripts/sign-trust-registry-governance-provider-process-report.mjs");
function runSignerCli(args, env) {
  return spawnSync(process.execPath, [SIGN_CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}


function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function registry(publicKeyPem, overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    recordType: "reconstruction-trusted-reviewer-key-registry",
    registryId: "d3m28-test-reviewers",
    issuedAtUtc: "2026-11-06T00:00:00.000Z",
    expiresAtUtc: "2026-12-01T00:00:00.000Z",
    entries: [{
      reviewerId: "d3m28-reviewer",
      keyId: "d3m28-reviewer-key-01",
      status: "active",
      publicKeyPem,
      validFromUtc: "2026-11-06T00:00:00.000Z",
      validUntilUtc: "2026-12-01T00:00:00.000Z",
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
    ...overrides,
  };
}

function reportBytes() {
  const report = {
    schemaVersion: "1.1.0",
    sourceCommitSha: COMMIT,
    providerId: "provider-staging-a",
    adapterModuleSha256: digest("adapter module"),
    adapterDeclaredSyntheticOnly: false,
    providerInstanceFingerprintSha256: digest("provider instance"),
    providerNamespaceFingerprintSha256: digest("provider namespace"),
    executionMode: "fresh-node-child-process-per-provider-operation",
    processIsolationVerified: true,
    workerProcessesStarted: 43,
    uniqueWorkerInstances: 43,
    uniqueWorkerProcessIds: 8,
    conformance: {
      providerId: "provider-staging-a",
      initializeContenders: 8,
      initializeWinners: 1,
      casContenders: 8,
      casWinners: 1,
      staleCasRejected: true,
      freshProviderReopened: true,
      freshReadMatched: true,
      ambiguousCommitRecovered: true,
      preCommitTimeoutSafeRetry: true,
      ambiguousCompetingWinnerDetected: true,
      identityIsolationVerified: true,
      finalRevision: 4,
      finalMinimumAcceptedSequence: 9,
    },
    trustBoundary: "Software conformance only. Adapter declarations are not independently authenticated. This report does not prove provider deployment, independent anchor custody, rollback resistance, security controls or production durability.",
  };
  return Buffer.from(JSON.stringify(report) + "\n");
}

function expectedContext(bytes = reportBytes()) {
  const report = JSON.parse(bytes.toString("utf8"));
  return {
    sourceCommitSha: report.sourceCommitSha,
    providerId: report.providerId,
    adapterModuleSha256: report.adapterModuleSha256,
    syntheticOnly: report.adapterDeclaredSyntheticOnly,
    instanceFingerprintSha256: report.providerInstanceFingerprintSha256,
    namespaceFingerprintSha256: report.providerNamespaceFingerprintSha256,
  };
}

function signFixture(options = {}) {
  const pair = keyPair();
  const trustedReviewerRegistry = registry(pair.publicKeyPem, options.registryOverrides);
  const bytes = reportBytes();
  const signedAt = options.signedAt ?? new Date().toISOString();
  const signatureEnvelope = signTrustRegistryGovernanceProviderProcessReport({
    reportBytes: bytes,
    privateKeyPem: pair.privateKeyPem,
    reviewerId: "d3m28-reviewer",
    trustedReviewerRegistry,
    signedAt,
  });
  return { pair, bytes, trustedReviewerRegistry, signatureEnvelope, signedAt };
}

test("D3M-28 signs exact process-report bytes with an active registry-bound Ed25519 key and matches the schema", async () => {
  const fixture = signFixture();
  const schemaPath = new URL("../trust-registry-governance-provider-process-report-signature.schema.json", import.meta.url);
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.deepEqual([...Object.keys(fixture.signatureEnvelope)].sort(), [...schema.required].sort());
  assert.equal(schema.properties.signaturePurpose.const, fixture.signatureEnvelope.signaturePurpose);
  assert.equal(schema.properties.engine.const, fixture.signatureEnvelope.engine);
  const result = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: fixture.bytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    expectedContext: expectedContext(fixture.bytes),
    now: fixture.signedAt,
  });
  assert.equal(result.status, "signature-verified");
  assert.equal(result.valid, true);
  assert.equal(result.reviewerId, "d3m28-reviewer");
  assert.equal(result.keyId, "d3m28-reviewer-key-01");
  assert.equal(result.productionQualificationEligible, false);
});

test("D3M-28 rejects exact-byte changes even when parsed report semantics are unchanged", () => {
  const fixture = signFixture();
  const changed = Buffer.concat([fixture.bytes, Buffer.from(" ")]);
  const result = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: changed,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    expectedContext: expectedContext(changed),
    now: fixture.signedAt,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "report-byte-hash"));
});

test("D3M-28 rejects report substitution and qualification-context mismatches", () => {
  const fixture = signFixture();
  const wrongContext = { ...expectedContext(fixture.bytes), providerId: "provider-other" };
  const result = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: fixture.bytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    expectedContext: wrongContext,
    now: fixture.signedAt,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "expected-provider-context"));
});

test("D3M-28 rejects a different current trusted-reviewer registry", () => {
  const fixture = signFixture();
  const other = keyPair();
  const result = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: fixture.bytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: registry(other.publicKeyPem, { registryId: "another-registry" }),
    expectedContext: expectedContext(fixture.bytes),
    now: fixture.signedAt,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "trusted-reviewer-key"));
});

test("D3M-28 rejects revoked keys and expired registries", () => {
  const fixture = signFixture();
  const revokedRegistry = {
    ...fixture.trustedReviewerRegistry,
    entries: [{
      ...fixture.trustedReviewerRegistry.entries[0],
      status: "revoked",
      revokedAtUtc: "2026-11-07T00:00:00.000Z",
    }],
  };
  const revoked = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: fixture.bytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: revokedRegistry,
    expectedContext: expectedContext(fixture.bytes),
    now: "2026-11-07T01:00:00.000Z",
  });
  assert.equal(revoked.valid, false);
  assert.ok(revoked.errors.some((item) => item.id === "trusted-reviewer-key"));

  const expired = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: fixture.bytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    expectedContext: expectedContext(fixture.bytes),
    now: "2026-12-02T00:00:00.000Z",
  });
  assert.equal(expired.valid, false);
  assert.ok(expired.errors.some((item) => item.id === "trusted-reviewer-registry"));
});

test("D3M-28 rejects future timestamps, malformed envelopes and altered signatures", () => {
  const future = signFixture({ signedAt: "2026-11-08T00:00:00.000Z" });
  const futureResult = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: future.bytes,
    signatureEnvelope: future.signatureEnvelope,
    trustedReviewerRegistry: future.trustedReviewerRegistry,
    expectedContext: expectedContext(future.bytes),
    now: "2026-11-07T23:00:00.000Z",
  });
  assert.equal(futureResult.valid, false);
  assert.ok(futureResult.errors.some((item) => item.id === "signer-validity-window"));

  const fixture = signFixture();
  for (const signatureEnvelope of [
    { ...fixture.signatureEnvelope, signatureBase64: "invalid!" },
    { ...fixture.signatureEnvelope, signatureBase64: Buffer.alloc(64, 0x44).toString("base64") },
    { ...fixture.signatureEnvelope, extra: true },
  ]) {
    const result = verifyTrustRegistryGovernanceProviderProcessReportSignature({
      reportBytes: fixture.bytes,
      signatureEnvelope,
      trustedReviewerRegistry: fixture.trustedReviewerRegistry,
      expectedContext: expectedContext(fixture.bytes),
      now: fixture.signedAt,
    });
    assert.equal(result.valid, false);
  }
});

test("D3M-28 fails closed without a versioned trusted-reviewer registry", () => {
  const fixture = signFixture();
  const result = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: fixture.bytes,
    signatureEnvelope: fixture.signatureEnvelope,
    trustedReviewerRegistry: null,
    expectedContext: expectedContext(fixture.bytes),
    now: fixture.signedAt,
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.id === "trusted-reviewer-registry"));
});

test("D3M-28 signer rejects a private key not present in the active trusted registry", () => {
  const fixture = signFixture();
  const unrelated = keyPair();
  assert.throws(() => signTrustRegistryGovernanceProviderProcessReport({
    reportBytes: fixture.bytes,
    privateKeyPem: unrelated.privateKeyPem,
    reviewerId: "d3m28-reviewer",
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    signedAt: fixture.signedAt,
  }), /does-not-match-active-registry-key/);
});


test("D3M-28 signing CLI creates a create-once signature without leaking private-key or registry material", async (t) => {
  const fixture = signFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m28-report-signature-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "provider-process-conformance.json");
  const privateKeyPath = path.join(root, "reviewer-private.pem");
  const signaturePath = path.join(root, "provider-process-conformance.json.sig.json");
  await writeFile(reportPath, fixture.bytes, { flag: "wx" });
  await writeFile(privateKeyPath, fixture.pair.privateKeyPem, { flag: "wx", mode: 0o600 });
  const registryJson = JSON.stringify(fixture.trustedReviewerRegistry);
  const env = { NODE_ENV: "production", RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON: registryJson };
  const args = [reportPath, privateKeyPath, "--reviewer-id", "d3m28-reviewer", "--signature", signaturePath];
  const result = runSignerCli(args, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(fixture.pair.privateKeyPem), false);
  assert.equal(result.stderr.includes(fixture.pair.privateKeyPem), false);
  assert.equal(result.stdout.includes(registryJson), false);
  const envelope = JSON.parse(await readFile(signaturePath, "utf8"));
  const verified = verifyTrustRegistryGovernanceProviderProcessReportSignature({
    reportBytes: fixture.bytes,
    signatureEnvelope: envelope,
    trustedReviewerRegistry: fixture.trustedReviewerRegistry,
    expectedContext: expectedContext(fixture.bytes),
    now: new Date(),
  });
  assert.equal(verified.valid, true);
  const duplicate = runSignerCli(args, env);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already exists|signing failed/i);
});

test("D3M-28 signing CLI fails closed without the registry and for symlinked private keys", async (t) => {
  const fixture = signFixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "d3m28-report-signature-cli-negative-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "provider-process-conformance.json");
  const privateKeyPath = path.join(root, "reviewer-private.pem");
  const symlinkPath = path.join(root, "reviewer-private-link.pem");
  const symlinkDirectory = path.join(root, "report-directory-link");
  const weakPrivateKeyPath = path.join(root, "reviewer-private-weak-permissions.pem");
  await writeFile(reportPath, fixture.bytes);
  await writeFile(privateKeyPath, fixture.pair.privateKeyPem, { mode: 0o600 });
  await symlink(privateKeyPath, symlinkPath);
  await symlink(root, symlinkDirectory, "dir");
  if (process.platform !== "win32") {
    await writeFile(weakPrivateKeyPath, fixture.pair.privateKeyPem, { mode: 0o644 });
  }
  const missingRegistry = runSignerCli([reportPath, privateKeyPath, "--reviewer-id", "d3m28-reviewer"], {
    NODE_ENV: "production",
    RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON: "",
  });
  assert.equal(missingRegistry.status, 1);
  assert.match(missingRegistry.stderr, /trusted-reviewer-registry-secret-missing/);
  const symlinkedKey = runSignerCli([reportPath, symlinkPath, "--reviewer-id", "d3m28-reviewer"], {
    NODE_ENV: "production",
    RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON: JSON.stringify(fixture.trustedReviewerRegistry),
  });
  assert.equal(symlinkedKey.status, 1);
  assert.match(symlinkedKey.stderr, /regular non-symlink/);

  const symlinkedReport = runSignerCli([
    path.join(symlinkDirectory, "provider-process-conformance.json"),
    privateKeyPath,
    "--reviewer-id",
    "d3m28-reviewer",
  ], {
    NODE_ENV: "production",
    RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON: JSON.stringify(fixture.trustedReviewerRegistry),
  });
  assert.equal(symlinkedReport.status, 1);
  assert.match(symlinkedReport.stderr, /symlinked directory/);

  if (process.platform !== "win32") {
    const weakPermissions = runSignerCli([reportPath, weakPrivateKeyPath, "--reviewer-id", "d3m28-reviewer"], {
      NODE_ENV: "production",
      RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON: JSON.stringify(fixture.trustedReviewerRegistry),
    });
    assert.equal(weakPermissions.status, 1);
    assert.match(weakPermissions.stderr, /permissions must deny group and other access/);
  }
  await assert.rejects(lstat(reportPath + ".sig.json"), { code: "ENOENT" });
});
