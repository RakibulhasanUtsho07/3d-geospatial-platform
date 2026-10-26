#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { buildBuildingAccuracyBenchmark } from "../src/core/building-generation/building-accuracy-benchmark.mjs";
import { assessBuildingAccuracyEvidencePack, REQUIRED_RENDER_VIEWS } from "../src/core/building-generation/building-accuracy-evidence-pack.mjs";
import { validateBuildingCaptureManifestFile } from "./validate-building-capture-manifest.mjs";

const HASH = /^[a-f0-9]{64}$/i;
const SAFE_PNG = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function inside(root, relativePath, label, base = root) {
  if (typeof relativePath !== "string" || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new TypeError(label + " must be a non-empty relative path");
  }
  const resolved = path.resolve(base, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === "." || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new TypeError(label + " must resolve inside the project root");
  }
  return resolved;
}
async function safePath(root, target, kind = "file") {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new TypeError("Input path must be inside the project root");
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new TypeError("Project root must be a real directory");
  let current = root;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new TypeError("Input path must not traverse symlinks: " + relative);
    const isLast = index === parts.length - 1;
    if (!isLast && !info.isDirectory()) throw new TypeError("Input parent is not a directory: " + relative);
    if (isLast && kind === "file" && !info.isFile()) throw new TypeError("Input is not a regular file: " + relative);
    if (isLast && kind === "directory" && !info.isDirectory()) throw new TypeError("Input is not a directory: " + relative);
  }
}
async function readSafe(root, target, label) {
  await safePath(root, target);
  const bytes = await readFile(target);
  if (!bytes.length) throw new TypeError(label + " must not be empty");
  return bytes;
}
async function hashSafe(root, target, label) {
  await safePath(root, target);
  const info = await lstat(target);
  if (info.size < 1) throw new TypeError(label + " must not be empty");
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha256: digest.digest("hex"), bytes: info.size };
}
async function jsonFile(root, target, label) {
  const bytes = await readSafe(root, target, label);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new TypeError(label + " is not valid JSON: " + (error instanceof Error ? error.message : String(error))); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(label + " must contain a JSON object");
  return { value, bytes };
}
function checkExpected(expected, actual, label) {
  if (expected === undefined || expected === null || expected === "") return false;
  if (typeof expected !== "string" || !HASH.test(expected)) throw new TypeError(label + " expected SHA-256 is invalid");
  if (expected.toLowerCase() !== actual.toLowerCase()) throw new Error(label + " hash mismatch: expected " + expected + ", actual " + actual);
  return true;
}
async function declaredAssets(items, root, label) {
  if (!Array.isArray(items)) throw new TypeError(label + " must be an array");
  const output = [];
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(label + "[" + index + "] must be an object");
    const target = inside(root, item.path, label + "[" + index + "].path");
    const digest = await hashSafe(root, target, label + "[" + index + "]");
    checkExpected(item.expectedSha256, digest.sha256, label + "[" + index + "]");
    output.push({ ...item, path: path.relative(root, target).split(path.sep).join("/"), ...digest });
  }
  return output;
}
async function inspectRenders(declaration, root, modelHash, buildingId) {
  if (!declaration || typeof declaration !== "object") throw new TypeError(buildingId + ".renderEvidence is required");
  const manifestPath = inside(root, declaration.manifestPath, buildingId + ".renderEvidence.manifestPath");
  const { value: manifest, bytes } = await jsonFile(root, manifestPath, buildingId + " render manifest");
  const manifestHash = sha256(bytes);
  const pinned = checkExpected(declaration.expectedManifestSha256, manifestHash, buildingId + " render manifest");
  const renderDir = inside(root, declaration.directory, buildingId + ".renderEvidence.directory");
  await safePath(root, renderDir, "directory");
  const views = [];
  for (const view of Array.isArray(manifest.views) ? manifest.views : []) {
    if (!view || typeof view.id !== "string" || typeof view.filename !== "string" ||
      !SAFE_PNG.test(view.filename) || view.filename.includes("..") || view.filename.includes("/") || view.filename.includes("\\")) {
      views.push({ id: view?.id ?? "unknown", verified: false, integrityError: true, error: "invalid-render-entry" });
      continue;
    }
    try {
      const target = inside(root, view.filename, buildingId + " render PNG", renderDir);
      const actual = await hashSafe(root, target, buildingId + " render " + view.filename);
      const verified = HASH.test(view.sha256 ?? "") && view.sha256.toLowerCase() === actual.sha256 &&
        view.bytes === actual.bytes && view.renderComplete === true &&
        Number.isSafeInteger(view.width) && view.width >= 256 &&
        Number.isSafeInteger(view.height) && view.height >= 256;
      views.push({ id: view.id, filename: view.filename, verified, integrityError: !verified,
        sha256: actual.sha256, bytes: actual.bytes, width: view.width ?? 0, height: view.height ?? 0 });
    } catch (error) {
      views.push({ id: view.id, filename: view.filename, verified: false, integrityError: false,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    valid: manifest.valid === true && manifest.status === "render-set-ready-for-human-review" &&
      Array.isArray(manifest.errors) && manifest.errors.length === 0,
    manifestPath: path.relative(root, manifestPath).split(path.sep).join("/"),
    manifestSha256: manifestHash,
    expectedManifestSha256: pinned ? manifestHash : null,
    modelSha256: manifest.modelSha256 ?? null,
    views,
  };
}

function normalizedPath(value) {
  return typeof value === "string" ? value.replaceAll("\\\\", "/") : null;
}
function matchingDate(left, right) {
  return typeof left === "string" && typeof right === "string" &&
    Number.isFinite(Date.parse(left)) && Number.isFinite(Date.parse(right)) &&
    Date.parse(left) === Date.parse(right);
}

/** Bind the existing accuracy-pack assets and measurement config to one pinned capture manifest. */
export function evaluateCaptureManifestBindings({ buildingId, manifest, captureReport, sourceMedia = [],
  referenceImages = [], dimensionReference = null, groundControl = null } = {}) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  if (!manifest || !captureReport) {
    for (const id of ["capture-manifest-present", "capture-assets-bound", "reference-assets-bound",
      "dimension-measurements-bound", "ground-control-bound"]) {
      add(id, "warning", "Capture manifest is missing; legacy evidence can be inspected but cannot complete the new binding gate.");
    }
    return { status: "incomplete", bindingsValid: false, checks };
  }
  add("capture-manifest-present",
    manifest.schemaVersion === "1.0.0" && manifest.buildingId === buildingId && captureReport.buildingId === buildingId,
    "Capture manifest identity and schema must match this exact building.",
    manifest.buildingId !== buildingId || captureReport.buildingId !== buildingId ? "failed" : "warning");

  const bindAssets = (declared, purpose, checkId) => {
    const captured = Array.isArray(manifest.sources) ? manifest.sources.filter((item) => item?.purpose === purpose) : [];
    let mismatch = false;
    const compare = (asset) => {
      const src = captured.find((item) => item.id === asset.id);
      if (!src) return false;
      const kindMatches = purpose !== "capture" || src.kind === asset.kind ||
        (src.kind === "video-frame" && ["photo", "video"].includes(asset.kind));
      return kindMatches && normalizedPath(src.path) === normalizedPath(asset.path) &&
        typeof src.sha256 === "string" && src.sha256.toLowerCase() === asset.sha256.toLowerCase() &&
        src.bytes === asset.bytes && src.side === asset.side &&
        src.sourceId === asset.sourceId && src.rights?.status === asset.rightsStatus &&
        src.rights?.evidenceId === asset.rightsEvidenceId &&
        src.rights?.reviewedBy === asset.verifiedBy &&
        matchingDate(src.rights?.reviewedAt, asset.verifiedAt);
    };
    const rowsMatch = declared.every(compare);
    const declaredIds = new Set(declared.map((item) => item.id));
    const manifestIds = new Set(captured.map((item) => item.id));
    const sameCoverage = declaredIds.size === manifestIds.size &&
      [...manifestIds].every((id) => declaredIds.has(id));
    mismatch = !rowsMatch || !sameCoverage;
    add(checkId, mismatch ? "failed" : "passed",
      mismatch ? "A declared evidence-pack asset is missing from or differs from the capture manifest." :
        "Every declared asset is bound by ID, path, hash, bytes, side and rights-review provenance.");
  };
  bindAssets(sourceMedia, "capture", "capture-assets-bound");
  bindAssets(referenceImages, "reference", "reference-assets-bound");

  if (!dimensionReference || !manifest.measurements?.length) {
    add("dimension-measurements-bound", "warning", "Independent dimension records or benchmark dimension config are missing.");
  } else {
    const configured = dimensionReference.referenceDimensionsM ?? {};
    const evidence = dimensionReference.evidence ?? {};
    const byAxis = new Map(manifest.measurements.map((item) => [item.axis, item]));
    let missing = false, mismatch = false;
    for (const axis of ["x", "y", "z"]) {
      const item = byAxis.get(axis);
      if (!item || !Number.isFinite(item.valueM) || !Number.isFinite(item.uncertaintyM)) {
        missing = true; continue;
      }
      if (!Number.isFinite(configured[axis])) { missing = true; continue; }
      if (Math.abs(configured[axis] - item.valueM) > item.uncertaintyM + 1e-3) mismatch = true;
      if (item.basis !== evidence.basis) mismatch = true;
      if (!(item.sourceId === evidence.referenceId || item.evidenceId === evidence.referenceId)) mismatch = true;
    }
    const status = mismatch ? "failed" : missing ? "warning" : "passed";
    add("dimension-measurements-bound", status,
      mismatch ? "Benchmark dimensions/basis/reference ID differ from the independent capture-manifest measurements." :
        missing ? "One or more axis dimensions are missing and cannot be bound." :
          "Benchmark dimensions match the independently evidenced x/y/z measurements within recorded uncertainty.");
  }

  const configuredControls = groundControl?.controlPoints;
  if (!Array.isArray(configuredControls) || configuredControls.length < 3 || !Array.isArray(manifest.controlPoints) ||
      manifest.controlPoints.length < 3) {
    add("ground-control-bound", "warning", "At least three configured and documented ground-control points are needed for binding.");
  } else {
    const everyPointMatches = configuredControls.every((item) => {
      const source = manifest.controlPoints.find((candidate) => candidate.id === item.id);
      const linkedSourceId = item.evidenceSourceId ?? item.sourceId;
      return source && source.status === "verified" &&
        Number.isFinite(item.longitude) && Number.isFinite(item.latitude) &&
        Math.abs(source.longitude - item.longitude) <= 1e-8 &&
        Math.abs(source.latitude - item.latitude) <= 1e-8 &&
        (linkedSourceId === source.sourceId || linkedSourceId === source.evidenceId);
    });
    add("ground-control-bound", everyPointMatches ? "passed" : "failed",
      everyPointMatches ? "Configured WGS84 control points match the verified capture-manifest IDs and evidence sources." :
        "A configured control point has an ID, coordinate or evidence-source mismatch against the capture manifest.");
  }

  const status = checks.some((item) => item.status === "failed") ? "failed" :
    checks.some((item) => item.status === "warning") ? "incomplete" : "ready-for-review";
  return { status, bindingsValid: status === "ready-for-review", checks };
}

export async function buildBuildingAccuracyEvidencePackFromManifest({ manifestPath, rootDir = process.cwd(), generatedAt = new Date().toISOString() }) {
  const root = path.resolve(rootDir);
  const targetManifest = inside(root, manifestPath, "pack manifest");
  const { value: manifest } = await jsonFile(root, targetManifest, "pack manifest");
  if (manifest.schemaVersion !== "1.0.0" || typeof manifest.packId !== "string" || !Array.isArray(manifest.buildings)) {
    throw new TypeError("pack manifest schemaVersion 1.0.0, packId and buildings[] are required");
  }
  const prepared = [];
  for (const entry of manifest.buildings) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Each buildings[] entry must be an object");
    const buildingId = entry.buildingId;
    const modelPath = inside(root, entry.candidateGlbPath, buildingId + ".candidateGlbPath");
    if (path.extname(modelPath).toLowerCase() !== ".glb") throw new TypeError(buildingId + " candidate must be a .glb file");
    const modelBytes = await readSafe(root, modelPath, buildingId + " GLB");
    const modelHash = sha256(modelBytes);
    checkExpected(entry.expectedGlbSha256, modelHash, buildingId + " GLB");
    const geometryQa = analyzeGlbQuality(modelBytes);

    const configPath = inside(root, entry.benchmarkConfigPath, buildingId + ".benchmarkConfigPath");
    const { value: config } = await jsonFile(root, configPath, buildingId + " benchmark config");
    if (config.schemaVersion !== "1.0.0" || config.buildingId !== buildingId) {
      throw new TypeError(buildingId + " benchmark config schemaVersion/buildingId does not match the pack");
    }
    let review = null;
    if (typeof config.renderReferenceReviewReportPath === "string" && config.renderReferenceReviewReportPath.trim()) {
      const reviewPath = inside(root, config.renderReferenceReviewReportPath, buildingId + " review report path");
      review = (await jsonFile(root, reviewPath, buildingId + " render/reference review report")).value;
    }
    const benchmarkReport = buildBuildingAccuracyBenchmark({
      buildingId, candidateGlbSha256: modelHash, geometryQa,
      dimensionReference: config.dimensionReference, groundControl: config.groundControl,
      renderReferenceReview: review, generatedAt,
    });
    const sourceMedia = await declaredAssets(entry.sourceMedia ?? [], root, buildingId + ".sourceMedia");
    const referenceImages = await declaredAssets(entry.referenceImages ?? [], root, buildingId + ".referenceImages");
    const renderEvidence = await inspectRenders(entry.renderEvidence, root, modelHash, buildingId);

    let rawCaptureManifest = null;
    let captureManifestReport = null;
    if (typeof entry.captureManifestPath === "string" && entry.captureManifestPath.trim()) {
      const capturePath = inside(root, entry.captureManifestPath, buildingId + ".captureManifestPath");
      const captureBytes = await readSafe(root, capturePath, buildingId + " capture manifest");
      try { rawCaptureManifest = JSON.parse(captureBytes.toString("utf8")); }
      catch (error) { throw new TypeError(buildingId + " capture manifest is not valid JSON: " + (error instanceof Error ? error.message : String(error))); }
      captureManifestReport = await validateBuildingCaptureManifestFile({
        manifestPath: path.relative(root, capturePath).split(path.sep).join("/"),
        rootDir: root,
        expectedSha256: entry.expectedCaptureManifestSha256 ?? null,
      });
    }
    const bindingReport = evaluateCaptureManifestBindings({
      buildingId, manifest: rawCaptureManifest, captureReport: captureManifestReport,
      sourceMedia, referenceImages, dimensionReference: config.dimensionReference, groundControl: config.groundControl,
    });
    const captureManifestEvidence = captureManifestReport ? {
      status: captureManifestReport.status,
      buildingId: captureManifestReport.buildingId,
      manifestPath: captureManifestReport.input.manifestPath,
      manifestSha256: captureManifestReport.input.manifestSha256,
      expectedSha256Pinned: captureManifestReport.input.expectedSha256Pinned === true,
      bindingsValid: bindingReport.bindingsValid,
      bindingStatus: bindingReport.status,
      checks: [...captureManifestReport.checks, ...bindingReport.checks],
    } : { status: "missing", buildingId: null, manifestPath: null, manifestSha256: null,
      expectedSha256Pinned: false, bindingsValid: false, bindingStatus: "incomplete", checks: bindingReport.checks };
    if (captureManifestReport && bindingReport.status !== "ready-for-review") {
      captureManifestEvidence.status = bindingReport.status === "failed" ? "failed" : "incomplete";
    }
    prepared.push({
      buildingId, category: entry.category, sourceIdentity: entry.sourceIdentity ?? null, captureManifestEvidence,
      candidate: { path: path.relative(root, modelPath).split(path.sep).join("/"), bytes: modelBytes.length,
        sha256: modelHash, expectedSha256: HASH.test(entry.expectedGlbSha256 ?? "") ? entry.expectedGlbSha256.toLowerCase() : null,
        geometryQa },
      sourceMedia, referenceImages, renderEvidence, renderReferenceReview: review, benchmarkReport,
      verticalDatum: entry.verticalDatum ?? { status: "not-solved" },
    });
  }
  return assessBuildingAccuracyEvidencePack({
    packId: manifest.packId, generatedAt,
    candidateCommit: manifest.candidateCommit ?? process.env.GITHUB_SHA?.slice(0, 40) ?? null,
    buildings: prepared,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const rootFlag = args.find((arg) => arg.startsWith("--root="));
  const positional = args.filter((arg) => !arg.startsWith("--root="));
  const [manifestArg, reportArg] = positional;
  if (!manifestArg || positional.length > 2) {
    console.error("Usage: node scripts/build-building-accuracy-evidence-pack.mjs <pack-manifest.json> [report.json] [--root=project-root]");
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(rootFlag ? rootFlag.slice("--root=".length) : process.cwd());
  try {
    const report = await buildBuildingAccuracyEvidencePackFromManifest({ manifestPath: manifestArg, rootDir: root });
    const output = reportArg
      ? inside(root, reportArg, "report output")
      : path.join(root, "artifacts", "building-accuracy-evidence-pack", report.packId + "-report.json");
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "w" });
    console.log(JSON.stringify({ report: path.relative(root, output), packId: report.packId, status: report.status,
      buildings: report.counts.buildings, checksPassed: report.counts.checksPassed,
      checksWarning: report.counts.checksWarning, checksFailed: report.counts.checksFailed,
      publicationEligible: report.policy.publicationEligible }, null, 2));
    if (report.status === "benchmark-failed") process.exitCode = 1;
    else if (report.status === "benchmark-incomplete") process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
