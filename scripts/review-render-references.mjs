#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readImageDimensions } from "../src/core/building-generation/image-quality-preflight.mjs";
import { buildRenderReferenceReview } from "../src/core/building-generation/render-reference-review.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeFileName = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g)$/i.test(value) && !value.includes("..");

async function readVerifiedImage(filePath, label) {
  const info = await readFile(filePath);
  if (!info.length || info.length > 250 * 1024 * 1024) throw new RangeError(label + " must be a non-empty image under 250 MB");
  const dimensions = readImageDimensions(info);
  if (!dimensions) throw new TypeError(label + " must be a readable JPEG/PNG image");
  return { sha256:sha256(info), width:dimensions.width, height:dimensions.height, bytes:info.length };
}

async function main() {
  const [renderDirArg, reviewInputArg, reportArg, ...extra] = process.argv.slice(2);
  if (!renderDirArg || !reviewInputArg || !reportArg || extra.length) {
    throw new Error("Usage: node scripts/review-render-references.mjs <render-directory> <review-input.json> <report.json>");
  }
  const renderDir = path.resolve(renderDirArg);
  const reviewInputPath = path.resolve(reviewInputArg);
  const reportPath = path.resolve(reportArg);
  const manifestPath = path.join(renderDir, "render-review-manifest.json");
  const [manifestBytes, inputBytes] = await Promise.all([readFile(manifestPath), readFile(reviewInputPath)]);
  const renderManifest = JSON.parse(manifestBytes.toString("utf8"));
  const reviewInput = JSON.parse(inputBytes.toString("utf8"));
  const renderFiles = [];
  const inputPaths = [manifestPath, reviewInputPath];
  for (const view of renderManifest.views ?? []) {
    if (!safeFileName(view?.filename) || !view.filename.toLowerCase().endsWith(".png")) {
      throw new TypeError("render manifest contains an unsafe or non-PNG render filename");
    }
    const filePath = path.join(renderDir, view.filename);
    inputPaths.push(filePath);
    try {
      const actual = await readVerifiedImage(filePath, "render " + view.id);
      renderFiles.push({ filename:view.filename, ...actual });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
  }

  const referenceFiles = [];
  const referenceRoot = path.dirname(reviewInputPath);
  for (const reference of reviewInput.referenceImages ?? []) {
    if (typeof reference?.id !== "string" || typeof reference.path !== "string" || !reference.path.trim()) continue;
    const filePath = path.resolve(referenceRoot, reference.path);
    inputPaths.push(filePath);
    const actual = await readVerifiedImage(filePath, "reference " + reference.id);
    referenceFiles.push({
      id:reference.id,
      filename:path.basename(filePath),
      ...actual,
    });
  }
  if (inputPaths.some((filePath) => filePath === reportPath)) throw new Error("report output must not overwrite any input file");
  try {
    await readFile(reportPath);
    throw new Error("Report already exists; choose a new path rather than overwrite review history: " + reportPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const report = buildRenderReferenceReview({
    renderManifest,
    renderManifestSha256:sha256(manifestBytes),
    reviewInput,
    renderFiles,
    referenceFiles,
  });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag:"wx", mode:0o600 });
  console.log(JSON.stringify({
    report:reportPath,
    reviewStatus:report.reviewStatus,
    valid:report.valid,
    renderViews:report.counts.renderViewCount,
    references:report.counts.referenceImageCount,
    comparisons:report.counts.comparisonCount,
    pending:report.counts.pending,
    partial:report.counts.partial,
    mismatch:report.counts.mismatch,
    errors:report.counts.errors,
    warnings:report.counts.warnings,
    publicationEligible:false,
  }, null, 2));
  if (!report.valid) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
