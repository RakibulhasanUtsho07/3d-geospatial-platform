#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildDhaka3DTilesPackage } from "./build-dhaka-3d-tiles-package.mjs";
import { verifyTilesetPackage } from "../src/core/geospatial/tileset-package-integrity.mjs";
import { reviewDhaka3DTilesPackageAlignment } from "./review-dhaka-3d-tiles-package-alignment.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = path.join(ROOT, "data/overture/dhaka-buildings-3d-pilot.geojson");
const DEFAULT_COUNTS = Object.freeze([32, 64, 128]);
const MAX_FEATURES = 128;
const RELEASE_FLAGS = Object.freeze({
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
  automaticApproval: false,
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function within(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function milliseconds(value) {
  return Number(value.toFixed(3));
}

function parsePositiveNumber(raw, label, maximum) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new TypeError(label + " must be finite and in the range (0, " + maximum + "].");
  }
  return value;
}

export function parseFeatureCounts(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new TypeError("feature counts must be a comma-separated list of integers from 1 to " + MAX_FEATURES + ".");
  }
  const parts = raw.split(",");
  const counts = parts.map((part) => {
    const trimmed = part.trim();
    if (!/^\d+$/.test(trimmed)) throw new TypeError("Each feature count must be an integer.");
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FEATURES) {
      throw new TypeError("Each feature count must be an integer from 1 to " + MAX_FEATURES + ".");
    }
    return value;
  });
  if (new Set(counts).size !== counts.length) throw new TypeError("Feature counts must not contain duplicates.");
  if (counts.some((value, index) => index > 0 && value <= counts[index - 1])) {
    throw new TypeError("Feature counts must be strictly increasing to keep profile order unambiguous.");
  }
  return counts;
}

function validateFeatureCounts(values) {
  if (!Array.isArray(values) || values.length === 0 || !values.every(Number.isSafeInteger)) {
    throw new TypeError("featureCounts must be a non-empty array of integers.");
  }
  return parseFeatureCounts(values.join(","));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

async function measurePackageFiles(directory) {
  let totalBytes = 0;
  let fileCount = 0;
  async function visit(current) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Scale-profile package must not contain symbolic links.");
    if (info.isFile()) {
      totalBytes += info.size;
      fileCount += 1;
      return;
    }
    if (!info.isDirectory()) throw new Error("Scale-profile package contains a non-regular filesystem entry.");
    for (const entry of await readdir(current)) await visit(path.join(current, entry));
  }
  await visit(directory);
  return { totalBytes, fileCount };
}

async function assertSafeReportPath(outputPath) {
  const resolved = path.resolve(outputPath);
  const underProject = within(ROOT, resolved);
  const underTemp = within(os.tmpdir(), resolved);
  if (!underProject && !underTemp) {
    throw new TypeError("Report output must remain inside the repository or operating-system temporary directory.");
  }
  const base = underProject ? ROOT : os.tmpdir();
  const parent = path.dirname(resolved);
  const relativeParent = path.relative(base, parent);
  let current = base;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TypeError("Report output must not traverse symlinked or non-directory parents.");
    }
  }
  try {
    const targetInfo = await lstat(resolved);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw new TypeError("Report target must be a regular file and must not be a symbolic link.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return resolved;
}

async function writeReport(outputPath, report) {
  const resolved = await assertSafeReportPath(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await assertSafeReportPath(resolved);
  const temporaryPath = resolved + ".tmp-" + process.pid;
  try {
    await writeFile(temporaryPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, resolved);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function runDhaka3DTilesScaleProfile({
  sourcePath = DEFAULT_SOURCE,
  featureCounts = DEFAULT_COUNTS,
  syntheticHeightMeters = 8,
  toleranceMeters = 0.5,
  reportPath = null,
} = {}) {
  const counts = validateFeatureCounts(featureCounts);
  if (!Number.isFinite(syntheticHeightMeters) || syntheticHeightMeters <= 0 || syntheticHeightMeters > 250) {
    throw new TypeError("syntheticHeightMeters must be finite and in the range (0, 250].");
  }
  if (!Number.isFinite(toleranceMeters) || toleranceMeters <= 0 || toleranceMeters > 5) {
    throw new TypeError("toleranceMeters must be finite and in the range (0, 5].");
  }
  const source = path.resolve(sourcePath);
  if (!within(ROOT, source) && !within(os.tmpdir(), source)) {
    throw new TypeError("Source GeoJSON must be inside the repository or OS temporary directory.");
  }
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.size > 256 * 1024 * 1024) {
    throw new TypeError("Source GeoJSON must be a regular non-symlink file no larger than 256 MiB.");
  }
  const sourceBytes = await readFile(source);
  const parsedSource = JSON.parse(sourceBytes.toString("utf8"));
  if (!isRecord(parsedSource) || parsedSource.type !== "FeatureCollection" || !Array.isArray(parsedSource.features)) {
    throw new TypeError("Source must be a GeoJSON FeatureCollection with a features array.");
  }
  if (reportPath !== null && typeof reportPath !== "string") throw new TypeError("reportPath must be a string or null.");
  if (reportPath) await assertSafeReportPath(reportPath);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "p3-6-dhaka-scale-profile-"));
  const samples = [];
  try {
    for (const maxFeatures of counts) {
      const packagePath = path.join(temporaryRoot, "package-" + maxFeatures);
      const sample = {
        requestedMaxFeatures: maxFeatures,
        status: "failed",
        wallTimeMs: { buildAndEmbeddedIntegrity: null, standaloneIntegrity: null, alignment: null },
        residentSetBytes: { beforeBuild: null, afterBuild: null, afterIntegrity: null, afterAlignment: null },
        packageBytes: null,
        packageFileCount: null,
        glbBytes: null,
        sourceSha256: sha256(sourceBytes),
        errors: [],
      };
      try {
        sample.residentSetBytes.beforeBuild = process.memoryUsage().rss;
        const buildStarted = performance.now();
        const build = await buildDhaka3DTilesPackage({
          sourcePath: source,
          outputPath: packagePath,
          maxFeatures,
          syntheticHeightMeters,
        });
        sample.wallTimeMs.buildAndEmbeddedIntegrity = milliseconds(performance.now() - buildStarted);
        sample.residentSetBytes.afterBuild = process.memoryUsage().rss;
        sample.emittedFeatureCount = build.emittedFeatureCount;
        sample.excludedCounts = build.excludedCounts;
        sample.tilesetSha256 = build.tilesetSha256;
        sample.buildIntegrityStatus = build.integrity?.valid === true ? "pass" : "fail";

        const integrityStarted = performance.now();
        const integrity = await verifyTilesetPackage({ directory: packagePath, expectedSourceSha256: sample.sourceSha256 });
        sample.wallTimeMs.standaloneIntegrity = milliseconds(performance.now() - integrityStarted);
        sample.residentSetBytes.afterIntegrity = process.memoryUsage().rss;
        sample.integrity = {
          status: integrity.valid ? "pass" : "fail",
          contentCount: integrity.contentCount ?? null,
          bytesVerified: integrity.bytesVerified ?? null,
          errors: integrity.errors ?? [],
        };
        if (!integrity.valid) throw new Error("Standalone package integrity verification failed: " + (integrity.errors ?? []).join("; "));

        const alignmentStarted = performance.now();
        const alignment = await reviewDhaka3DTilesPackageAlignment({
          sourcePath: source,
          packageDirectory: packagePath,
          toleranceMeters,
        });
        sample.wallTimeMs.alignment = milliseconds(performance.now() - alignmentStarted);
        sample.residentSetBytes.afterAlignment = process.memoryUsage().rss;
        sample.alignment = {
          status: alignment.status,
          tileCount: alignment.summary?.tileCount ?? null,
          maximumHorizontalResidualMeters: alignment.summary?.maximumHorizontalResidualMeters ?? null,
          maximumFootprintPerimeterDifferenceMeters: alignment.summary?.maximumFootprintPerimeterDifferenceMeters ?? null,
          maximumEllipsoidHeightResidualMeters: alignment.summary?.maximumEllipsoidHeightResidualMeters ?? null,
          degenerateTriangleCountMaximumAcrossTiles: alignment.summary?.degenerateTriangleCountMaximumAcrossTiles ?? null,
          allTransformedVerticesInsideDeclaredRegions: alignment.summary?.allTransformedVerticesInsideDeclaredRegions ?? false,
          errors: alignment.errors ?? [],
        };
        if (alignment.status !== "pass") throw new Error("Footprint/placement alignment verification failed.");

        const packageFiles = await measurePackageFiles(packagePath);
        sample.packageBytes = packageFiles.totalBytes;
        sample.packageFileCount = packageFiles.fileCount;
        const manifest = JSON.parse(await readFile(path.join(packagePath, "build-manifest.json"), "utf8"));
        const glbSizes = manifest.tiles.map((tile) => tile.bytes).filter(Number.isFinite);
        sample.glbBytes = {
          min: Math.min(...glbSizes),
          median: percentile(glbSizes, 0.5),
          p95: percentile(glbSizes, 0.95),
          max: Math.max(...glbSizes),
          total: glbSizes.reduce((sum, value) => sum + value, 0),
        };
        sample.status = "pass";
      } catch (error) {
        sample.errors.push(error instanceof Error ? error.message : String(error));
      } finally {
        await rm(packagePath, { recursive: true, force: true });
      }
      samples.push(sample);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const report = {
    schemaVersion: 1,
    evidenceType: "dhaka-3d-tiles-bounded-scale-profile",
    status: samples.length === counts.length && samples.every((sample) => sample.status === "pass") ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    source: {
      relativePath: within(ROOT, source) ? path.relative(ROOT, source).split(path.sep).join("/") : path.basename(source),
      sha256: sha256(sourceBytes),
      bytes: sourceBytes.length,
      featureCount: parsedSource.features.length,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuCount: os.cpus().length,
      workflowSha: process.env.GITHUB_SHA ?? null,
      sourceHeadSha: process.env.P3_6_SOURCE_HEAD_SHA ?? process.env.GITHUB_SHA ?? null,
      eventName: process.env.GITHUB_EVENT_NAME ?? "local",
    },
    configuration: {
      featureCounts: counts,
      syntheticHeightMeters,
      alignmentToleranceMeters: toleranceMeters,
      memoryMeasurement: "RSS sampled at phase boundaries; not peak RSS and not isolated per-scale process memory.",
      performanceMeasurement: "Wall-clock time measured on the current runtime; no CI timing threshold is asserted.",
    },
    samples,
    releaseFlags: { ...RELEASE_FLAGS },
    limitations: [
      "The 8 m extrusion is synthetic and is not real building height or vertical accuracy evidence.",
      "This profile measures bounded package generation, integrity verification and footprint/placement review; it does not measure live browser/GPU latency or prove city-scale readiness.",
      "RSS readings are phase-boundary observations, not peak memory; shared CI-runner timings are comparative engineering evidence, not deployment service-level guarantees.",
      "A passing alignment gate compares the 2D source footprint with emitted geometry and ellipsoid transform, not independent surveyed ground/top elevations.",
      "Source rights, same-building independent truth and human architectural acceptance remain separate gates.",
    ],
  };
  report.reportSha256 = sha256(Buffer.from(JSON.stringify(report), "utf8"));
  if (reportPath) await writeReport(reportPath, report);
  return report;
}

function parseArgs(argv) {
  const args = {
    sourcePath: DEFAULT_SOURCE,
    featureCounts: [...DEFAULT_COUNTS],
    syntheticHeightMeters: 8,
    toleranceMeters: 0.5,
    reportPath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError("Missing value for " + flag + ".");
    if (flag === "--source") args.sourcePath = path.resolve(value);
    else if (flag === "--feature-counts") args.featureCounts = parseFeatureCounts(value);
    else if (flag === "--height-meters") args.syntheticHeightMeters = parsePositiveNumber(value, "height-meters", 250);
    else if (flag === "--tolerance-meters") args.toleranceMeters = parsePositiveNumber(value, "tolerance-meters", 5);
    else if (flag === "--report") args.reportPath = path.resolve(value);
    else throw new TypeError("Unknown argument: " + flag);
    index += 1;
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runDhaka3DTilesScaleProfile(args);
    process.stdout.write(JSON.stringify({
      status: report.status,
      sourceSha256: report.source.sha256,
      featureCounts: report.configuration.featureCounts,
      samples: report.samples,
      releaseFlags: report.releaseFlags,
      reportSha256: report.reportSha256,
      reportPath: args.reportPath,
    }, null, 2) + "\n");
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    console.error("Dhaka 3D Tiles scale profile failed: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
