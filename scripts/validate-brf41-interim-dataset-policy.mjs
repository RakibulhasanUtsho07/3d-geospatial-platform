#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateBrf41InterimDatasetPolicy } from "../src/core/building-generation/brf41-interim-dataset-policy.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function usage() {
  console.log(
    "Usage: node scripts/validate-brf41-interim-dataset-policy.mjs <manifest.json> [--report FILE]\\n" +
    "Checks interim dataset use claims and keeps unverified sources out of the production/accuracy lane.\\n" +
    "Exit code 0: policy-compliant demo-only/blocked inventory. Exit code 2: policy violation.",
  );
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError("Missing value for " + name + ".");
  return value;
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

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const manifestPath = args.find((arg) => !arg.startsWith("--"));
  if (!manifestPath) {
    usage();
    process.exitCode = 2;
    return;
  }

  const manifestBytes = readFileSync(path.resolve(manifestPath));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const report = validateBrf41InterimDatasetPolicy(manifest);
  report.manifestSha256 = sha256(manifestBytes);
  report.validatorSha256 = sha256(readFileSync(new URL("../src/core/building-generation/brf41-interim-dataset-policy.mjs", import.meta.url)));
  report.reportSha256 = sha256(JSON.stringify({ ...report, reportSha256: undefined }));

  const target = safeReportPath(optionValue(args, "--report"));
  if (target) writeFileSync(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });

  console.log(JSON.stringify({
    status: report.status,
    demoOnlyAssetCount: report.demoOnlyAssetCount,
    blockedAssetCount: report.blockedAssetCount,
    blockers: report.blockers,
    releaseFlags: report.releaseFlags,
    manifestSha256: report.manifestSha256,
    reportSha256: report.reportSha256,
  }, null, 2));
  process.exitCode = report.status.startsWith("policy-compliant-") ? 0 : 2;
}

try {
  main();
} catch (error) {
  console.error("BRF-41 interim dataset policy blocked: " + (error instanceof Error ? error.message : "unexpected error"));
  process.exitCode = 2;
}
