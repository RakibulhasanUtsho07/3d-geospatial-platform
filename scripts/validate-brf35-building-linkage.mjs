#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateBrf35BuildingLinkage } from "../src/core/building-generation/brf35-building-linkage.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
  if (!resolved.startsWith(root + path.sep)) throw new TypeError(label + " resolves outside the project root.");
  let current = root;
  for (const part of safe.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError(label + " must not traverse symbolic links.");
    if (current === resolved && !info.isFile()) throw new TypeError(label + " must be a regular file.");
  }
  return { relative: safe, bytes: await readFile(resolved) };
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
    if (info.isSymbolicLink() || !info.isDirectory()) throw new TypeError("Output path traverses a symbolic link or non-directory.");
  }
  const resolved = path.resolve(root, ...parts);
  if (!resolved.startsWith(root + path.sep)) throw new TypeError("Output path escapes the project root.");
  return resolved;
}
async function main() {
  const argv = process.argv.slice(2);
  const rootFlag = argv.find((arg) => arg.startsWith("--root="));
  const positional = argv.filter((arg) => !arg.startsWith("--root="));
  if (process.argv.includes("--help") || positional.length < 2 || positional.length > 3) {
    console.log("Usage: node scripts/validate-brf35-building-linkage.mjs <manifest.json> <brf33-source-report.json> [output-report.json] [--root=project-root]\nA blocked report is an expected result while evidence is incomplete; release flags always remain false.");
    process.exitCode = process.argv.includes("--help") ? 0 : 2;
    return;
  }
  const root = await realpath(path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd()));
  const manifestFile = await safeRead(root, positional[0], "BRF-35 linkage manifest");
  const sourceFile = await safeRead(root, positional[1], "BRF-33 source geometry report");
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const sourceReport = JSON.parse(sourceFile.bytes.toString("utf8"));
  const report = validateBrf35BuildingLinkage(manifest, sourceReport);
  report.manifestSha256 = sha256(manifestFile.bytes);
  report.sourceReportSha256 = sha256(sourceFile.bytes);
  report.validatorSha256 = sha256(await readFile(new URL("../src/core/building-generation/brf35-building-linkage.mjs", import.meta.url)));
  if (positional[2]) {
    const target = await safeOutput(root, positional[2]);
    await writeFile(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  }
  console.log(JSON.stringify({
    status: report.status, blockingCount: report.blockingCount,
    blockers: report.blockers, releaseFlags: report.releaseFlags,
    manifestSha256: report.manifestSha256, sourceReportSha256: report.sourceReportSha256
  }, null, 2));
}
main().catch((error) => { console.error(error?.message ?? String(error)); process.exitCode = 2; });
