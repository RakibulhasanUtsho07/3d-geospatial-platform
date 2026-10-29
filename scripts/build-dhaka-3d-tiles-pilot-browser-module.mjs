#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_RELATIVE = "src/core/map-engine/dhaka-3d-tiles-pilot-controller.mjs";
const OUTPUT_RELATIVE = "public/experimental/dhaka-3d-tiles-pilot-controller.mjs";
const MAX_SOURCE_BYTES = 128 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Copies the authoritative controller into the static review harness' public
 * module location. The generated copy is intentionally ignored by Git and
 * rebuilt as part of predev/prebuild, so the browser cannot silently test a
 * stale duplicate of the source controller.
 */
export async function buildDhaka3DTilesPilotBrowserModule({
  rootDirectory = projectRoot,
} = {}) {
  const root = path.resolve(rootDirectory);
  const sourcePath = path.join(root, SOURCE_RELATIVE);
  const outputPath = path.join(root, OUTPUT_RELATIVE);
  const outputDirectory = path.dirname(outputPath);

  const sourceInfo = await lstat(sourcePath);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error("The authoritative P3.6 controller must be a regular source file.");
  }
  if (sourceInfo.size < 1 || sourceInfo.size > MAX_SOURCE_BYTES) {
    throw new Error("The P3.6 controller exceeds the browser-module size limit.");
  }

  await mkdir(outputDirectory, { recursive: true });
  try {
    const outputInfo = await lstat(outputPath);
    if (outputInfo.isSymbolicLink() || !outputInfo.isFile()) {
      throw new Error("The generated browser module must not replace a non-regular asset.");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
  }

  const bytes = await readFile(sourcePath);
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) {
    throw new Error("The P3.6 controller source is empty or exceeds the browser-module size limit.");
  }

  const temporaryPath = outputPath + "." + process.pid + ".tmp";
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  try {
    await rename(temporaryPath, outputPath);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return {
    source: SOURCE_RELATIVE,
    output: OUTPUT_RELATIVE,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await buildDhaka3DTilesPilotBrowserModule();
    process.stdout.write(JSON.stringify({ status: "built", ...result }) + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
