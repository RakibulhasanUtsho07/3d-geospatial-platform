#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  assessTrustRegistryProviderQualification,
  normalizeTrustRegistryProviderQualificationManifest,
  verifyTrustRegistryProviderQualificationArtifacts,
} from "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function usage() {
  console.log(
    "Usage: node scripts/validate-trust-registry-governance-provider-qualification.mjs <manifest.json> [--artifact-root DIR] [--report FILE]\n" +
    "Validates external provider identity, exact-run provenance and hash-bound independent evidence.\n" +
    "Exit code 0: valid evidence manifest (which may correctly remain blocked). Exit code 2: malformed manifest or artifact-integrity failure.",
  );
}

function parseArgs(args) {
  const out = { manifestPath: null, artifactRoot: null, reportPath: null };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifact-root" || arg === "--report") {
      if (seen.has(arg)) throw new TypeError("Option " + arg + " must be supplied at most once.");
      seen.add(arg);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError("Missing value for " + arg + ".");
      if (arg === "--artifact-root") out.artifactRoot = value;
      else out.reportPath = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new TypeError("Unknown option: " + arg);
    if (out.manifestPath) throw new TypeError("Only one manifest path may be supplied.");
    out.manifestPath = arg;
  }
  return out;
}

function safeReportPath(value) {
  if (!value) return null;
  if (path.isAbsolute(value) || value.includes("\\") ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError("Report path must be a safe relative path.");
  }
  const root = process.cwd();
  const target = path.resolve(root, ...value.split("/"));
  if (!target.startsWith(root + path.sep)) throw new TypeError("Report path escapes the working directory.");
  mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const options = parseArgs(args);
  if (!options.manifestPath) {
    usage();
    process.exitCode = 2;
    return;
  }
  const manifestPath = path.resolve(options.manifestPath);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = normalizeTrustRegistryProviderQualificationManifest(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const artifactRoot = path.resolve(options.artifactRoot ?? path.dirname(manifestPath));
  const artifactVerification = await verifyTrustRegistryProviderQualificationArtifacts(manifest, artifactRoot);
  const assessment = assessTrustRegistryProviderQualification(manifest, {
    verifiedArtifactIds: new Set(artifactVerification.verifiedArtifactIds),
    artifactVerificationFailures: artifactVerification.failures,
  });
  const report = {
    ...assessment,
    manifestSha256: sha256(manifestBytes),
    validatorSha256: sha256(readFileSync(new URL(
      "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs",
      import.meta.url,
    ))),
    artifactVerification: {
      verifiedArtifactIds: artifactVerification.verifiedArtifactIds,
      failures: artifactVerification.failures,
    },
  };
  report.reportSha256 = sha256(JSON.stringify({ ...report, reportSha256: undefined }));

  const outputPath = safeReportPath(options.reportPath);
  if (outputPath) writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({
    status: report.status,
    blockers: report.blockers,
    productionQualificationEligible: report.productionQualificationEligible,
    releaseFlags: report.releaseFlags,
    verifiedArtifactCount: report.verifiedArtifactCount,
    requiredEvidenceCount: report.requiredEvidenceCount,
    manifestSha256: report.manifestSha256,
    reportSha256: report.reportSha256,
  }, null, 2));
  if (artifactVerification.failures.length > 0) process.exitCode = 2;
}

try {
  await main();
} catch (error) {
  console.error("D3M-25 provider qualification blocked: " +
    (error instanceof Error ? error.message : "unexpected error"));
  process.exitCode = 2;
}
