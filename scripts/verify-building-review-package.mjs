#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { verifyBuildingReviewPackage } from "../src/core/building-generation/building-review-package-integrity.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function listFiles(root, current = root, files = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const details = await lstat(fullPath);
    if (details.isSymbolicLink()) throw new Error("Symbolic links are not allowed inside review packages: " + fullPath);
    if (details.isDirectory()) {
      await listFiles(root, fullPath, files);
      continue;
    }
    if (!details.isFile()) throw new Error("Unsupported filesystem entry inside review package: " + fullPath);
    const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
    if (relativePath === "package-manifest.json") continue;
    const content = await readFile(fullPath);
    const image = /\.(?:png|jpe?g)$/i.test(entry.name) ? readImageDimensions(content) : null;
    files.push({
      relativePath,
      sha256: sha256(content),
      bytes: content.length,
      content,
      isRegularFile: true,
      ...(image ? { width: image.width, height: image.height } : {}),
    });
  }
  return files;
}

async function main() {
  const [directoryArg, reportArg] = process.argv.slice(2);
  if (!directoryArg || process.argv.length > 4) {
    throw new Error("Usage: node scripts/verify-building-review-package.mjs <review-package-directory> [integrity-report.json]");
  }
  const packageDir = path.resolve(directoryArg);
  const manifestPath = path.join(packageDir, "package-manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const packageManifest = JSON.parse(manifestBytes.toString("utf8"));
  const actualFiles = await listFiles(packageDir);
  const report = verifyBuildingReviewPackage({
    packageManifest,
    actualFiles,
    packageManifestSha256: sha256(manifestBytes),
  });

  let reportPath = null;
  if (reportArg) {
    reportPath = path.resolve(reportArg);
    const relativeToPackage = path.relative(packageDir, reportPath);
    if (!relativeToPackage.startsWith("..") && !path.isAbsolute(relativeToPackage)) {
      throw new Error("Integrity report output must be outside the package directory.");
    }
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }

  console.log(JSON.stringify({
    status: report.status,
    valid: report.valid,
    buildingId: report.buildingId,
    expectedFiles: report.counts.expectedFiles,
    actualFiles: report.counts.actualFiles,
    errors: report.counts.errors,
    warnings: report.counts.warnings,
    publicationEligible: false,
    report: reportPath,
  }, null, 2));
  if (!report.valid) process.exitCode = 2;
}

main().catch((error) => {
  console.error("Could not verify building review package:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
