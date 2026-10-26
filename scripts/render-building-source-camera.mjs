#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSourceCameraRender, finalizeSourceCameraRenderManifest } from "../src/core/building-generation/source-camera-render.mjs";
import { parseRenderOptions } from "../src/core/building-generation/render-review-options.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function imageDimensions(bytes, label) {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(pngSignature) &&
      bytes.toString("ascii", 12, 16) === "IHDR") {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height, format: "png" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const frameMarkers = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset++; continue; }
      if (offset + 3 >= bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset + 1);
      if (segmentLength < 2 || offset + 1 + segmentLength > bytes.length) break;
      if (frameMarkers.has(marker) && segmentLength >= 7) {
        const height = bytes.readUInt16BE(offset + 4);
        const width = bytes.readUInt16BE(offset + 6);
        if (width > 0 && height > 0) return { width, height, format: "jpeg" };
      }
      offset += 1 + segmentLength;
    }
  }
  throw new TypeError("source image must be a readable PNG or JPEG: " + label);
}

async function readPng(pathname) {
  const bytes = await readFile(pathname);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new TypeError("rendered artifact is not a valid PNG: " + pathname);
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw new TypeError("rendered PNG has invalid dimensions: " + pathname);
  return { bytes, width, height, sha256: sha256(bytes) };
}

async function main() {
  const [modelArg, evidenceArg, imageArg, outputArg, ...flags] = process.argv.slice(2);
  if (!modelArg || !evidenceArg || !imageArg || !outputArg) {
    throw new Error("Usage: node scripts/render-building-source-camera.mjs <model.glb> <camera-evidence.json> <source.png|jpg> <new-output-directory> --coordinate-frame=<exact-model-frame> [--blender=blender] [--timeout-ms=600000]");
  }
  let coordinateFrame = "";
  const renderFlags = [];
  for (const flag of flags) {
    if (flag.startsWith("--coordinate-frame=")) coordinateFrame = flag.slice("--coordinate-frame=".length).trim();
    else renderFlags.push(flag);
  }
  if (!coordinateFrame) throw new Error("--coordinate-frame is required; a coordinate frame is never inferred");
  const { blender, timeoutMs } = parseRenderOptions(renderFlags);
  const modelPath = path.resolve(modelArg);
  const evidencePath = path.resolve(evidenceArg);
  const sourceImagePath = path.resolve(imageArg);
  const outputDir = path.resolve(outputArg);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

  for (const [pathname, description] of [[modelPath, "model"], [evidencePath, "camera evidence"], [sourceImagePath, "source image"]]) {
    const item = await stat(pathname);
    if (!item.isFile()) throw new TypeError(description + " input must be a file");
  }
  if (path.extname(modelPath).toLowerCase() !== ".glb") throw new TypeError("model input must be a .glb file");
  try {
    await stat(outputDir);
    throw new Error("Output directory already exists; choose a new directory to preserve prior review evidence: " + outputDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const modelBytes = await readFile(modelPath);
  const sourceBytes = await readFile(sourceImagePath);
  const sourceDimensions = imageDimensions(sourceBytes, sourceImagePath);
  const cameraEvidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const sourceMetadata = {
    path: sourceImagePath,
    sha256: sha256(sourceBytes),
    imageSize: { width: sourceDimensions.width, height: sourceDimensions.height },
    crop: cameraEvidence.sourceImage?.crop ?? null,\n    rightsAttestation: cameraEvidence.sourceImage?.rightsAttestation ?? null,
  };
  const prepared = prepareSourceCameraRender({
    cameraEvidence,
    sourceImage: sourceMetadata,
    modelCoordinateFrame: coordinateFrame,
    modelSha256: sha256(modelBytes),
  });
  if (!prepared.valid) {
    console.error(JSON.stringify({ status: prepared.status, valid: false, publicationEligible: false, errors: prepared.errors }, null, 2));
    process.exitCode = 2;
    return;
  }

  await mkdir(outputDir, { recursive: false });
  const planPath = path.join(os.tmpdir(), "source-camera-plan-" + process.pid + "-" + Date.now() + ".json");
  const pythonScriptPath = path.join(scriptDirectory, "blender", "render-building-source-camera.py");
  try {
    await writeFile(planPath, JSON.stringify(prepared.renderPlan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const result = spawnSync(blender, [
      "--background", "--factory-startup", "--python-exit-code", "17",
      "--python", pythonScriptPath, "--",
      "--model", modelPath, "--plan", planPath, "--output-dir", outputDir,
    ], { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    if (result.error?.code === "ETIMEDOUT") {
      throw new Error("Blender exceeded the " + timeoutMs + " ms timeout. Partial output is unaccepted and has no final manifest.");
    }
    if (result.error?.code === "ENOENT") {
      throw new Error("Blender executable was not found. Install Blender or pass --blender=<path>. No render was accepted.");
    }
    if (result.error) throw new Error("Could not start Blender: " + result.error.message);
    if (result.status !== 0) {
      const output = ((result.stdout || "") + "\n" + (result.stderr || "")).trim();
      throw new Error("Blender failed with exit code " + result.status + ". No render was accepted.\n" + output.slice(-5000));
    }

    const candidatePath = path.join(outputDir, "candidate.png");
    const overlayPath = path.join(outputDir, "overlay.png");
    const [candidate, overlay] = await Promise.all([readPng(candidatePath), readPng(overlayPath)]);
    const fileMetadata = {
      candidate: { width: candidate.width, height: candidate.height, bytes: candidate.bytes.length, sha256: candidate.sha256 },
      overlay: { width: overlay.width, height: overlay.height, bytes: overlay.bytes.length, sha256: overlay.sha256 },
    };
    const report = finalizeSourceCameraRenderManifest({ renderPlan: prepared.renderPlan, renderFiles: fileMetadata });
    const reportPath = path.join(outputDir, "source-camera-render-manifest.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ report: reportPath, status: report.status, valid: report.valid,
      width: sourceDimensions.width, height: sourceDimensions.height, cameraId: prepared.renderPlan.cameraId,
      candidateSha256: candidate.sha256, overlaySha256: overlay.sha256, publicationEligible: false }, null, 2));
    if (!report.valid) process.exitCode = 2;
  } finally {
    await rm(planPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
