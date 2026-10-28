#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateBrf45ExactAssetRightsAdmission } from "../src/core/building-generation/brf45-exact-asset-rights-admission.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

function usage() {
  console.log(
    "Usage: node scripts/validate-brf45-exact-asset-rights-admission.mjs <rights-admission.json> --source-manifest <brf-14-multiview-source.json> --evidence-root <directory> [--report <relative-output.json>]\n" +
    "Validates exact per-image rights evidence for private local reconstruction and validation. It does not interpret law or approve model publication.\n" +
    "Exit code 0: exact asset rights evidence is complete and still requires human review. Exit code 2: blocked/incomplete.",
  );
}
function option(args, name, required = true) {
  const index = args.indexOf(name);
  if (index < 0) {
    if (required) throw new TypeError("Missing required option " + name + ".");
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError("Missing value for " + name + ".");
  return value;
}
function safeReportPath(value) {
  if (!value) return null;
  if (path.isAbsolute(value) || value.includes("\\") ||
      value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new TypeError("--report must be a safe relative path.");
  }
  const cwd = path.resolve(process.cwd());
  const target = path.resolve(cwd, ...value.split("/"));
  if (!target.startsWith(cwd + path.sep)) throw new TypeError("--report escapes the working directory.");
  return target;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { usage(); return; }
  const manifestPath = args.find(arg => !arg.startsWith("--"));
  if (!manifestPath) { usage(); process.exitCode = 2; return; }
  const sourceManifestPath = option(args, "--source-manifest");
  const evidenceRootArg = option(args, "--evidence-root");
  const target = safeReportPath(option(args, "--report", false));
  const manifestBytes = await readFile(path.resolve(manifestPath));
  const sourceBytes = await readFile(path.resolve(sourceManifestPath));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceManifest = JSON.parse(sourceBytes.toString("utf8"));
  const rootInfo = await lstat(path.resolve(evidenceRootArg));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new TypeError("--evidence-root must be a real directory, not a symlink.");
  }
  const evidenceRoot = await realpath(path.resolve(evidenceRootArg));
  const report = await validateBrf45ExactAssetRightsAdmission(manifest, {
    sourceManifest, evidenceRoot, sourceManifestSha256: sha(sourceBytes),
  });
  report.manifestSha256 = sha(manifestBytes);
  report.validatorSha256 = sha(await readFile(new URL("../src/core/building-generation/brf45-exact-asset-rights-admission.mjs", import.meta.url)));
  report.reportSha256 = sha(Buffer.from(JSON.stringify({ ...report, reportSha256: undefined })));
  if (target) {
    const cwd = await realpath(process.cwd());
    await mkdir(path.dirname(target), { recursive: true });
    const parent = await realpath(path.dirname(target));
    const relativeParent = path.relative(cwd, parent);
    if (relativeParent.startsWith(".." + path.sep) || relativeParent === ".." || path.isAbsolute(relativeParent)) {
      throw new TypeError("--report parent resolves outside the working directory.");
    }
    await writeFile(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({
    status: report.status,
    sourceViewCount: report.sourceViewCount,
    rightsApprovedAssetCount: report.rightsApprovedAssetCount,
    blockerCount: report.blockers.length,
    blockers: report.blockers,
    releaseFlags: report.releaseFlags,
    manifestSha256: report.manifestSha256,
    reportSha256: report.reportSha256,
  }, null, 2));
  if (report.status !== "rights-admission-complete-human-review-required") process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error("BRF-45 rights admission blocked: " + (error instanceof Error ? error.message : "unexpected error"));
    process.exitCode = 2;
  });
}
