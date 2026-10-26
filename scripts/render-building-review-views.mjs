#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeRenderReviewManifest } from "../src/core/building-generation/render-review-manifest.mjs";
import { validateRenderReviewProfile } from "../src/core/building-generation/render-review-profile.mjs";
import { parseRenderOptions } from "../src/core/building-generation/render-review-options.mjs";
import {
  assessSourceCameraForRender,
  finalizeSourceCameraRenderManifest,
} from "../src/core/building-generation/source-camera-render.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");


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

function rasterDimensions(bytes, label) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (bytes.length >= 24 && bytes.subarray(0,8).equals(signature) && bytes.toString("ascii",12,16) === "IHDR") {
    return pngDimensions(bytes,label);
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrame = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (startOfFrame.has(marker) && length >= 7) {
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) return { width, height };
      }
      offset += length;
    }
  }
  throw new TypeError("source image must be a readable PNG or JPEG: " + label);
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

async function main() {
  const [modelArg, outputArg, ...allFlags] = process.argv.slice(2);
  if (!modelArg || !outputArg) {
    throw new Error("Usage: node scripts/render-building-review-views.mjs <model.glb> <new-output-directory> [--resolution=1024] [--blender=blender] [--timeout-ms=600000] [--review-profile=profile.json] [--source-camera=camera.json --source-image=photo.jpg --calibration-evidence=calibration.json --frame-alignment-evidence=alignment.json]");
  }
  const singleFlag = (name) => {
    const matches = allFlags.filter((flag) => flag.startsWith("--" + name + "="));
    if (matches.length > 1) throw new Error("Specify --" + name + " only once");
    const value = matches.length ? matches[0].slice(name.length + 3) : null;
    if (value !== null && !value.trim()) throw new Error("--" + name + " cannot be empty");
    return value;
  };
  const reviewProfilePathArg = singleFlag("review-profile");
  const sourceCameraPathArg = singleFlag("source-camera");
  const sourceImagePathArg = singleFlag("source-image");
  const calibrationEvidencePathArg = singleFlag("calibration-evidence");
  const frameAlignmentEvidencePathArg = singleFlag("frame-alignment-evidence");
  const cameraInputs = [sourceCameraPathArg, sourceImagePathArg, calibrationEvidencePathArg, frameAlignmentEvidencePathArg];
  if (cameraInputs.some(Boolean) && !cameraInputs.every(Boolean)) {
    throw new Error("--source-camera, --source-image, --calibration-evidence and --frame-alignment-evidence must be supplied together");
  }
  const auxiliaryFlags = ["--review-profile=", "--source-camera=", "--source-image=", "--calibration-evidence=", "--frame-alignment-evidence="];
  const flags = allFlags.filter((flag) => !auxiliaryFlags.some((prefix) => flag.startsWith(prefix)));
  const { resolution, blender, timeoutMs } = parseRenderOptions(flags);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const modelPath = path.resolve(modelArg);
  const outputDir = path.resolve(outputArg);
  let reviewProfilePath = null;
  let reviewProfileSha256 = null;
  if (reviewProfilePathArg) {
    reviewProfilePath = path.resolve(reviewProfilePathArg);
    const profileBytes = await readFile(reviewProfilePath);
    let parsedProfile;
    try {
      parsedProfile = JSON.parse(profileBytes.toString("utf8"));
    } catch (error) {
      throw new TypeError("review-profile JSON is invalid: " + (error instanceof Error ? error.message : String(error)));
    }
    validateRenderReviewProfile(parsedProfile);
    reviewProfileSha256 = sha256(profileBytes);
  }
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
  let sourceCameraAssessment = null;
  let sourceCameraPath = null;
  if (cameraInputs.every(Boolean)) {
    sourceCameraPath = path.resolve(sourceCameraPathArg);
    const sourceImagePath = path.resolve(sourceImagePathArg);
    const calibrationEvidencePath = path.resolve(calibrationEvidencePathArg);
    const frameAlignmentEvidencePath = path.resolve(frameAlignmentEvidencePathArg);
    const [cameraBytes, sourceImageBytes, calibrationEvidenceBytes, frameAlignmentEvidenceBytes] = await Promise.all([
      readFile(sourceCameraPath),
      readFile(sourceImagePath),
      readFile(calibrationEvidencePath),
      readFile(frameAlignmentEvidencePath),
    ]);
    let camera;
    try {
      camera = JSON.parse(cameraBytes.toString("utf8"));
    } catch (error) {
      throw new TypeError("source-camera JSON is invalid: " + (error instanceof Error ? error.message : String(error)));
    }
    sourceCameraAssessment = assessSourceCameraForRender({
      camera,
      sourceImageSha256: sha256(sourceImageBytes),
      sourceImageSize: rasterDimensions(sourceImageBytes, sourceImagePath),
      cameraManifestSha256: sha256(cameraBytes),
      calibrationEvidenceSha256: sha256(calibrationEvidenceBytes),
      frameAlignmentEvidenceSha256: sha256(frameAlignmentEvidenceBytes),
      modelSha256: sha256(modelBytes),
    });
    if (!sourceCameraAssessment.sameCameraComparable) {
      console.error("Source-camera pair is not comparable: " + sourceCameraAssessment.errors.join(", "));
    }
  }
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
    if (reviewProfilePath && reviewProfileSha256) {
      args.push("--review-profile-json", reviewProfilePath, "--review-profile-sha256", reviewProfileSha256);
    }
    if (sourceCameraAssessment?.sameCameraComparable && sourceCameraPath) {
      args.push("--source-camera-json", sourceCameraPath, "--source-camera-module-dir", path.join(scriptDirectory, "blender"));
    }
    const result = spawnSync(blender, args, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) {
      if (result.error.code === "ETIMEDOUT") {
        throw new Error("Blender render exceeded the " + timeoutMs + " ms timeout. Partial output is retained in " + outputDir + "; no render set is accepted.");
      }
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
      textureQaSummary,
    });
    const reportPath = path.join(outputDir, "render-review-manifest.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    let sourceCameraReport = null;
    if (sourceCameraAssessment) {
      let renderFile = null;
      if (sourceCameraAssessment.sameCameraComparable) {
        const sourceCameraView = raw.sourceCameraView;
        if (!sourceCameraView || sourceCameraView.renderComplete !== true) {
          const renderFailure = ["blender-source-camera-render-missing-or-incomplete"];
          if (sourceCameraView && typeof sourceCameraView.errorCode === "string") {
            renderFailure.push(sourceCameraView.errorCode);
          }
          if (sourceCameraView && typeof sourceCameraView.errorMessage === "string" && sourceCameraView.errorMessage.trim()) {
            renderFailure.push("blender-source-camera-error:" + sourceCameraView.errorMessage.trim().slice(0, 1000));
          }
          sourceCameraAssessment = {
            ...sourceCameraAssessment,
            status: "not-comparable",
            sameCameraComparable: false,
            errors: [...sourceCameraAssessment.errors, ...renderFailure],
          };
        } else {
          const sourceCameraPath = path.join(outputDir, "source-camera.png");
          const bytes = await readFile(sourceCameraPath);
          const dimensions = pngDimensions(bytes, "source-camera.png");
          renderFile = {
            filename: "source-camera.png", ...dimensions, bytes: bytes.length, sha256: sha256(bytes),
            pixelStatistics: sourceCameraView.pixelStatistics,
          };
        }
      }
      sourceCameraReport = finalizeSourceCameraRenderManifest({
        assessment: sourceCameraAssessment,
        renderFile,
      });
      await writeFile(
        path.join(outputDir, "source-camera-render-manifest.json"),
        JSON.stringify(sourceCameraReport, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    }
    await rm(rawPath, { force: true });
    console.log(JSON.stringify({
      report: reportPath,
      status: report.status,
      valid: report.valid,
      renderedViews: report.counts.generatedViews,
      resolution: resolution + "x" + resolution,
      errors: report.errors.length,
      warnings: report.warnings.length,
      sourceCamera: sourceCameraReport ? {
        report: path.join(outputDir, "source-camera-render-manifest.json"),
        status: sourceCameraReport.status,
        sameCameraComparable: sourceCameraReport.sameCameraComparable,
        errors: sourceCameraReport.errors,
      } : null,
      publicationEligible: false,
    }, null, 2));
    if (!report.valid || sourceCameraReport?.sameCameraComparable === false) process.exitCode = 2;
  } finally {
    await rm(pythonScript, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
