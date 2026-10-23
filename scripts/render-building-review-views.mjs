#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { finalizeRenderReviewManifest } from "../src/core/building-generation/render-review-manifest.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function parseOptions(args) {
  let resolution = 1024;
  let blender = process.env.BLENDER_BIN || "blender";
  for (const arg of args) {
    if (arg.startsWith("--resolution=")) resolution = Number(arg.slice("--resolution=".length));
    else if (arg.startsWith("--blender=")) blender = arg.slice("--blender=".length);
    else throw new Error("Unknown option: " + arg);
  }
  if (!Number.isSafeInteger(resolution) || resolution < 256 || resolution > 2048 ||
    (resolution & (resolution - 1)) !== 0) {
    throw new RangeError("resolution must be a power-of-two integer between 256 and 2048");
  }
  if (!blender.trim()) throw new TypeError("Blender executable cannot be empty");
  return { resolution, blender };
}

function pngDimensions(bytes, label) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (bytes.length < 24 || !bytes.subarray(0,8).equals(signature)) {
    throw new TypeError("rendered file is not a PNG: " + label);
  }
  if (bytes.toString("ascii",12,16) !== "IHDR") throw new TypeError("PNG has no leading IHDR: " + label);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw new TypeError("PNG has invalid dimensions: " + label);
  return { width, height };
}

function summarizeTextureQa(report) {
  return {
    status: report.status,
    valid: report.valid,
    counts: report.counts,
    errors: report.errors,
    warnings: report.warnings,
  };
}

function summarizeGeometryQa(report) {
  return {
    schemaVersion: report.schemaVersion,
    engine: report.engine,
    status: report.status,
    valid: report.valid,
    counts: report.counts,
    bounds: report.bounds,
    errors: [],
    warnings: report.warnings,
    limitations: report.limitations,
  };
}

async function main() {
  const [modelArg, outputArg, ...flags] = process.argv.slice(2);
  if (!modelArg || !outputArg) {
    throw new Error("Usage: node scripts/render-building-review-views.mjs <model.glb> <new-output-directory> [--resolution=1024] [--blender=blender]");
  }
  const { resolution, blender } = parseOptions(flags);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const modelPath = path.resolve(modelArg);
  const outputDir = path.resolve(outputArg);
  const modelStat = await stat(modelPath);
  if (!modelStat.isFile() || path.extname(modelPath).toLowerCase() !== ".glb") {
    throw new TypeError("model input must be a .glb file");
  }
  try {
    await stat(outputDir);
    throw new Error("Output directory already exists; choose a new directory to prevent overwriting review renders: " + outputDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const modelBytes = await readFile(modelPath);
  // Fail closed before rendering if the input GLB has malformed structure or geometry.
  const geometryQaSummary = summarizeGeometryQa(analyzeGlbQuality(modelBytes));
  await mkdir(outputDir, { recursive: false });
  let textureQaSummary = null;
  try {
    textureQaSummary = summarizeTextureQa(reviewGlbTextureBindings(modelBytes));
  } catch (error) {
    textureQaSummary = { status: "unavailable", valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  const pythonScript = path.join(os.tmpdir(), "building-review-render-" + process.pid + "-" + Date.now() + ".py");
  const pythonPath = path.resolve(scriptDirectory, "blender", "render-building-review.py");
  try {
    const python = await readFile(pythonPath, "utf8");
    await writeFile(pythonScript, python, { flag: "wx", mode: 0o600 });
    const args = [
      "--background", "--factory-startup", "--python-exit-code", "17",
      "--python", pythonScript, "--",
      "--model", modelPath, "--output-dir", outputDir, "--resolution", String(resolution),
    ];
    const result = spawnSync(blender, args, { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) {
      if (result.error.code === "ENOENT") {
        throw new Error("Blender executable was not found. Install Blender and ensure 'blender' is on PATH, or pass --blender=<path>. No render was produced.");
      }
      throw new Error("Could not start Blender: " + result.error.message);
    }
    if (result.status !== 0) {
      const output = ((result.stdout || "") + "\n" + (result.stderr || "")).trim();
      throw new Error("Blender failed with exit code " + result.status + ". Partial output is retained in " + outputDir + "\n" + output.slice(-5000));
    }
    const rawPath = path.join(outputDir, ".blender-render-manifest.raw.json");
    const raw = JSON.parse(await readFile(rawPath, "utf8"));
    const fileMetadata = {};
    for (const view of raw.views ?? []) {
      if (typeof view.filename !== "string" || path.basename(view.filename) !== view.filename ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(view.filename) || view.filename.includes("..")) {
        throw new Error("Blender manifest contains an unsafe output filename");
      }
      const imagePath = path.join(outputDir, view.filename);
      const bytes = await readFile(imagePath);
      const dimensions = pngDimensions(bytes, view.filename);
      fileMetadata[view.filename] = { ...dimensions, bytes: bytes.length, sha256: sha256(bytes) };
    }
    const report = finalizeRenderReviewManifest({
      rawManifest: raw,
      modelSha256: sha256(modelBytes),
      files: fileMetadata,
      resolution,
      geometryQaSummary,
      textureQaSummary,
    });
    const reportPath = path.join(outputDir, "render-review-manifest.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rm(rawPath, { force: true });
    console.log(JSON.stringify({
      report: reportPath,
      status: report.status,
      valid: report.valid,
      renderedViews: report.counts.generatedViews,
      resolution: resolution + "x" + resolution,
      geometryQaStatus: report.geometryQaSummary.status,
      geometryQaWarnings: report.geometryQaSummary.warnings.length,
      renderConfigSha256: report.renderConfigSha256,
      errors: report.errors.length,
      warnings: report.warnings.length,
      publicationEligible: false,
    }, null, 2));
    if (!report.valid) process.exitCode = 2;
  } finally {
    await rm(pythonScript, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
