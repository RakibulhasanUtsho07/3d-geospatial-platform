#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync,
  realpathSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  assessTrustRegistryProviderQualification,
  normalizeTrustRegistryProviderQualificationManifest,
  verifyTrustRegistryProviderQualificationArtifacts,
} from "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs";

const MAX_MANIFEST_BYTES = 1024 * 1024;
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
  const root = realpathSync(process.cwd());
  const segments = value.split("/");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    const candidate = path.join(parent, segment);
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) throw new TypeError("Report path must not traverse a symbolic link.");
      if (!info.isDirectory()) throw new TypeError("Report path parent must be a directory.");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") mkdirSync(candidate);
      else throw error;
    }
    const resolved = realpathSync(candidate);
    if (resolved !== candidate || (resolved !== root && !resolved.startsWith(root + path.sep))) {
      throw new TypeError("Report path resolves outside the working directory.");
    }
    parent = resolved;
  }
  return path.join(parent, segments.at(-1));
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
  const manifestFd = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let manifestBytes;
  try {
    const info = fstatSync(manifestFd);
    if (!info.isFile()) throw new TypeError("Manifest input must be a regular file.");
    if (info.size > MAX_MANIFEST_BYTES) throw new TypeError("Manifest exceeds the 1 MiB input limit.");
    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_MANIFEST_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_MANIFEST_BYTES + 1 - totalBytes));
      const bytesRead = readSync(manifestFd, buffer, 0, buffer.length, totalBytes);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_MANIFEST_BYTES) throw new TypeError("Manifest exceeds the 1 MiB input limit.");
    manifestBytes = Buffer.concat(chunks, totalBytes);
  } finally {
    closeSync(manifestFd);
  }
  const manifest = normalizeTrustRegistryProviderQualificationManifest(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  const artifactRoot = path.resolve(options.artifactRoot ?? path.dirname(manifestPath));
  const artifactVerification = await verifyTrustRegistryProviderQualificationArtifacts(manifest, artifactRoot);
  const assessment = assessTrustRegistryProviderQualification(manifest, {
    artifactVerification,
  });
  const report = {
    ...assessment,
    manifestSha256: sha256(manifestBytes),
    validatorSha256: sha256(readFileSync(new URL(
      "../src/core/building-generation/trust-registry-governance-provider-qualification.mjs",
      import.meta.url,
    ))),
    schemaSha256: sha256(readFileSync(new URL(
      "../trust-registry-governance-provider-qualification.schema.json",
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
