#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyAndValidateBrf38RightsScope } from "../src/core/building-generation/brf38-rights-scope-gate.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function usage() {
  console.log(
    "Usage: node scripts/validate-brf38-rights-scope.mjs <manifest.json> [--asset-root DIR] [--report FILE]\n" +
    "Verifies pinned local evidence snapshots and checks exact-asset rights-scope completeness.\n" +
    "Exit code 0: evidence complete, human release review still required. Exit code 2: blocked.",
  );
}

function flagValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    throw new TypeError("Missing value for " + name + ".");
  }
  return args[index + 1];
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " must be a safe project-relative path.");
  }
  return value;
}

async function safeRead(root, relative, label) {
  const safe = safeRelative(relative, label);
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!resolved.startsWith(root + path.sep)) throw new TypeError(label + " resolves outside the selected root.");
  let current = root;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " must not traverse symbolic links.");
    if (current === resolved && !info.isFile()) throw new TypeError(label + " must be a regular file.");
  }
  return { path: safe, bytes: await readFile(resolved) };
}

async function safeOutput(root, relative) {
  const safe = safeRelative(relative, "output report");
  const parts = safe.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await mkdir(current);
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("Output path traverses a symbolic link or non-directory.");
    }
  }
  const target = path.resolve(root, ...parts);
  if (!target.startsWith(root + path.sep)) throw new TypeError("Output report path escapes the selected root.");
  return target;
}

async function main() {
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

  const assetRoot = await realpath(path.resolve(flagValue(args, "--asset-root", process.cwd())));
  const manifestFile = await readFile(path.resolve(manifestPath));
  const manifest = JSON.parse(manifestFile.toString("utf8"));
  const report = await verifyAndValidateBrf38RightsScope(manifest, assetRoot);
  report.manifestSha256 = sha256(manifestFile);
  report.validatorSha256 = sha256(await readFile(new URL("../src/core/building-generation/brf38-rights-scope-gate.mjs", import.meta.url)));
  report.byteVerifierSha256 = sha256(await readFile(new URL("../src/core/building-generation/brf36-source-byte-verifier.mjs", import.meta.url)));
  const digestInput = { ...report, reportSha256: undefined };
  report.reportSha256 = sha256(JSON.stringify(digestInput));

  const reportPath = flagValue(args, "--report", null);
  if (reportPath) {
    const target = await safeOutput(assetRoot, reportPath);
    await writeFile(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify({
    status: report.status,
    byteVerificationStatus: report.byteVerification.status,
    sourceRightsStatus: report.rightsScope.sourceRightsStatus,
    blockers: report.rightsScope.blockers,
    rightsApprovedAssetCount: report.rightsScope.sourceRightsApprovedCount,
    byteVerifiedAssetCount: report.rightsScope.byteVerifiedAssetCount,
    derivedOutputs: report.rightsScope.derivedOutputs,
    releaseFlags: report.rightsScope.releaseFlags,
    manifestSha256: report.manifestSha256,
    reportSha256: report.reportSha256,
  }, null, 2));
  process.exitCode = report.status === "evidence-complete-human-review-required" ? 0 : 2;
}

main().catch((error) => {
  console.error("BRF-38 rights-scope validation blocked: " + (error instanceof Error ? error.message : "unexpected validation error"));
  process.exitCode = 2;
});
