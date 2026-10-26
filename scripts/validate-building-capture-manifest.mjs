#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assessBuildingCaptureManifest, normalizeBuildingCaptureManifest } from "../src/core/building-generation/building-capture-manifest.mjs";

const HASH = /^[a-f0-9]{64}$/i;
function inside(root, relative, label) {
  if (typeof relative !== "string" || !relative.trim() || path.isAbsolute(relative) || relative.includes("\\")) {
    throw new TypeError(label + " must be a project-relative path");
  }
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new TypeError(label + " must resolve inside the project root");
  }
  return target;
}
async function safeInputFile(root, relative, label) {
  const target = inside(root, relative, label);
  let current = root;
  for (const [index, segment] of path.relative(root, target).split(path.sep).entries()) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " must not traverse symlinks");
    const last = index === path.relative(root, target).split(path.sep).length - 1;
    if (!last && !info.isDirectory()) throw new TypeError(label + " parent path is not a directory");
    if (last && !info.isFile()) throw new TypeError(label + " must be a regular file");
  }
  const resolved = await realpath(target);
  if (!resolved.startsWith(root + path.sep)) throw new TypeError(label + " resolves outside the project root");
  return target;
}
async function hashFile(filePath) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const info = await stat(filePath);
  return { sha256: digest.digest("hex"), bytes: info.size };
}
function usage() {
  console.error("Usage: node scripts/validate-building-capture-manifest.mjs <manifest.json> [report.json] [--root=project-root] [--expected-sha256=<manifest-sha256>]");
  process.exitCode = 2;
}
export async function validateBuildingCaptureManifestFile({ manifestPath, rootDir = process.cwd(), expectedSha256 = null }) {
  const root = await realpath(path.resolve(rootDir));
  const manifestTarget = await safeInputFile(root, manifestPath, "capture manifest");
  const manifestBytes = await readFile(manifestTarget);
  let raw;
  try { raw = JSON.parse(manifestBytes.toString("utf8")); }
  catch (error) { throw new TypeError("capture manifest is not valid JSON: " + (error instanceof Error ? error.message : String(error))); }
  const manifest = normalizeBuildingCaptureManifest(raw);
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const fileIntegrity = [];
  for (const source of manifest.sources) {
    if (!source.path) {
      fileIntegrity.push({ sourceId: source.id, status: "warning", detail: "source path is missing", sha256: null, bytes: null });
      continue;
    }
    try {
      const target = await safeInputFile(root, source.path, "source " + source.id);
      const actual = await hashFile(target);
      const hashMatches = HASH.test(source.sha256 ?? "") && source.sha256.toLowerCase() === actual.sha256;
      const bytesMatch = source.bytes === actual.bytes;
      fileIntegrity.push({ sourceId: source.id, path: source.path, status: hashMatches && bytesMatch ? "passed" : "failed",
        sha256: actual.sha256, bytes: actual.bytes, expectedSha256: source.sha256, expectedBytes: source.bytes,
        detail: !hashMatches ? "SHA-256 missing or mismatched" : !bytesMatch ? "byte length mismatch" : "file matches manifest" });
    } catch (error) {
      fileIntegrity.push({ sourceId: source.id, path: source.path, status: "failed", sha256: null, bytes: null,
        detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const assessment = assessBuildingCaptureManifest(manifest, { fileIntegrity });
  let pinCheck;
  if (expectedSha256 === null || expectedSha256 === "") {
    pinCheck = { id: "capture-manifest-hash-pin", status: "warning",
      detail: "No expected manifest SHA-256 was supplied; review this bootstrap digest, then rerun with --expected-sha256." };
  } else if (!HASH.test(expectedSha256)) {
    throw new TypeError("expected-sha256 must be a 64-character SHA-256 hash");
  } else {
    pinCheck = { id: "capture-manifest-hash-pin",
      status: expectedSha256.toLowerCase() === manifestSha256 ? "passed" : "failed",
      detail: expectedSha256.toLowerCase() === manifestSha256 ? "Manifest digest matches the reviewed expected hash." :
        "Manifest digest does not match the expected hash." };
  }
  const checks = [...assessment.checks, pinCheck];
  const status = checks.some((check) => check.status === "failed") ? "failed" :
    checks.some((check) => check.status === "warning") ? "incomplete" : "ready-for-review";
  return { ...assessment, status, readyForModelReview: status === "ready-for-review",
    input: { manifestPath: path.relative(root, manifestTarget).split(path.sep).join("/"), manifestSha256, expectedSha256: expectedSha256 || null,
      expectedSha256Pinned: pinCheck.status === "passed" },
    checks, fileIntegrity, policy: { mapReady: false, publicationEligible: false, automaticApproval: false } };
}
async function main() {
  const args = process.argv.slice(2);
  const rootFlag = args.find((arg) => arg.startsWith("--root="));
  const hashFlag = args.find((arg) => arg.startsWith("--expected-sha256="));
  const positional = args.filter((arg) => !arg.startsWith("--root=") && !arg.startsWith("--expected-sha256="));
  const [manifestPath, reportPath] = positional;
  if (!manifestPath || positional.length > 2) return usage();
  try {
    const root = path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd());
    const report = await validateBuildingCaptureManifestFile({
      manifestPath, rootDir: root, expectedSha256: hashFlag ? hashFlag.slice("--expected-sha256=".length) : null,
    });
    if (reportPath) {
      const output = inside(await realpath(root), reportPath, "report output");
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "w" });
    }
    console.log(JSON.stringify({ report: reportPath ?? null, manifestSha256: report.input.manifestSha256,
      status: report.status, sources: report.counts.sources, captures: report.counts.captures,
      references: report.counts.references, checksPassed: report.counts.passed,
      checksWarning: report.counts.warnings, checksFailed: report.counts.failed,
      publicationEligible: report.policy.publicationEligible }, null, 2));
    if (report.status === "failed") process.exitCode = 1;
    else if (report.status === "incomplete") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
