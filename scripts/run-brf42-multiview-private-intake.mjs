#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBrf14MultiviewSource } from "./verify-brf14-multiview-source.mjs";
import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import { assessBuildingMediaSources } from "../src/core/building-generation/media-quality-preflight.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(REPOSITORY_ROOT, "benchmarks/building-reconstruction/brf-14-multiview-source.json");
const BUILDING_ID = "brf42-flat-roof-demo";
const RELEASE_FLAGS = Object.freeze({
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
  automaticApproval: false,
});

function fail(message) {
  const error = new Error(message);
  error.name = "Brf42MultiviewIntakeError";
  throw error;
}
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function pathFromArgs(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(label + " is required.");
  return path.resolve(value);
}
function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(label + " must be a safe workspace-relative path.");
  }
  return value;
}
function assertVerificationReportMatchesManifest(manifest, priorReport) {
  if (!isObject(priorReport) ||
      priorReport.status !== "views-byte-verified" ||
      priorReport.sampleId !== manifest.sampleId ||
      priorReport.selectedViewCount !== manifest.views.length ||
      priorReport.actualTotalBytes !== manifest.expectedTotalBytes ||
      !Array.isArray(priorReport.views) ||
      priorReport.views.length !== manifest.views.length ||
      !Array.isArray(priorReport.blockers) ||
      priorReport.blockers.length !== 0) {
    fail("The preceding BRF-14 verification report is missing, blocked, or inconsistent with the manifest.");
  }
  const byId = new Map(priorReport.views.map((view) => [view.id, view]));
  for (const source of manifest.views) {
    const verified = byId.get(source.id);
    if (!verified ||
        verified.status !== "passed" ||
        verified.filename !== source.filename ||
        verified.sourceUrl !== source.sourceUrl ||
        verified.expectedByteSize !== source.expectedByteSize ||
        verified.actualByteSize !== source.expectedByteSize ||
        verified.expectedSha256 !== source.expectedSha256 ||
        verified.actualSha256 !== source.expectedSha256 ||
        verified.sizeMatches !== true ||
        verified.hashMatches !== true) {
      fail("The preceding verification report does not prove the exact pinned bytes for " + source.id + ".");
    }
  }
}
function compareFreshVerification(manifest, priorReport, freshReport) {
  if (freshReport.status !== "views-byte-verified" ||
      freshReport.selectedViewCount !== manifest.views.length ||
      freshReport.actualTotalBytes !== priorReport.actualTotalBytes ||
      freshReport.views.length !== priorReport.views.length) {
    fail("Fresh source-byte revalidation did not reproduce the prior BRF-14 pass.");
  }
  for (const source of manifest.views) {
    const prior = priorReport.views.find((view) => view.id === source.id);
    const fresh = freshReport.views.find((view) => view.id === source.id);
    if (!prior || !fresh || fresh.status !== "passed" ||
        prior.actualSha256 !== fresh.actualSha256 ||
        prior.actualByteSize !== fresh.actualByteSize ||
        fresh.actualSha256 !== source.expectedSha256 ||
        fresh.actualByteSize !== source.expectedByteSize) {
      fail("Fresh source-byte revalidation changed or disagreed for " + source.id + ".");
    }
  }
}
function makeQualitySummary(quality, sourceManifest) {
  const expectedById = new Map(sourceManifest.views.map((view) => [view.id, view]));
  const expectedIds = sourceManifest.views.map((view) => view.id);
  const sourceResults = Array.isArray(quality.sources) ? quality.sources : [];
  const resultsById = new Map(sourceResults.map((source) => [source.sourceId, source]));
  const allSourcesMatch = sourceResults.length === expectedIds.length &&
    expectedIds.every((id) => {
      const result = resultsById.get(id);
      const expected = expectedById.get(id);
      return Boolean(result && expected &&
        !result.error &&
        result.sha256 === expected.expectedSha256 &&
        result.byteSize === expected.expectedByteSize &&
        result.width === expected.declaredWidth &&
        result.height === expected.declaredHeight);
    });
  const analysisComplete = quality.qualityAnalysisComplete === true && allSourcesMatch;
  return {
    status: analysisComplete ? "all-images-decoded-and-measured" : "blocked",
    qualityAnalysisComplete: analysisComplete,
    sourceCount: quality.sourceCount ?? sourceResults.length,
    uniqueContentCount: quality.uniqueContentCount ?? 0,
    rightsApproved: quality.rightsApproved === true,
    safeToSubmitToColmap: quality.safeToSubmitToColmap === true,
    qualityOnlyReconstructionCandidate: quality.reconstructionCandidate === true,
    warnings: Array.isArray(quality.warnings) ? quality.warnings : [],
    nearDuplicatePairs: Array.isArray(quality.nearDuplicatePairs) ? quality.nearDuplicatePairs : [],
    sources: sourceResults.map((source) => ({
      sourceId: source.sourceId,
      sha256: source.sha256 ?? null,
      byteSize: source.byteSize ?? null,
      width: source.width ?? null,
      height: source.height ?? null,
      usageStatus: source.usageStatus ?? "unreviewed",
      licence: source.licence ?? "unknown",
      quality: source.quality ?? null,
      error: source.error ?? null,
    })),
    limitations: Array.isArray(quality.limitations) ? quality.limitations : [],
  };
}

export async function runBrf42MultiviewPrivateIntake(options) {
  if (!isObject(options)) throw new TypeError("options are required.");
  const workspaceArg = pathFromArgs(options.workspaceRoot, "workspaceRoot");
  const assetRootArg = pathFromArgs(options.assetRoot, "assetRoot");
  const workspaceRoot = await realpath(workspaceArg);
  const assetRootInfo = await lstat(assetRootArg);
  if (assetRootInfo.isSymbolicLink() || !assetRootInfo.isDirectory()) {
    fail("assetRoot must be a real directory and must not be a symbolic link.");
  }
  const assetRoot = await realpath(assetRootArg);
  if (!isInside(workspaceRoot, assetRoot) || assetRoot === workspaceRoot) {
    fail("assetRoot must be a child directory within workspaceRoot so the existing private intake can safely ingest it.");
  }

  const manifestBytes = options.manifestBytes ?? Buffer.from(JSON.stringify(options.manifest ?? {}));
  const manifest = options.manifest ?? JSON.parse(manifestBytes.toString("utf8"));
  const priorReportBytes = options.verificationReportBytes ?? Buffer.from(JSON.stringify(options.verificationReport ?? {}));
  const priorReport = options.verificationReport ?? JSON.parse(priorReportBytes.toString("utf8"));

  if (!isObject(manifest) || !Array.isArray(manifest.views) || manifest.views.length < 3) {
    fail("A valid BRF-14 multi-view manifest with at least three views is required.");
  }
  assertVerificationReportMatchesManifest(manifest, priorReport);

  // Re-hash every actual image again before the first private record is created.
  // The earlier report is evidence, but it is not a substitute for verifying current local bytes.
  const freshVerification = await verifyBrf14MultiviewSource(manifest, assetRoot);
  compareFreshVerification(manifest, priorReport, freshVerification);

  const ingestedRecords = [];
  for (const view of manifest.views) {
    const localRelativePath = path.relative(workspaceRoot, path.join(assetRoot, view.filename)).split(path.sep).join("/");
    safeRelativePath(localRelativePath, "source image path");
    const ingested = await ingestMediaFile({
      workspaceRoot,
      sourcePath: localRelativePath,
      buildingId: BUILDING_ID,
      sourceId: view.id,
      kind: "image",
      title: view.filename,
      author: "Matthew Guertin",
      attribution: manifest.dataset.attribution,
      capturedAt: view.capturedAt,
      sourceUrl: view.sourceUrl,
      captureLocation: {
        longitude: view.gps.longitude,
        latitude: view.gps.latitude,
      },
      licence: "CC BY 4.0 (source-declared for imagery; source-owner authority not independently authenticated)",
      usageStatus: "unreviewed",
      description: "BRF-42 private multi-view engineering test only. Source imagery is not independently rights-authenticated; no reconstruction, public distribution or map publication is authorized by this report.",
    });
    if (ingested.record.sha256 !== view.expectedSha256 ||
        ingested.record.byteSize !== view.expectedByteSize ||
        ingested.record.kind !== "image" ||
        ingested.record.usageStatus !== "unreviewed" ||
        ingested.record.url !== view.sourceUrl ||
        ingested.record.capturedAt !== view.capturedAt ||
        ingested.record.location?.longitude !== view.gps.longitude ||
        ingested.record.location?.latitude !== view.gps.latitude) {
      fail("Private media intake did not preserve the source bytes and source metadata for " + view.id + ".");
    }
    ingestedRecords.push({
      sourceId: ingested.record.id,
      sha256: ingested.record.sha256,
      byteSize: ingested.record.byteSize,
      sourceUrl: ingested.record.url,
      capturedAt: ingested.record.capturedAt,
      location: ingested.record.location,
      usageStatus: ingested.record.usageStatus,
      licence: ingested.record.licence,
    });
  }

  const sourceIds = manifest.views.map((view) => view.id);
  const quality = await assessBuildingMediaSources({
    workspaceRoot,
    buildingId: BUILDING_ID,
    sourceIds,
    timeoutMs: options.timeoutMs ?? 30000,
    nearDuplicateThreshold: 5,
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
  });
  const qualitySummary = makeQualitySummary(quality, manifest);
  const reportStatus = qualitySummary.qualityAnalysisComplete
    ? "private-multiview-preflight-complete-not-reconstruction-approved"
    : "blocked";
  return {
    schemaVersion: "1.0.0",
    evaluationId: "BRF-42-PRIVATE-MULTIVIEW-INTAKE",
    status: reportStatus,
    workspaceMode: "ephemeral-private",
    sourceManifest: {
      sampleId: manifest.sampleId,
      sourceCommit: manifest.dataset.sourceRepositoryCommit,
      declaredLicense: manifest.dataset.license,
      licenseScope: manifest.dataset.licenseScope,
      rightsStatus: manifest.dataset.rightsStatus,
      attribution: manifest.dataset.attribution,
      manifestSha256: sha256(manifestBytes),
      priorVerificationReportSha256: sha256(priorReportBytes),
      freshVerificationReportSha256: sha256(Buffer.from(JSON.stringify(freshVerification))),
    },
    byteVerification: {
      status: freshVerification.status,
      selectedViewCount: freshVerification.selectedViewCount,
      verifiedViewCount: freshVerification.views.filter((view) => view.status === "passed").length,
      declaredTotalBytes: freshVerification.declaredTotalBytes,
      actualTotalBytes: freshVerification.actualTotalBytes,
      blockers: freshVerification.blockers,
    },
    privateMediaIntake: {
      status: ingestedRecords.length === manifest.views.length ? "all-views-ingested-private" : "blocked",
      buildingId: BUILDING_ID,
      selectedViewCount: manifest.views.length,
      ingestedCount: ingestedRecords.length,
      records: ingestedRecords,
    },
    imageQualityPreflight: qualitySummary,
    reviewAndRelease: {
      rightsReview: "pending-human-review",
      sameBuildingIdentity: "source-declared-not-independently-confirmed",
      visualOverlap: "pending-human-review",
      facadeRoofCoverage: "pending-human-review",
      sourceUpAxis: "pending-human-review",
      independentReferenceVerified: false,
      candidateGlbGenerated: false,
      reconstructionExecuted: false,
      realWorldAccuracyValidated: false,
      publicSourceRedistributionPermittedByThisGate: false,
      derivedModelPublicationPermittedByThisGate: false,
      productionMapPublicationPermitted: false,
    },
    releaseFlags: { ...RELEASE_FLAGS },
    note: "This report confirms byte-pinned private ingestion and image-quality screening only. It is not a human overlap decision, source-rights approval, COLMAP authorization, candidate GLB, independent geometry result or real-building accuracy claim. Only this metadata report may be uploaded; do not upload raw images or the private media store.",
  };
}

function parseArgs(args) {
  const parsed = {
    manifestPath: null,
    verificationReportPath: null,
    assetRoot: null,
    workspaceRoot: null,
    reportPath: null,
    ffmpegPath: null,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") { parsed.help = true; return parsed; }
    const optionsByArg = {
      "--manifest": "manifestPath",
      "--verification-report": "verificationReportPath",
      "--asset-root": "assetRoot",
      "--workspace": "workspaceRoot",
      "--report": "reportPath",
      "--ffmpeg": "ffmpegPath",
    };
    const key = optionsByArg[arg];
    if (!key) fail("Unknown argument: " + arg + ".");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) fail("Missing value after " + arg + ".");
    if (parsed[key] !== null) fail("Duplicate argument: " + arg + ".");
    parsed[key] = value;
    index += 1;
  }
  for (const key of ["manifestPath", "verificationReportPath", "assetRoot", "workspaceRoot", "reportPath"]) {
    if (!parsed[key]) fail("All of --manifest, --verification-report, --asset-root, --workspace and --report are required.");
  }
  return parsed;
}
async function writeReport(reportPath, report) {
  const cwd = await realpath(process.cwd());
  const target = path.resolve(cwd, reportPath);
  if (!isInside(cwd, target) || target === cwd) fail("Report path must remain inside the current working directory.");
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const actualParent = await realpath(parent);
  if (!isInside(cwd, actualParent)) fail("Report parent directory resolves outside the current working directory.");
  try { await access(target); fail("Refusing to overwrite an existing report."); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  await writeFile(target, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log("Usage: node scripts/run-brf42-multiview-private-intake.mjs --manifest <json> --verification-report <json> --asset-root <download-dir> --workspace <temp-dir> --report <metadata-json> [--ffmpeg <executable>]\nRe-hashes the selected BRF-14 images, ingests them privately, and runs image-quality preflight. It does not run COLMAP or validate real-building accuracy.");
    return;
  }
  try {
    const manifestBytes = await readFile(path.resolve(args.manifestPath));
    const verificationReportBytes = await readFile(path.resolve(args.verificationReportPath));
    const report = await runBrf42MultiviewPrivateIntake({
      ...args,
      manifestBytes,
      verificationReportBytes,
      manifest: JSON.parse(manifestBytes.toString("utf8")),
      verificationReport: JSON.parse(verificationReportBytes.toString("utf8")),
    });
    await writeReport(args.reportPath, report);
    console.log(JSON.stringify({
      status: report.status,
      verifiedViewCount: report.byteVerification.verifiedViewCount,
      ingestedCount: report.privateMediaIntake.ingestedCount,
      qualityAnalysisComplete: report.imageQualityPreflight.qualityAnalysisComplete,
      rightsApproved: report.imageQualityPreflight.rightsApproved,
      safeToSubmitToColmap: report.imageQualityPreflight.safeToSubmitToColmap,
      releaseFlags: report.releaseFlags,
    }, null, 2));
    if (report.status !== "private-multiview-preflight-complete-not-reconstruction-approved") process.exitCode = 2;
  } catch (error) {
    console.error("BRF-42 multi-view private intake blocked: " + (error instanceof Error ? error.message : "unexpected error"));
    process.exitCode = 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
