#!/usr/bin/env node
import { parseTrustedReconstructionReviewerKeys } from "../src/core/building-generation/source-bound-authenticated-review.mjs";

const ENV_NAME = "RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON";
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;

class PreflightError extends Error {
  constructor(errorCode, exitCode = 2) {
    super(errorCode);
    this.errorCode = errorCode;
    this.exitCode = exitCode;
  }
}

function usage() {
  console.log(
    "Usage: NODE_ENV=production npm run validate:trusted-reviewer-registry\n" +
    "Reads RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON from the process environment.\n" +
    "Never pass registry JSON on the command line. Output contains approved non-secret metadata only.\n" +
    "Exit 0: valid registry with active keys. Exit 2: missing/invalid configuration. Exit 3: valid all-revoked emergency lockout.",
  );
}

function rejectArguments(args) {
  if (args.length > 0) throw new PreflightError("unexpected-command-line-arguments");
}

function buildSummary(registry, activeKeys) {
  const activeEntries = registry.entries.filter((entry) => entry.status === "active");
  const revokedEntries = registry.entries.filter((entry) => entry.status === "revoked");
  const keys = activeKeys
    .map((entry) => ({
      keyId: entry.keyId,
      fingerprintSha256: entry.publicKeyFingerprintSha256,
      validFromUtc: entry.validFromUtc,
      validUntilUtc: entry.validUntilUtc,
    }))
    .sort((left, right) => left.keyId.localeCompare(right.keyId));

  return {
    status: keys.length > 0 ? "valid-active-registry" : "valid-emergency-lockout",
    checkedAtUtc: new Date().toISOString(),
    runtimeMode: "production",
    registry: {
      registryId: registry.registryId,
      schemaVersion: registry.schemaVersion,
      issuedAtUtc: registry.issuedAtUtc,
      expiresAtUtc: registry.expiresAtUtc,
      totalKeyRecordCount: registry.entries.length,
      activeKeyRecordCount: activeEntries.length,
      revokedKeyRecordCount: revokedEntries.length,
      activeReviewerCount: new Set(activeEntries.map((entry) => entry.reviewerId)).size,
    },
    activeKeys: keys,
    outputPolicy: "No reviewer identity details, PEM values, registry JSON or private-key material are emitted.",
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  rejectArguments(args);

  if (process.env.NODE_ENV !== "production") {
    throw new PreflightError("production-mode-required");
  }

  const rawRegistry = process.env[ENV_NAME];
  if (typeof rawRegistry !== "string" || rawRegistry.trim().length === 0) {
    throw new PreflightError("registry-secret-missing");
  }
  if (Buffer.byteLength(rawRegistry, "utf8") > MAX_REGISTRY_BYTES) {
    throw new PreflightError("registry-secret-exceeds-size-limit");
  }

  let registry;
  try {
    registry = JSON.parse(rawRegistry);
  } catch {
    throw new PreflightError("registry-json-invalid");
  }

  let activeKeys;
  try {
    activeKeys = parseTrustedReconstructionReviewerKeys(rawRegistry, { allowLegacy: false });
  } catch {
    // Deliberately suppress parser details. Diagnostics must never echo untrusted
    // registry material or any key bytes into deployment logs.
    throw new PreflightError("registry-contract-validation-failed");
  }

  const summary = buildSummary(registry, activeKeys);
  console.log(JSON.stringify(summary, null, 2));
  if (activeKeys.length === 0) process.exitCode = 3;
}

main().catch((error) => {
  const errorCode = error instanceof PreflightError ? error.errorCode : "unexpected-preflight-failure";
  const exitCode = error instanceof PreflightError ? error.exitCode : 2;
  console.error(JSON.stringify({
    status: "invalid",
    errorCode,
    message: "Trusted reviewer registry preflight did not pass; secret and key material were withheld.",
  }, null, 2));
  process.exitCode = exitCode;
});
