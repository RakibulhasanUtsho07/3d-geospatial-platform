import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson } from "../src/core/building-generation/generation-artifact-receipt.mjs";
import { test } from "node:test";
import {
  buildTrustRegistryGovernanceProviderAnchorKeyRegistrySigningBytes,
  buildTrustRegistryGovernanceProviderAnchorWitnessSigningBytes,
  createTrustRegistryGovernanceProviderAnchorChallenge,
  verifyTrustRegistryGovernanceProviderAnchorWitness,
} from "../src/core/building-generation/trust-registry-governance-provider-anchor-witness.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const now = new Date("2026-11-07T12:00:00.000Z");
const context = Object.freeze({
  sourceCommitSha: "a".repeat(40),
  providerId: "dhaka-monotonic-provider",
  adapterModuleSha256: "b".repeat(64),
  syntheticOnly: true,
  instanceFingerprintSha256: "c".repeat(64),
  namespaceFingerprintSha256: "d".repeat(64),
  providerProcessReportSha256: "1".repeat(64),
  providerFinalRevision: 8,
  providerFinalMinimumAcceptedSequence: 9,
});
const governanceFingerprint = "e".repeat(64);

function fixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const anchorFingerprint = digest(publicKey.export({ type: "spki", format: "der" }));
  const governancePair = generateKeyPairSync("ed25519");
  const governancePublicKeyPem = governancePair.publicKey.export({ type: "spki", format: "pem" });
  const governanceFingerprint = digest(
    governancePair.publicKey.export({ type: "spki", format: "der" }),
  );
  const registryUnsigned = {
    schemaVersion: "1.0.0",
    recordType: "d3m29-independent-anchor-key-registry",
    registryId: "independent-anchor-registry-2026",
    registrySetId: "independent-anchor-set-01",
    governancePublicKeyFingerprintSha256: governanceFingerprint,
    governancePublicKeyPem,
    issuedAtUtc: new Date(now.getTime() - 60_000).toISOString(),
    expiresAtUtc: new Date(now.getTime() + 86_400_000).toISOString(),
    entries: [{
      anchorId: "external-anchor-a",
      keyId: "anchor-key-01",
      status: "active",
      publicKeyPem,
      validFromUtc: new Date(now.getTime() - 60_000).toISOString(),
      validUntilUtc: new Date(now.getTime() + 86_400_000).toISOString(),
      revokedAtUtc: null,
      replacesKeyId: null,
    }],
    governanceSignatureBase64: "",
  };
  const registrySignature = sign(
    null,
    buildTrustRegistryGovernanceProviderAnchorKeyRegistrySigningBytes({ registry: registryUnsigned }),
    governancePair.privateKey,
  );
  const registry = {
    ...registryUnsigned,
    governanceSignatureBase64: registrySignature.toString("base64"),
  };
  const generated = createTrustRegistryGovernanceProviderAnchorChallenge({
    sourceCommitSha: context.sourceCommitSha,
    providerId: context.providerId,
    adapterModuleSha256: context.adapterModuleSha256,
    syntheticOnly: context.syntheticOnly,
    instanceFingerprintSha256: context.instanceFingerprintSha256,
    namespaceFingerprintSha256: context.namespaceFingerprintSha256,
    providerProcessReportSha256: context.providerProcessReportSha256,
    providerFinalRevision: context.providerFinalRevision,
    providerFinalMinimumAcceptedSequence: context.providerFinalMinimumAcceptedSequence,
    ttlSeconds: 300,
    now,
  });
  const unsigned = {
    schemaVersion: "1.0.0",
    engine: "d3m29-independent-anchor-witness-v1",
    algorithm: "Ed25519",
    signaturePurpose: "independent-anchor-fresh-challenge-response-not-provider-qualification",
    challengeSha256: generated.challengeSha256,
    challengeId: generated.challenge.challengeId,
    nonceHex: generated.challenge.nonceHex,
    issuedAtUtc: generated.challenge.issuedAtUtc,
    expiresAtUtc: generated.challenge.expiresAtUtc,
    observedAtUtc: new Date(now.getTime() + 1_000).toISOString(),
    sourceCommitSha: context.sourceCommitSha,
    providerId: context.providerId,
    adapterModuleSha256: context.adapterModuleSha256,
    syntheticOnly: context.syntheticOnly,
    providerInstanceFingerprintSha256: context.instanceFingerprintSha256,
    providerNamespaceFingerprintSha256: context.namespaceFingerprintSha256,
    providerProcessReportSha256: context.providerProcessReportSha256,
    providerFinalRevision: context.providerFinalRevision,
    providerFinalMinimumAcceptedSequence: context.providerFinalMinimumAcceptedSequence,
    anchorId: "external-anchor-a",
    keyId: "anchor-key-01",
    anchorPublicKeyFingerprintSha256: anchorFingerprint,
    registryId: registry.registryId,
    registrySetId: registry.registrySetId,
    governancePublicKeyFingerprintSha256: governanceFingerprint,
    providerVersion: "anchor-version-42",
    monotonicSequence: 42,
    authoritativeStateSha256: "f".repeat(64),
    signatureBase64: "",
    ...overrides,
  };
  const signature = sign(
    null,
    buildTrustRegistryGovernanceProviderAnchorWitnessSigningBytes({
      challengeBytes: generated.bytes,
      witness: unsigned,
    }),
    privateKey,
  );
  const witness = { ...unsigned, signatureBase64: signature.toString("base64") };
  return {
    ...generated,
    witness,
    witnessBytes: Buffer.from(canonicalJson(witness) + "\n", "utf8"),
    registry,
    publicKeyPem,
    anchorFingerprint,
    privateKey,
    governancePrivateKey: governancePair.privateKey,
    governancePublicKeyPem,
    independentAnchorGovernanceKeyFingerprintSha256: governanceFingerprint,
  };
}
test("D3M-29 accepts a fresh witness signed by one active independent-anchor registry key", () => {
  const value = fixture();
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: canonicalJson(value.registry),
    independentAnchorGovernanceKeyFingerprintSha256: value.independentAnchorGovernanceKeyFingerprintSha256,
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.status, "witness-verified");
  assert.equal(report.valid, true);
  assert.equal(report.productionQualificationEligible, false);
  assert.ok(report.checks.every((item) => item.passed));
});

test("D3M-29 rejects a stale challenge even when its original witness signature is intact", () => {
  const value = fixture();
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: canonicalJson(value.registry),
    expectedContext: context,
    now: new Date(now.getTime() + 301_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "challenge-invalid"));
});

test("D3M-29 rejects a challenge/provider-context substitution", () => {
  const value = fixture();
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: canonicalJson(value.registry),
    expectedContext: { ...context, providerId: "another-provider" },
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "challenge-provider-context"));
});


test("D3M-29 rejects a witness bound to another provider process-report digest or revision", () => {
  const value = fixture();
  const changed = {
    ...value.witness,
    providerProcessReportSha256: "8".repeat(64),
    providerFinalRevision: value.witness.providerFinalRevision + 1,
  };
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: Buffer.from(canonicalJson(changed) + "\\n", "utf8"),
    independentAnchorKeyRegistry: canonicalJson(value.registry),
    independentAnchorGovernanceKeyFingerprintSha256: value.independentAnchorGovernanceKeyFingerprintSha256,
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "provider-identity-binding"));
});

test("D3M-29 rejects tampering with exact challenge bytes", () => {
  const value = fixture();
  const altered = Buffer.from(value.bytes.toString("utf8").replace(context.providerId, "altered-provider"), "utf8");
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: altered,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: canonicalJson(value.registry),
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "fresh-challenge-binding"));
});

test("D3M-29 rejects a revoked anchor key", () => {
  const value = fixture();
  const registry = structuredClone(value.registry);
  registry.entries[0].status = "revoked";
  registry.entries[0].revokedAtUtc = new Date(now.getTime() + 1_500).toISOString();
  registry.governanceSignatureBase64 = "";
  registry.governanceSignatureBase64 = sign(
    null,
    buildTrustRegistryGovernanceProviderAnchorKeyRegistrySigningBytes({ registry }),
    value.governancePrivateKey,
  ).toString("base64");
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: canonicalJson(registry),
    independentAnchorGovernanceKeyFingerprintSha256: value.independentAnchorGovernanceKeyFingerprintSha256,
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "anchor-registry-binding"));
});

test("D3M-29 rejects altered witness signature bytes", () => {
  const value = fixture();
  const changed = { ...value.witness, signatureBase64: Buffer.alloc(64, 0x55).toString("base64") };
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: Buffer.from(canonicalJson(changed) + "\n", "utf8"),
    independentAnchorKeyRegistry: canonicalJson(value.registry),
    independentAnchorGovernanceKeyFingerprintSha256: value.independentAnchorGovernanceKeyFingerprintSha256,
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "ed25519-anchor-signature"));
});

test("D3M-29 challenge nonce is fresh, 256-bit, and TTL is bounded", () => {
  const first = fixture();
  const second = fixture();
  assert.match(first.challenge.nonceHex, /^[a-f0-9]{64}$/);
  assert.notEqual(first.challenge.nonceHex, second.challenge.nonceHex);
  assert.throws(() => createTrustRegistryGovernanceProviderAnchorChallenge({
    ...context,
    ttlSeconds: 601,
    now,
  }), /between 1 and 600/);
});


test("D3M-29 rejects a registry that does not match the separately operator-pinned governance key", () => {
  const value = fixture();
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: canonicalJson(value.registry),
    independentAnchorGovernanceKeyFingerprintSha256: "9".repeat(64),
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "independently-pinned-governance-key"));
  assert.ok(report.errors.some((item) => item.code === "anchor-registry-binding"));
});



test("D3M-29 rejects non-canonical challenge and witness JSON bytes", () => {
  const value = fixture();
  const prettyChallenge = Buffer.from(JSON.stringify(value.challenge, null, 2) + "\\n", "utf8");
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: prettyChallenge,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: canonicalJson(value.registry),
    independentAnchorGovernanceKeyFingerprintSha256: value.independentAnchorGovernanceKeyFingerprintSha256,
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "challenge-invalid"));
});

test("D3M-29 rejects a registry governance signature altered after signing", () => {
  const value = fixture();
  const registry = {
    ...value.registry,
    governanceSignatureBase64: Buffer.alloc(64, 0x11).toString("base64"),
  };
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: registry,
    independentAnchorGovernanceKeyFingerprintSha256: value.independentAnchorGovernanceKeyFingerprintSha256,
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "independent-anchor-registry-invalid"));
});


test("D3M-29 rejects duplicate-key JSON in the operator registry string", () => {
  const value = fixture();
  const canonical = canonicalJson(value.registry);
  const duplicated = canonical.replace(
    '"registryId":',
    '"registryId":"substituted-registry","registryId":',
  );
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: duplicated,
    independentAnchorGovernanceKeyFingerprintSha256: value.independentAnchorGovernanceKeyFingerprintSha256,
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "independent-anchor-registry-invalid"));
});

test("D3M-29 rejects an unsigned or tampered anchor-key registry even with a matching fingerprint pin", () => {
  const value = fixture();
  const tamperedRegistry = structuredClone(value.registry);
  tamperedRegistry.entries[0].publicKeyPem = value.publicKeyPem.replace("KEY", "KEY");
  tamperedRegistry.entries[0].keyId = "attacker-substituted-key";
  const report = verifyTrustRegistryGovernanceProviderAnchorWitness({
    challengeBytes: value.bytes,
    witnessBytes: value.witnessBytes,
    independentAnchorKeyRegistry: canonicalJson(tamperedRegistry),
    independentAnchorGovernanceKeyFingerprintSha256: value.independentAnchorGovernanceKeyFingerprintSha256,
    expectedContext: context,
    now: new Date(now.getTime() + 2_000),
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((item) => item.code === "independent-anchor-registry-invalid"));
});
