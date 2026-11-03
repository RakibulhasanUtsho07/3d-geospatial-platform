#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBrf13DroneImageSource } from "./verify-brf13-drone-image-source.mjs";
import { validateBrf41InterimDatasetPolicy } from "../src/core/building-generation/brf41-interim-dataset-policy.mjs";
import { ingestMediaFile } from "../src/core/building-generation/media-intake.mjs";
import { assessBuildingMediaSources } from "../src/core/building-generation/media-quality-preflight.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = path.join(repoRoot, "benchmarks/building-reconstruction/brf-41-interim-dataset-policy.json");
const sourceManifestPath = path.join(repoRoot, "benchmarks/building-reconstruction/brf-13-drone-image-source.json");
const SAMPLE_ID = "brf13-flat-roof-image-0005";
const BUILDING_ID = "brf41-demo-commercial-building";
const SOURCE_ID = "brf41-demo-image-0005";
const RELEASE_FLAGS = Object.freeze({
  acceptanceEligible: false,
  publicationEligible: false,
  mapReady: false,
  automaticApproval: false,
});

function fail(message) {
  const error = new Error(message);
  error.name = "Brf41DemoSmokeTestError";
  throw error;
}
function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\") ||
      value.startsWith("/") || /^[a-z]:/i.test(value) ||
      value.split("/").some(part => !part || part === "." || part === "..")) {
    fail(label + " must be a safe workspace-relative path.");
  }
  return value;
}
function assertAdmissionPolicy(policyManifest, sourceManifest) {
  const report = validateBrf41InterimDatasetPolicy(policyManifest);
  if (report.status !== "policy-compliant-demo-only" || report.blockers.length) {
    fail("BRF-41 admission policy is blocked: " + report.blockers.join(", "));
  }
  const asset = policyManifest.assets.find(item => item?.id === SAMPLE_ID);
  if (!asset || asset.decision !== "demo-only" ||
      asset.rights?.status !== "source-declared-not-independently-authenticated" ||
      !asset.allowedUses?.includes("private-image-ingestion-smoke-test") ||
      !asset.allowedUses?.includes("private-image-quality-preflight")) {
    fail("BRF-13 sample is not explicitly admitted for this bounded private smoke test.");
  }
  const pin = asset.source;
  const source = sourceManifest?.asset;
  if (!source || source.role !== "candidate-image" ||
      pin.assetUrl !== source.sourceUrl ||
      pin.fileName !== source.filename ||
      pin.byteSize !== source.expectedByteSize ||
      pin.sha256?.toLowerCase() !== source.expectedSha256?.toLowerCase() ||
      sourceManifest.sampleId !== SAMPLE_ID ||
      sourceManifest.evaluationStage !== "source-byte-intake-only") {
    fail("BRF-13 source manifest does not match the exact BRF-41 admission pin.");
  }
  return { report, asset };
}
export async function runBrf41DemoImageSmokeTest(options) {
  if (!options || typeof options !== "object") throw new TypeError("options are required.");
  const workspaceRoot = await realpath(path.resolve(options.workspaceRoot ?? ""));
  const sourceRelativePath = safeRelativePath(options.sourceRelativePath, "sourceRelativePath");
  const sourcePath = path.resolve(workspaceRoot, ...sourceRelativePath.split("/"));
  if (!isInside(workspaceRoot, sourcePath) || sourcePath === workspaceRoot) {
    fail("Source image path escapes the temporary workspace.");
  }

  const policyManifest = options.policyManifest ?? JSON.parse(await readFile(policyPath, "utf8"));
  const sourceManifest = options.sourceManifest ?? JSON.parse(await readFile(sourceManifestPath, "utf8"));
  const { report: admissionReport, asset: admittedAsset } = assertAdmissionPolicy(policyManifest, sourceManifest);

  const sourceStat = await lstat(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    fail("Downloaded image must be a regular, non-symlink file inside the temporary workspace.");
  }

  const byteVerification = await verifyBrf13DroneImageSource(sourceManifest, sourcePath);
  if (byteVerification.status !== "bytes-verified" ||
      byteVerification.asset.actualSha256 !== admittedAsset.source.sha256 ||
      byteVerification.asset.actualByteSize !== admittedAsset.source.byteSize) {
    fail("Downloaded image byte verification failed; media intake was not started.");
  }

  const ingested = await ingestMediaFile({
    workspaceRoot,
    sourcePath: sourceRelativePath,
    buildingId: BUILDING_ID,
    sourceId: SOURCE_ID,
    kind: "image",
    title: "BRF-41 private demo imagery — flat-roof commercial building",
    author: "Matthew Guertin",
    attribution: sourceManifest.dataset.attribution,
    sourceUrl: sourceManifest.asset.sourceUrl,
    licence: "CC BY 4.0 (source-declared; imagery scope only; not independently authenticated)",
    usageStatus: "unreviewed",
    description: "Private BRF-41 engineering smoke test only. Not independent reference truth, not a held-out checkpoint and not eligible for publication or production-map use.",
  });

  if (ingested.record.sha256 !== byteVerification.asset.actualSha256 ||
      ingested.record.byteSize !== byteVerification.asset.actualByteSize ||
      ingested.record.kind !== "image" ||
      ingested.record.usageStatus !== "unreviewed") {
    fail("Private media intake output did not preserve source bytes or the unreviewed rights state.");
  }

  const quality = await assessBuildingMediaSources({
    workspaceRoot,
    buildingId: BUILDING_ID,
    sourceIds: [SOURCE_ID],
    timeoutMs: options.timeoutMs ?? 30000,
    nearDuplicateThreshold: 5,
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(options.spawnImpl ? { spawnImpl: options.spawnImpl } : {}),
  });

  const qualitySource = quality.sources[0];
  const qualityOk = quality.qualityAnalysisComplete === true &&
    quality.sourceCount === 1 &&
    qualitySource?.sha256 === ingested.record.sha256 &&
    qualitySource?.byteSize === ingested.record.byteSize &&
    qualitySource?.width === sourceManifest.asset.width &&
    qualitySource?.height === sourceManifest.asset.height;
  const safetyOk = quality.rightsApproved === false &&
    quality.reconstructionCandidate === false &&
    quality.safeToSubmitToColmap === false;
  const status = qualityOk && safetyOk
    ? "demo-smoke-tested-not-accuracy-validated"
    : "blocked";

  const result = {
    schemaVersion: "1.0.0",
    evaluationId: "BRF-41-PRIVATE-DEMO-IMAGE-INGESTION",
    status,
    privateWorkspaceOnly: true,
    source: {
      assetId: SAMPLE_ID,
      fileName: sourceManifest.asset.filename,
      sourceUrl: sourceManifest.asset.sourceUrl,
      expectedByteSize: sourceManifest.asset.expectedByteSize,
      expectedSha256: sourceManifest.asset.expectedSha256,
    },
    admission: {
      status: admissionReport.status,
      decision: admittedAsset.decision,
      allowedUses: admittedAsset.allowedUses,
      deniedUses: admittedAsset.deniedUses,
      rightsStatus: admittedAsset.rights.status,
      attribution: admittedAsset.rights.attribution,
    },
    byteVerification: {
      status: byteVerification.status,
      checkedAt: byteVerification.checkedAt,
      actualByteSize: byteVerification.asset.actualByteSize,
      actualSha256: byteVerification.asset.actualSha256,
      blockers: byteVerification.blockers,
    },
    mediaIntake: {
      status: "ingested-private",
      buildingId: ingested.record.buildingId,
      sourceId: ingested.record.id,
      kind: ingested.record.kind,
      mimeType: ingested.record.mimeType,
      byteSize: ingested.record.byteSize,
      sha256: ingested.record.sha256,
      usageStatus: ingested.record.usageStatus,
      licence: ingested.record.licence,
      attribution: ingested.record.attribution,
      privateRelativePath: ingested.record.relativePath,
    },
    imageQualityPreflight: {
      status: qualityOk ? "decoded-and-measured" : "blocked",
      qualityAnalysisComplete: quality.qualityAnalysisComplete,
      sourceCount: quality.sourceCount,
      width: qualitySource?.width ?? null,
      height: qualitySource?.height ?? null,
      metrics: qualitySource?.quality ?? null,
      warnings: quality.warnings,
      reconstructionCandidate: quality.reconstructionCandidate,
      safeToSubmitToColmap: quality.safeToSubmitToColmap,
      rightsApproved: quality.rightsApproved,
      limitations: quality.limitations,
    },
    claims: {
      independentReferenceTruth: false,
      heldOutCheckpoint: false,
      surveyAccuracyClaimAllowed: false,
      publicRedistributionAllowedByThisGate: false,
      derivedModelPublicationAllowedByThisGate: false,
      productionMapPublicationAllowed: false,
    },
    releaseFlags: { ...RELEASE_FLAGS },
    note: "The report contains metadata only. The source image and private ingested copy must remain in runner temporary storage and must not be uploaded as an artifact.",
  };
  return result;
}

function parseArgs(args) {
  const parsed = { workspaceRoot: null, sourceRelativePath: null, reportPath: null, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { parsed.help = true; return parsed; }
    if (["--workspace", "--source", "--report"].includes(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) fail("Missing value after " + arg + ".");
      const key = arg === "--workspace" ? "workspaceRoot" : arg === "--source" ? "sourceRelativePath" : "reportPath";
      if (parsed[key] !== null) fail("Duplicate argument: " + arg);
      parsed[key] = value;
      i += 1;
    } else {
      fail("Unknown argument: " + arg);
    }
  }
  if (!parsed.workspaceRoot || !parsed.sourceRelativePath || !parsed.reportPath) {
    fail("Required arguments: --workspace <temporary-dir> --source <relative-image-path> --report <metadata-json>.");
  }
  return parsed;
}
async function writeReport(reportPath, report) {
  const root = await realpath(process.cwd());
  const target = path.resolve(root, reportPath);
  if (!isInside(root, target) || target === root) fail("Report path must stay inside the working directory.");
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const realParent = await realpath(parent);
  if (!isInside(root, realParent)) fail("Report directory resolves outside the working directory.");
  try { await access(target); fail("Report already exists; refusing to overwrite it."); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const bytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/run-brf41-demo-image-smoke-test.mjs --workspace <temporary-dir> --source <relative-image-path> --report <metadata-json>\nDownloads nothing itself; verifies an already-downloaded BRF-13 image, ingests it privately and runs a one-image quality preflight. It is not 3D reconstruction or accuracy validation.");
    return;
  }
  const report = await runBrf41DemoImageSmokeTest(args);
  console.log(JSON.stringify({
    status: report.status,
    byteVerification: report.byteVerification.status,
    mediaIntake: report.mediaIntake.status,
    qualityPreflight: report.imageQualityPreflight.status,
    safeToSubmitToColmap: report.imageQualityPreflight.safeToSubmitToColmap,
    releaseFlags: report.releaseFlags,
  }, null, 2));
  await writeReport(args.reportPath, report);
  if (report.status !== "demo-smoke-tested-not-accuracy-validated") process.exitCode = 2;
}
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(error => {
    console.error("BRF-41 private image smoke test blocked: " + (error instanceof Error ? error.message : "unexpected error"));
    process.exitCode = 2;
  });
}
