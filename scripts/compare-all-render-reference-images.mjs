#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRenderImageSimilarity } from "../src/core/building-generation/render-image-similarity-diagnostics.mjs";
import { buildRenderReferenceBatchPlan } from "../src/core/building-generation/render-reference-batch-plan.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function usage() {
  console.error(
    "Usage: node scripts/compare-all-render-reference-images.mjs <render-directory> <review-input.json> <report.json> [new-diagnostics-directory-name]",
  );
  console.error("Computes diagnostics only for explicitly listed reviewInput.comparisons; it never guesses facade or camera matches.");
  process.exitCode = 2;
}

async function readRegularFile(filePath, label, maxBytes = 10 * 1024 * 1024) {
  const absolutePath = path.resolve(filePath);
  const entry = await lstat(absolutePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError(label + " must be a regular file and must not be a symlink");
  }
  const fileStats = await stat(absolutePath);
  if (fileStats.size < 1 || fileStats.size > maxBytes) {
    throw new RangeError(label + " must be non-empty and no larger than " + maxBytes + " bytes");
  }
  return { path: absolutePath, bytes: await readFile(absolutePath) };
}

async function assertImageReady(imagePath, label) {
  const entry = await lstat(imagePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError(label + " must be a regular image file and must not be a symlink");
  }
  const fileStats = await stat(imagePath);
  if (fileStats.size < 1 || fileStats.size > 250 * 1024 * 1024) {
    throw new RangeError(label + " must be non-empty and no larger than 250 MB");
  }
}

async function ensureDoesNotExist(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(label + " already exists; choose a new output path: " + filePath);
}

function runReviewCli(args) {
  const reviewCliPath = fileURLToPath(new URL("./review-render-references.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [reviewCliPath, ...args], {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) resolve({ code: 1, signal });
      else resolve({ code: code ?? 1, signal: null });
    });
  });
}

async function main() {
  const [renderDirectoryArg, reviewInputArg, reportArg, diagnosticsDirectoryName = "generated-render-diagnostics", ...extra] =
    process.argv.slice(2);
  if (!renderDirectoryArg || !reviewInputArg || !reportArg || extra.length || process.argv.includes("--help")) {
    usage();
    return;
  }

  const renderDirectory = path.resolve(renderDirectoryArg);
  const reviewInputPath = path.resolve(reviewInputArg);
  const reportPath = path.resolve(reportArg);
  const manifestPath = path.join(renderDirectory, "render-review-manifest.json");
  const [manifestFile, inputFile] = await Promise.all([
    readRegularFile(manifestPath, "render-review-manifest.json"),
    readRegularFile(reviewInputPath, "review input JSON"),
  ]);
  const renderManifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  const reviewInput = JSON.parse(inputFile.bytes.toString("utf8"));
  const plan = buildRenderReferenceBatchPlan({
    renderManifest,
    reviewInput,
    renderDirectory,
    reviewInputPath,
    diagnosticsDirectoryName,
  });

  const inputPaths = new Set([
    path.resolve(manifestPath),
    path.resolve(reviewInputPath),
    ...plan.pairs.flatMap((pair) => [path.resolve(pair.renderPath), path.resolve(pair.referencePath)]),
  ]);
  if (inputPaths.has(reportPath) || inputPaths.has(path.resolve(plan.reviewInputWithDiagnosticsPath)) ||
    reportPath === path.resolve(plan.diagnosticsDirectoryPath) ||
    path.relative(plan.diagnosticsDirectoryPath, reportPath) === "" ||
    !path.relative(plan.diagnosticsDirectoryPath, reportPath).startsWith("..") &&
      !path.isAbsolute(path.relative(plan.diagnosticsDirectoryPath, reportPath))) {
    throw new Error("report output must not overwrite an input, generated review input, or generated diagnostic");
  }
  await ensureDoesNotExist(reportPath, "Report output");
  await ensureDoesNotExist(plan.diagnosticsDirectoryPath, "Diagnostics directory");
  await ensureDoesNotExist(plan.reviewInputWithDiagnosticsPath, "Generated review input");

  for (const pair of plan.pairs) {
    await assertImageReady(pair.renderPath, "render " + pair.viewId);
    await assertImageReady(pair.referencePath, "reference " + pair.referenceImageId);
  }

  let reviewInputWritten = false;
  let diagnosticsDirectoryCreated = false;
  try {
    await mkdir(plan.diagnosticsDirectoryPath, { recursive: false });
    diagnosticsDirectoryCreated = true;
    const comparisons = reviewInput.comparisons.map((comparison) => ({ ...comparison }));
    for (const pair of plan.pairs) {
      const report = await analyzeRenderImageSimilarity({
        referenceImagePath: pair.referencePath,
        candidateImagePath: pair.renderPath,
      });
      const serialized = JSON.stringify(report, null, 2) + "\n";
      await writeFile(path.join(plan.diagnosticsDirectoryPath, pair.diagnosticFilename), serialized, {
        flag: "wx",
        mode: 0o600,
      });
      comparisons[pair.index] = {
        ...comparisons[pair.index],
        similarityDiagnosticsPath: pair.diagnosticRelativePath,
      };
    }

    const enrichedReviewInput = { ...reviewInput, comparisons };
    await writeFile(plan.reviewInputWithDiagnosticsPath, JSON.stringify(enrichedReviewInput, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    reviewInputWritten = true;

    console.log(JSON.stringify({
      stage: "similarity-diagnostics-generated",
      pairCount: plan.pairs.length,
      diagnosticsDirectory: plan.diagnosticsDirectoryPath,
      generatedReviewInput: plan.reviewInputWithDiagnosticsPath,
      reportOutput: reportPath,
    }, null, 2));

    // Delegate hash verification, evidence attachment, manual-outcome preservation,
    // and report creation to the existing review CLI.
    const result = await runReviewCli([
      renderDirectory,
      plan.reviewInputWithDiagnosticsPath,
      reportPath,
    ]);
    process.exitCode = result.code;
  } catch (error) {
    if (!reviewInputWritten && diagnosticsDirectoryCreated) {
      await rm(plan.diagnosticsDirectoryPath, { recursive: true, force: true });
    }
    if (!reviewInputWritten) {
      // The enriched input is written last, so a partial input should not remain.
      try { await rm(plan.reviewInputWithDiagnosticsPath, { force: true }); } catch { /* no output to clean */ }
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
