import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyBuildingReviewPackageDirectory } from "../src/core/building-generation/building-review-package-directory.mjs";

async function main() {
  const [directoryArg, reportArg] = process.argv.slice(2);
  if (!directoryArg || process.argv.length > 4) {
    throw new Error("Usage: node scripts/verify-building-review-package.mjs <review-package-directory> [integrity-report.json]");
  }
  const snapshot = await verifyBuildingReviewPackageDirectory(path.resolve(directoryArg));
  const report = snapshot.integrity;

  let reportPath = null;
  if (reportArg) {
    reportPath = path.resolve(reportArg);
    const relativeToPackage = path.relative(snapshot.packageDir, reportPath);
    if (relativeToPackage === "" || (!relativeToPackage.startsWith("..") && !path.isAbsolute(relativeToPackage))) {
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
    packageSnapshotSha256: snapshot.snapshotToken,
    publicationEligible: false,
    report: reportPath,
  }, null, 2));
  if (!report.valid) process.exitCode = 2;
}

main().catch((error) => {
  console.error("Could not verify building review package:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
