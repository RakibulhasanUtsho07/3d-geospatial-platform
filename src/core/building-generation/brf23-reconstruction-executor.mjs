import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runColmapReconstruction } from "./colmap-worker.mjs";
import { validateBrf45ExactAssetRightsAdmission } from "./brf45-exact-asset-rights-admission.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const BASENAME = /^[A-Za-z0-9_.-]{1,160}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const EVIDENCE = Object.freeze({
  sourceManifest: "brf-14-multiview-source.json",
  byteVerificationReport: "multiview-source-byte-verification.json",
  reviewManifest: "multiview-review-manifest.json",
  overlapReport: "pairwise-overlap-report.json",
  contactSheet: "multiview-contact-sheet.png",
  cameraCoveragePlot: "camera-angle-coverage.png",
  overlapGraph: "pairwise-overlap-graph.png",
  privateMediaQualityReport: "private-multiview-media-intake-report.json",
});
const RELEASE_FLAGS = ["acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIGNATURE = Buffer.from([255, 216, 255]);

function requireValue(ok, message) {
  if (!ok) throw new TypeError(message);
}
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function within(root, file) {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
function safeBasename(value, label) {
  requireValue(typeof value === "string" && BASENAME.test(value) && value !== "." && value !== "..",
    label + " must be a simple basename.");
  return value;
}
function safeId(value, label) {
  requireValue(typeof value === "string" && SAFE_ID.test(value), label + " is invalid.");
  return value;
}
function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new TypeError(label + " is not valid UTF-8 JSON: " + error.message); }
}
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
async function realDirectory(input, label) {
  const absolute = path.resolve(input);
  const info = await lstat(absolute);
  requireValue(info.isDirectory() && !info.isSymbolicLink(), label + " must be a real directory, not a symlink.");
  return realpath(absolute);
}
async function readRegularFile(input, label, maximumBytes = 20 * 1024 * 1024) {
  const info = await lstat(input);
  requireValue(info.isFile() && !info.isSymbolicLink(), label + " must be a regular non-symlink file.");
  requireValue(info.size > 0 && info.size <= maximumBytes, label + " is empty or exceeds its size limit.");
  const resolved = await realpath(input);
  const bytes = await readFile(resolved);
  requireValue(bytes.length === info.size, label + " changed while being read.");
  return { bytes, byteSize: bytes.length, sha256: digest(bytes), path: resolved };
}
async function checkDirectoryTree(root, pieces, create = false) {
  let current = root;
  for (const part of pieces) {
    const next = path.join(current, part);
    try {
      const item = await lstat(next);
      requireValue(item.isDirectory() && !item.isSymbolicLink(), "Unsafe directory component: " + next);
    } catch (error) {
      if (!create || error?.code !== "ENOENT") throw error;
      await mkdir(next);
      const item = await lstat(next);
      requireValue(item.isDirectory() && !item.isSymbolicLink(), "Unsafe directory component: " + next);
    }
    current = await realpath(next);
    requireValue(within(root, current), "Directory resolves outside workspaceRoot: " + next);
  }
  return current;
}
function validateImageQualitySummary(quality, imageSet) {
  requireValue(quality && typeof quality === "object" && !Array.isArray(quality),
    "BRF-42 image-quality preflight summary is missing.");
  const expectedCount = imageSet.expectedCount;
  requireValue(quality.status === "all-images-decoded-and-measured" &&
    quality.qualityAnalysisComplete === true &&
    quality.sourceCount === expectedCount &&
    quality.uniqueContentCount === expectedCount &&
    quality.rightsApproved === false &&
    quality.safeToSubmitToColmap === false &&
    Array.isArray(quality.sources) && quality.sources.length === expectedCount,
    "BRF-42 quality summary must cover every unique source while withholding rights/COLMAP approval.");
  const ids = new Set();
  const hashes = new Set();
  for (const row of quality.sources) {
    requireValue(row && typeof row.sourceId === "string" && SAFE_ID.test(row.sourceId) &&
      !ids.has(row.sourceId) &&
      typeof row.sha256 === "string" && SHA256.test(row.sha256) &&
      !hashes.has(row.sha256) &&
      Number.isSafeInteger(row.byteSize) && row.byteSize > 0 &&
      Number.isSafeInteger(row.width) && row.width > 0 &&
      Number.isSafeInteger(row.height) && row.height > 0 &&
      row.usageStatus === "unreviewed" &&
      typeof row.licence === "string" && row.licence.trim().length > 0 &&
      row.quality && typeof row.quality === "object" && !Array.isArray(row.quality) &&
      row.error === null,
      "BRF-42 quality summary contains missing/duplicate view evidence, invalid dimensions, or an unexpected rights status.");
    ids.add(row.sourceId);
    hashes.add(row.sha256);
  }
  return quality;
}

function validateReport(report) {
  requireValue(report && typeof report === "object" && !Array.isArray(report),
    "BRF-23 report must be a JSON object.");
  requireValue(report.schemaVersion === "1.0.0" && report.recordType === "brf-23-reconstruction-preflight-report",
    "Unsupported BRF-23 report schema/type.");
  requireValue(report.status === "preflight-ready-for-local-reconstruction-attempt",
    "BRF-23 preflight is blocked; reconstruction must not start.");
  requireValue(Array.isArray(report.blockers) && report.blockers.length === 0, "BRF-23 report contains blockers.");
  requireValue(report.reconstructionExecuted === false && report.candidateGlbGenerated === false &&
    report.independentReferenceVerified === false, "BRF-23 must describe a pre-execution state.");
  for (const flag of RELEASE_FLAGS) requireValue(report[flag] === false, "BRF-23 must keep " + flag + " false.");

  const inputs = report.assessedInputs;
  requireValue(inputs && typeof inputs === "object", "BRF-23 assessedInputs is missing.");
  const bindings = inputs.evidenceBindings;
  requireValue(bindings && typeof bindings === "object" && !Array.isArray(bindings), "Evidence bindings are missing.");
  for (const [role, filename] of Object.entries(EVIDENCE)) {
    const item = bindings[role];
    requireValue(item && item.filename === filename && Number.isSafeInteger(item.byteSize) && item.byteSize > 0 &&
      typeof item.sha256 === "string" && SHA256.test(item.sha256), "Invalid evidence binding: " + role);
  }
  requireValue(Object.keys(bindings).length === Object.keys(EVIDENCE).length,
    "Report must bind exactly the eight BRF-14/20/21/42 artifacts.");

  const decision = inputs.humanDecision;
  requireValue(decision && decision.validationStatus === "valid" &&
    decision.overallDisposition === "continue-to-reconstruction-preflight", "A completed continue decision is required.");
  safeBasename(decision.filename, "Decision filename");
  requireValue(Number.isSafeInteger(decision.byteSize) && decision.byteSize > 0 &&
    typeof decision.sha256 === "string" && SHA256.test(decision.sha256), "Invalid decision hash binding.");
  requireValue(decision.reviewer && typeof decision.reviewer.name === "string" &&
    decision.reviewer.name.trim().length >= 2 && typeof decision.reviewer.identifier === "string" &&
    decision.reviewer.identifier.trim().length >= 3, "Recorded reviewer identity fields are missing.");
  requireValue(typeof decision.reviewedAtUtc === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(decision.reviewedAtUtc) &&
    Number.isFinite(Date.parse(decision.reviewedAtUtc)), "A valid UTC review timestamp is required.");

  requireValue(report.humanReview && report.humanReview.sameBuildingIdentity === "confirmed" &&
    report.humanReview.coverageAssessment === "adequate" && report.humanReview.sourceUpAxis === "confirmed" &&
    report.humanReview.assetRights === "approved-for-this-use", "Required human-review dispositions are not approved.");
  requireValue(report.reviewCounts && report.reviewCounts.includedViews >= 3 &&
    report.reviewCounts.humanConfirmedUsefulOverlapPairs >= 2, "At least three included views and two reviewed overlap pairs are required.");

  const imageSet = inputs.sourceImages;
  requireValue(imageSet && Number.isSafeInteger(imageSet.expectedCount) && imageSet.expectedCount >= 3 &&
    imageSet.expectedCount <= 32 && imageSet.verifiedCount === imageSet.expectedCount &&
    Array.isArray(imageSet.records) && imageSet.records.length === imageSet.expectedCount,
    "All bounded source images must be byte-verified.");
  const filenames = new Set();
  const hashes = new Set();
  for (const image of imageSet.records) {
    requireValue(image && image.status === "verified" && typeof image.filename === "string" &&
      BASENAME.test(image.filename) && image.filename !== "." && image.filename !== ".." &&
      Number.isSafeInteger(image.byteSize) && image.byteSize > 0 &&
      typeof image.sha256 === "string" && SHA256.test(image.sha256), "Malformed source-image hash record.");
    requireValue(!filenames.has(image.filename), "Duplicate source filename in preflight report.");
    requireValue(!hashes.has(image.sha256), "Duplicate source image content is not allowed.");
    filenames.add(image.filename); hashes.add(image.sha256);
  }
  const imageQualityPreflight = validateImageQualitySummary(inputs.imageQualityPreflight, imageSet);
  const rightsAdmission = inputs.rightsAdmission;
  requireValue(rightsAdmission && rightsAdmission.filename === "brf-45-exact-asset-rights-admission.json" &&
    Number.isSafeInteger(rightsAdmission.byteSize) && rightsAdmission.byteSize > 0 &&
    typeof rightsAdmission.sha256 === "string" && SHA256.test(rightsAdmission.sha256) &&
    rightsAdmission.evaluationId === "BRF-45-EXACT-ASSET-RIGHTS-ADMISSION" &&
    rightsAdmission.assetCount === imageSet.expectedCount &&
    Number.isSafeInteger(rightsAdmission.pendingDecisionCount) &&
    rightsAdmission.pendingDecisionCount >= 0 && rightsAdmission.pendingDecisionCount <= rightsAdmission.assetCount,
    "BRF-45 exact-asset rights admission must be separately hash-bound to the preflight.");
  const profile = inputs.profile;
  requireValue(profile && typeof profile.filename === "string" && BASENAME.test(profile.filename) &&
    Number.isSafeInteger(profile.byteSize) && profile.byteSize > 0 &&
    typeof profile.sha256 === "string" && SHA256.test(profile.sha256), "Invalid COLMAP profile binding.");

  const tool = report.toolchain;
  requireValue(tool && tool.status === "verified" &&
    typeof tool.executable === "string" && tool.executable.trim() &&
    typeof tool.expectedVersion === "string" && tool.expectedVersion === tool.actualVersion &&
    typeof tool.resolvedExecutable === "string" && path.isAbsolute(tool.resolvedExecutable),
    "The exact pinned COLMAP toolchain is not verified.");
  const frame = report.coordinateFrame;
  requireValue(frame && frame.policy === "local-only-no-georeference" &&
    typeof frame.frameId === "string" && frame.frameId.trim().length >= 5 &&
    frame.units === "unscaled-local" && frame.registrationToGps === "not-established",
    "Only the explicit unscaled local-only frame is accepted.");
  requireValue(["X", "Y", "Z"].includes(frame.reviewedSourceUpAxis) &&
    frame.reviewedSourceUpAxisPositiveDirection === "positive",
    "The exporter supports only a reviewer-confirmed positive X/Y/Z up-axis.");
  return { inputs, bindings, decision, imageSet, imageQualityPreflight, rightsAdmission, profile, profileId: report.profileId, tool, frame };
}

async function verifyEvidence(artifactRoot, bindings, validated) {
  const files = {};
  for (const [role, binding] of Object.entries(bindings)) {
    const file = await readRegularFile(path.join(artifactRoot, safeBasename(binding.filename, "Evidence filename")),
      "Evidence " + role, 100 * 1024 * 1024);
    requireValue(file.sha256 === binding.sha256 && file.byteSize === binding.byteSize,
      "Evidence changed after BRF-23 preflight: " + role);
    if (binding.filename.endsWith(".png")) {
      requireValue(file.bytes.subarray(0, 8).equals(PNG_SIGNATURE), "Evidence PNG signature invalid: " + role);
    }
    files[role] = file;
  }

  const sourceManifest = parseJson(files.sourceManifest.bytes, "BRF-14 source manifest");
  const byteReport = parseJson(files.byteVerificationReport.bytes, "BRF-14 byte-verification report");
  const qualityReport = parseJson(files.privateMediaQualityReport.bytes, "BRF-42 private multi-view quality report");
  const rightsAdmissionFile = await readRegularFile(
    path.join(artifactRoot, safeBasename(validated.rightsAdmission.filename, "BRF-45 rights-admission filename")),
    "BRF-45 rights-admission register", 20 * 1024 * 1024);
  requireValue(rightsAdmissionFile.byteSize === validated.rightsAdmission.byteSize &&
    rightsAdmissionFile.sha256 === validated.rightsAdmission.sha256,
    "BRF-45 rights-admission register changed after BRF-23 preflight.");
  const rightsAdmission = parseJson(rightsAdmissionFile.bytes, "BRF-45 exact-asset rights admission");
  requireValue(rightsAdmission?.schemaVersion === "1.0.0" &&
    rightsAdmission?.recordType === "brf-45-exact-asset-rights-admission" &&
    rightsAdmission?.evaluationId === validated.rightsAdmission.evaluationId &&
    Array.isArray(rightsAdmission.assets) &&
    rightsAdmission.assets.length === validated.rightsAdmission.assetCount &&
    rightsAdmission.assets.filter(row => row?.decision !== "approved").length === validated.rightsAdmission.pendingDecisionCount,
    "BRF-45 register identity/count/pending-decision summary differs from the preflight-bound metadata.");
  requireValue(sourceManifest?.schemaVersion === "1.0.0" &&
    sourceManifest?.evaluationStage === "multiview-source-byte-intake-only" &&
    Array.isArray(sourceManifest.views) && sourceManifest.views.length === validated.imageSet.expectedCount &&
    sourceManifest?.dataset && typeof sourceManifest.dataset.sourceRepositoryCommit === "string",
    "BRF-42 source manifest is missing or does not match the pinned BRF-14 evidence contract.");
  requireValue(byteReport?.schemaVersion === "1.0.0" &&
    byteReport?.status === "views-byte-verified" &&
    byteReport.sampleId === sourceManifest.sampleId &&
    byteReport?.dataset?.sourceRepositoryCommit === sourceManifest.dataset.sourceRepositoryCommit &&
    Array.isArray(byteReport.views) && byteReport.views.length === sourceManifest.views.length &&
    Array.isArray(byteReport.blockers) && byteReport.blockers.length === 0,
    "BRF-42 byte-verification report is absent, blocked, or bound to another source set.");

  const dataset = sourceManifest.dataset;
  const sourceBinding = qualityReport?.sourceManifest;
  requireValue(qualityReport?.schemaVersion === "1.0.0" &&
    qualityReport?.evaluationId === "BRF-42-PRIVATE-MULTIVIEW-INTAKE" &&
    qualityReport?.status === "private-multiview-preflight-complete-not-reconstruction-approved" &&
    sourceBinding && sourceBinding.sourceCommit === dataset.sourceRepositoryCommit &&
    sourceBinding.declaredLicense === dataset.license &&
    sourceBinding.licenseScope === dataset.licenseScope &&
    sourceBinding.rightsStatus === dataset.rightsStatus &&
    sourceBinding.attribution === dataset.attribution &&
    sourceBinding.manifestSha256 === files.sourceManifest.sha256 &&
    sourceBinding.priorVerificationReportSha256 === files.byteVerificationReport.sha256 &&
    typeof sourceBinding.freshVerificationReportSha256 === "string" &&
    SHA256.test(sourceBinding.freshVerificationReportSha256),
    "BRF-42 quality report does not bind the exact BRF-14 manifest and byte-verification report.");
  
  const manifestById = new Map();
  const imageByFilename = new Map(validated.imageSet.records.map(row => [row.filename, row]));
  let expectedTotalBytes = 0;
  for (const view of sourceManifest.views) {
    requireValue(view && typeof view.id === "string" && SAFE_ID.test(view.id) &&
      !manifestById.has(view.id) &&
      typeof view.filename === "string" && BASENAME.test(view.filename) &&
      typeof view.expectedSha256 === "string" && SHA256.test(view.expectedSha256) &&
      Number.isSafeInteger(view.expectedByteSize) && view.expectedByteSize > 0,
      "BRF-14 source manifest contains an invalid or duplicate view binding.");
    const pinnedImage = imageByFilename.get(view.filename);
    requireValue(pinnedImage && pinnedImage.sha256 === view.expectedSha256 &&
      pinnedImage.byteSize === view.expectedByteSize,
      "BRF-14 source view does not match the exact image hash/size bound into BRF-23: " + view.id);
    manifestById.set(view.id, view);
    expectedTotalBytes += view.expectedByteSize;
  }
  requireValue(sourceManifest.selectionMethod?.expectedViewCount === sourceManifest.views.length &&
    sourceManifest.expectedTotalBytes === expectedTotalBytes &&
    byteReport.selectedViewCount === sourceManifest.views.length &&
    byteReport.declaredTotalBytes === expectedTotalBytes &&
    byteReport.actualTotalBytes === expectedTotalBytes,
    "BRF-14 source and byte-verification view counts or byte totals do not reconcile.");

  const byteById = new Map();
  for (const row of byteReport.views) {
    requireValue(row && typeof row.id === "string" && !byteById.has(row.id),
      "BRF-14 byte-verification report has a missing or duplicate view ID.");
    byteById.set(row.id, row);
  }
  requireValue(byteById.size === manifestById.size, "BRF-14 manifest and byte-verification report have different view IDs.");
  for (const [id, view] of manifestById) {
    const row = byteById.get(id);
    requireValue(row && row.status === "passed" &&
      row.filename === view.filename &&
      row.expectedSha256 === view.expectedSha256 &&
      row.actualSha256 === view.expectedSha256 &&
      row.expectedByteSize === view.expectedByteSize &&
      row.actualByteSize === view.expectedByteSize,
      "BRF-14 byte-verification does not prove the exact pinned bytes for view " + id + ".");
  }

  const byteSummary = qualityReport.byteVerification;
  requireValue(byteSummary && byteSummary.status === "views-byte-verified" &&
    byteSummary.selectedViewCount === manifestById.size &&
    byteSummary.verifiedViewCount === manifestById.size &&
    byteSummary.declaredTotalBytes === expectedTotalBytes &&
    byteSummary.actualTotalBytes === expectedTotalBytes &&
    Array.isArray(byteSummary.blockers) && byteSummary.blockers.length === 0,
    "BRF-42 report does not confirm complete exact-byte verification for every view.");

  const intake = qualityReport.privateMediaIntake;
  requireValue(intake && intake.status === "all-views-ingested-private" &&
    Number.isSafeInteger(intake.selectedViewCount) && intake.selectedViewCount === manifestById.size &&
    intake.ingestedCount === manifestById.size &&
    Array.isArray(intake.records) && intake.records.length === manifestById.size,
    "BRF-42 private intake is incomplete or contains an unexpected source count.");
  const privateById = new Map();
  for (const row of intake.records) {
    requireValue(row && typeof row.sourceId === "string" && !privateById.has(row.sourceId),
      "BRF-42 private intake contains a missing or duplicate source ID.");
    privateById.set(row.sourceId, row);
  }
  requireValue(privateById.size === manifestById.size, "BRF-42 private intake has missing or unknown view IDs.");

  const quality = validateImageQualitySummary(qualityReport.imageQualityPreflight, validated.imageSet);
  requireValue(canonical(quality) === canonical(validated.imageQualityPreflight),
    "BRF-23 image-quality summary differs from the exact hash-bound BRF-42 report.");
  for (const [id, view] of manifestById) {
    const intakeRow = privateById.get(id);
    const qualityRow = quality.sources.find(row => row.sourceId === id);
    requireValue(intakeRow &&
      intakeRow.sha256 === view.expectedSha256 && intakeRow.byteSize === view.expectedByteSize &&
      intakeRow.usageStatus === "unreviewed" &&
      typeof intakeRow.licence === "string" && intakeRow.licence.trim() &&
      intakeRow.sourceUrl === view.sourceUrl &&
      qualityRow && qualityRow.sha256 === view.expectedSha256 &&
      qualityRow.byteSize === view.expectedByteSize &&
      qualityRow.usageStatus === "unreviewed" &&
      (!Number.isSafeInteger(view.declaredWidth) || qualityRow.width === view.declaredWidth) &&
      (!Number.isSafeInteger(view.declaredHeight) || qualityRow.height === view.declaredHeight),
      "BRF-42 per-view media/quality record differs from the pinned BRF-14 source: " + id);
    if (typeof view.capturedAt === "string") {
      requireValue(intakeRow.capturedAt === view.capturedAt,
        "BRF-42 capture timestamp differs from the source manifest for view " + id);
    }
    if (view.gps && typeof view.gps === "object") {
      requireValue(intakeRow.location?.latitude === view.gps.latitude &&
        intakeRow.location?.longitude === view.gps.longitude,
        "BRF-42 source location differs from the source manifest for view " + id);
    }
  }

  const review = qualityReport.reviewAndRelease;
  const flags = qualityReport.releaseFlags;
  requireValue(review && review.rightsReview === "pending-human-review" &&
    review.sameBuildingIdentity === "source-declared-not-independently-confirmed" &&
    review.visualOverlap === "pending-human-review" &&
    review.facadeRoofCoverage === "pending-human-review" &&
    review.sourceUpAxis === "pending-human-review" &&
    review.independentReferenceVerified === false &&
    review.candidateGlbGenerated === false &&
    review.reconstructionExecuted === false &&
    review.realWorldAccuracyValidated === false &&
    flags && RELEASE_FLAGS.every(flag => flags[flag] === false) &&
    RELEASE_FLAGS.every(flag => sourceManifest[flag] === false),
    "BRF-42 report must keep rights/identity/reconstruction pending and every release flag false.");
  const rightsAdmissionReport = await validateBrf45ExactAssetRightsAdmission(rightsAdmission, {
    sourceManifest,
    evidenceRoot: artifactRoot,
    sourceManifestSha256: files.sourceManifest.sha256,
  });
  return { sourceManifest, qualityReport, rightsAdmission, rightsAdmissionReport };
}
async function verifyDecisionAndProfile(artifactRoot, profilePath, validated) {
  const reportDecision = validated.decision;
  const decisionFile = await readRegularFile(path.join(artifactRoot, reportDecision.filename), "Human-review decision");
  requireValue(decisionFile.sha256 === reportDecision.sha256 && decisionFile.byteSize === reportDecision.byteSize,
    "Human-review decision changed after preflight.");
  const decision = parseJson(decisionFile.bytes, "Human-review decision");
  requireValue(decision.schemaVersion === "1.0.0" && decision.recordType === "brf-21-human-review-decision" &&
    decision.overallDisposition === "continue-to-reconstruction-preflight", "Invalid BRF-21 decision record.");
  requireValue(canonical(decision.evidenceBindings) === canonical(validated.bindings),
    "Human decision binds different evidence than the preflight.");
  requireValue(decision.reviewer?.name === reportDecision.reviewer.name &&
    decision.reviewer?.identifier === reportDecision.reviewer.identifier &&
    decision.reviewedAtUtc === reportDecision.reviewedAtUtc, "Reviewer metadata changed after preflight.");
  requireValue(decision.sameBuildingIdentity?.decision === "confirmed" &&
    decision.coverageAssessment?.decision === "adequate" &&
    decision.sourceUpAxis?.decision === "confirmed" &&
    decision.sourceUpAxis?.axis === validated.frame.reviewedSourceUpAxis &&
    decision.sourceUpAxis?.positiveDirection === validated.frame.reviewedSourceUpAxisPositiveDirection &&
    decision.assetRights?.decision === "approved-for-this-use", "Decision fields do not satisfy execution gates.");

  const profilePathResolved = path.resolve(profilePath);
  const profileFile = await readRegularFile(profilePathResolved, "COLMAP profile");
  requireValue(path.basename(profilePathResolved) === validated.profile.filename &&
    profileFile.sha256 === validated.profile.sha256 && profileFile.byteSize === validated.profile.byteSize,
    "COLMAP profile changed after preflight.");
  const profile = parseJson(profileFile.bytes, "COLMAP profile");
  requireValue(profile.schemaVersion === "1.0.0" && profile.profileId === validated.profileId &&
    profile.toolchain?.name === "COLMAP" && profile.toolchain?.executable === validated.tool.executable &&
    profile.toolchain?.expectedVersion === validated.tool.expectedVersion &&
    profile.coordinateFrame?.policy === "local-only-no-georeference" &&
    profile.coordinateFrame?.frameId === validated.frame.frameId &&
    profile.coordinateFrame?.units === "unscaled-local" &&
    profile.coordinateFrame?.registrationToGps === "not-established" &&
    profile.execution?.preflightOnly === true && profile.execution?.runReconstruction === false &&
    profile.execution?.generateCandidateGlb === false, "Profile no longer matches BRF-23's local-only contract.");
  return { decision, profile };
}
async function verifyRawImages(imageRoot, imageSet) {
  for (const image of imageSet.records) {
    const file = await readRegularFile(path.join(imageRoot, safeBasename(image.filename, "Source image filename")),
      "Pinned source image " + image.filename, 100 * 1024 * 1024);
    requireValue(file.byteSize === image.byteSize && file.sha256 === image.sha256 &&
      file.bytes.subarray(0, 3).equals(JPEG_SIGNATURE), "Source image bytes changed after preflight: " + image.filename);
  }
}
async function verifySelectedMedia(workspaceRoot, buildingId, sourceIds, buildingSpec, imageSet) {
  safeId(buildingId, "buildingId");
  requireValue(Array.isArray(sourceIds) && sourceIds.length >= 3 && sourceIds.length <= 120 &&
    new Set(sourceIds).size === sourceIds.length, "Select 3–120 distinct reviewed media source IDs.");
  const mediaRoot = await checkDirectoryTree(workspaceRoot, [".building-engine", "media", buildingId]);
  const sourceRoot = await checkDirectoryTree(workspaceRoot, [".building-engine", "media", buildingId, "sources"]);
  const assetRoot = await checkDirectoryTree(workspaceRoot, [".building-engine", "media", buildingId, "assets"]);
  const approvedByHash = new Map(imageSet.records.map(row => [row.sha256, row]));
  const specSources = new Map((buildingSpec?.sources || []).map(row => [row.id, row]));
  const selected = [];
  const seenHashes = new Set();
  for (const sourceIdValue of sourceIds) {
    const sourceId = safeId(sourceIdValue, "sourceId");
    const meta = await readRegularFile(path.join(sourceRoot, sourceId + ".json"), "Source metadata " + sourceId);
    const record = parseJson(meta.bytes, "Source metadata " + sourceId);
    requireValue(record.id === sourceId && record.buildingId === buildingId &&
      record.kind === "image" && ["image/jpeg", "image/png"].includes(record.mimeType),
      "Invalid selected source identity or media type: " + sourceId);
    requireValue(record.usageStatus === "approved" && typeof record.licence === "string" &&
      record.licence.trim() && record.licence.toLowerCase() !== "unknown",
      "Selected source lacks reviewed rights: " + sourceId);
    requireValue(typeof record.sha256 === "string" && SHA256.test(record.sha256) && record.assetId === record.sha256,
      "Source asset is not content-hash addressed: " + sourceId);
    const pinned = approvedByHash.get(record.sha256);
    requireValue(pinned, "Selected source is not in the BRF-23 verified image set: " + sourceId);
    requireValue(!seenHashes.has(record.sha256), "Duplicate selected media bytes detected.");
    seenHashes.add(record.sha256);
    requireValue(typeof record.relativePath === "string" && !record.relativePath.includes("\\") &&
      !path.isAbsolute(record.relativePath), "Unsafe media asset relativePath: " + sourceId);
    const assetPath = path.resolve(workspaceRoot, record.relativePath);
    requireValue(within(workspaceRoot, assetPath) && within(assetRoot, assetPath),
      "Selected asset path escapes its building asset store.");
    const assetFile = await readRegularFile(assetPath, "Selected asset " + sourceId, 100 * 1024 * 1024);
    requireValue(within(workspaceRoot, assetFile.path) && within(assetRoot, assetFile.path),
      "Resolved selected asset escapes its building asset store.");
    requireValue(assetFile.sha256 === record.sha256 && assetFile.byteSize === pinned.byteSize,
      "Selected asset bytes differ from pinned BRF-23 source image: " + sourceId);
    const isPng = record.mimeType === "image/png";
    requireValue((isPng && assetFile.bytes.subarray(0, 8).equals(PNG_SIGNATURE)) ||
      (!isPng && assetFile.bytes.subarray(0, 3).equals(JPEG_SIGNATURE)),
      "Selected asset file signature does not match its media type: " + sourceId);
    const spec = specSources.get(sourceId);
    requireValue(spec && spec.assetId === record.assetId && spec.usageStatus === "approved" &&
      spec.licence === record.licence, "BuildingSpec must bind the exact approved media metadata: " + sourceId);
    selected.push({ id: sourceId, filename: pinned.filename, sha256: record.sha256,
      byteSize: assetFile.byteSize, licence: record.licence, usageStatus: record.usageStatus });
  }
  requireValue(selected.length >= 3 && within(workspaceRoot, mediaRoot),
    "Insufficient or unsafe selected media.");
  return selected;
}
function runCommand(executable, args, timeoutMs, spawnImpl = nodeSpawn) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false }); }
    catch (error) { reject(error); return; }
    let stdout = "", stderr = "", settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    child.stdout?.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-8000); });
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(reject, new Error(executable + " command timed out.")); }, timeoutMs);
    child.once("error", error => finish(reject, new Error("Could not start " + executable + ": " + error.message)));
    child.once("close", (code, signal) => code === 0 ? finish(resolve, { stdout, stderr }) :
      finish(reject, new Error(executable + " exited " + code + (signal ? " (" + signal + ")" : "") + ": " + (stderr.trim() || stdout.trim()))));
  });
}
async function runPreflightAgain({ artifactRoot, imageRoot, decisionName, profilePath, outputPath, pythonPath, spawnImpl }) {
  const cli = fileURLToPath(new URL("../../../scripts/brf23_reconstruction_preflight.py", import.meta.url));
  await runCommand(pythonPath, [cli, "assess", "--artifact-root", artifactRoot, "--image-root", imageRoot,
    "--decision", decisionName, "--profile", path.resolve(profilePath), "--output", path.basename(outputPath)], 60000, spawnImpl);
}
async function probeVersion(executable, spawnImpl) {
  const output = await runCommand(executable, ["version"], 10000, spawnImpl);
  const match = (output.stdout + "\n" + output.stderr).match(/(?<![A-Za-z0-9.])(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?![A-Za-z0-9.])/);
  return match ? match[1] : null;
}

export function validateBrf23ExecutionReport(report) {
  return validateReport(report);
}

/** Revalidate hash-pinned BRF-23 evidence before routing reviewed media to the existing COLMAP worker. */
export async function runBrf23AuthorizedColmapReconstruction(options) {
  requireValue(options && typeof options === "object", "Execution options are required.");
  requireValue(options.confirmExecution === true, "Explicit operator confirmation is required to run reconstruction.");
  requireValue(options.scaleCalibration === undefined, "BRF-23 local-only input cannot assert independent metric scale.");
  const workspaceRoot = await realDirectory(options.workspaceRoot, "workspaceRoot");
  const artifactRoot = await realDirectory(options.artifactRoot, "artifactRoot");
  const imageRoot = await realDirectory(options.imageRoot, "imageRoot");
  const buildingId = safeId(options.buildingId, "buildingId");
  const jobId = safeId(options.jobId, "jobId");
  const decisionName = safeBasename(options.decisionName, "Decision filename");
  const reportName = safeBasename(options.preflightReportName, "Preflight report filename");
  requireValue(typeof options.expectedPreflightReportSha256 === "string" &&
    SHA256.test(options.expectedPreflightReportSha256), "Pin the preflight report's SHA-256 explicitly.");

  const reportFile = await readRegularFile(path.join(artifactRoot, reportName), "BRF-23 report");
  requireValue(reportFile.sha256 === options.expectedPreflightReportSha256,
    "BRF-23 report SHA-256 differs from the explicitly pinned value.");
  const report = parseJson(reportFile.bytes, "BRF-23 report");
  const validated = validateReport(report);
  const verifiedEvidence = await verifyEvidence(artifactRoot, validated.bindings, validated);
  requireValue(decisionName === validated.decision.filename, "Decision name differs from BRF-23's exact binding.");
  await verifyDecisionAndProfile(artifactRoot, options.profilePath, validated);
  await verifyRawImages(imageRoot, validated.imageSet);

  const recheckName = "brf24-preflight-revalidated-" + jobId + ".json";
  const recheckPath = path.join(artifactRoot, recheckName);
  try { await lstat(recheckPath); throw new TypeError("BRF-24 revalidation output already exists; choose a new job ID."); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const pythonPath = options.pythonPath || process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
  await (options.preflightRunner || runPreflightAgain)({
    artifactRoot, imageRoot, decisionName, profilePath: options.profilePath, outputPath: recheckPath,
    pythonPath, spawnImpl: options.preflightSpawnImpl || nodeSpawn,
  });
  const freshFile = await readRegularFile(recheckPath, "Revalidated BRF-23 report");
  requireValue(freshFile.sha256 === reportFile.sha256,
    "Fresh BRF-23 report differs from pinned report; evidence, decision, profile, or inputs changed.");
  validateReport(parseJson(freshFile.bytes, "Revalidated BRF-23 report"));

  const selected = await verifySelectedMedia(workspaceRoot, buildingId, options.sourceIds,
    options.buildingSpec, validated.imageSet);

  // BRF-42 remains an immutable history of the original unreviewed intake.
  // Only the separately hash-bound BRF-45 per-asset grant evidence can satisfy the
  // source-use gate; human-review continuation or mutable media metadata cannot.
  const rightsAdmissionReport = verifiedEvidence.rightsAdmissionReport;
  requireValue(rightsAdmissionReport.status === "rights-admission-complete-human-review-required",
    "BRF-45 exact-asset rights admission is blocked: " +
    rightsAdmissionReport.blockers.slice(0, 12).join(", ") +
    ". The COLMAP worker was not started; acquire and review exact-source rights evidence first.");

  const version = await (options.colmapVersionProbe || probeVersion)(
    validated.tool.resolvedExecutable, options.colmapSpawnImpl || nodeSpawn);
  requireValue(version === validated.tool.expectedVersion,
    "COLMAP version changed after preflight; expected " + validated.tool.expectedVersion + ", got " + String(version) + ".");

  const authorization = {
    schemaVersion: "1.0.0",
    recordType: "brf-24-colmap-execution-authorization",
    status: "authorized-for-local-reconstruction-attempt",
    authorizedAtUtc: new Date().toISOString(),
    preflightReport: { filename: reportName, sha256: reportFile.sha256 },
    humanDecision: { filename: decisionName, sha256: validated.decision.sha256,
      reviewer: validated.decision.reviewer, reviewedAtUtc: validated.decision.reviewedAtUtc,
      overallDisposition: validated.decision.overallDisposition, humanReview: report.humanReview },
    profile: { profileId: report.profileId, sha256: validated.profile.sha256 },
    toolchain: { name: "COLMAP", version, resolvedExecutable: validated.tool.resolvedExecutable,
      versionRecheckedImmediatelyBeforeRun: true },
    selectedSourceImages: selected,
    coordinateFrame: { policy: validated.frame.policy, frameId: validated.frame.frameId,
      units: validated.frame.units, registrationToGps: validated.frame.registrationToGps,
      sourceUpAxis: validated.frame.reviewedSourceUpAxis,
      sourceUpAxisPositiveDirection: validated.frame.reviewedSourceUpAxisPositiveDirection },
    scaleCalibration: { status: "not-calibrated", reason: "Local frame and source scale metadata are not independent survey truth." },
    candidateGlbGenerated: false,
    candidateGeometryValidated: false,
    independentReferenceVerified: false,
    heldOutCheckpointAccuracyVerified: false,
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
    limitations: [
      "This authorizes only a review-only local-frame reconstruction attempt.",
      "Reviewer identity and rights statements are bound to their input record but not independently authenticated.",
      "Independent reference geometry and held-out survey checkpoints remain BRF-10 acceptance requirements.",
    ],
  };
  const authDir = await checkDirectoryTree(workspaceRoot, [".building-engine", "authorizations", buildingId], true);
  const authPath = path.join(authDir, jobId + ".json");
  await writeFile(authPath, JSON.stringify(authorization, null, 2) + "\n", { flag: "wx", mode: 0o600 });

  try {
    const result = await (options.workerImpl || runColmapReconstruction)({
      workspaceRoot, buildingSpec: options.buildingSpec, buildingId, jobId, sourceIds: options.sourceIds,
      matchConfirmed: true, overlapReviewed: true, upAxisReviewed: true,
      upAxis: validated.frame.reviewedSourceUpAxis, colmapPath: validated.tool.resolvedExecutable,
      quality: options.quality || "MEDIUM", timeoutMs: options.timeoutMs || 3600000,
      headingDegrees: options.headingDegrees === undefined ? 0 : options.headingDegrees,
      scaleCalibration: {}, ffmpegPath: options.ffmpegPath,
    });
    const glb = result.report?.outputs?.glb;
    const candidateHash = glb?.sha256;
    if (candidateHash && SHA256.test(candidateHash)) {
      authorization.status = "candidate-generated-requires-review";
      authorization.candidateGlbGenerated = true;
      authorization.candidateGlb = { sha256: candidateHash, relativePath: glb.relativePath, byteSize: glb.bytes };
    } else {
      authorization.status = "worker-finished-without-candidate";
      authorization.candidateGlbGenerated = false;
    }
    await writeFile(authPath, JSON.stringify(authorization, null, 2) + "\n");
    Object.assign(result.report, {
      reconstructionAuthorization: authorization,
      candidateGlbGenerated: authorization.candidateGlbGenerated,
      candidateGeometryValidated: false,
      independentReferenceVerified: false,
      heldOutCheckpointAccuracyVerified: false,
      acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false,
    });
    await writeFile(result.reportPath, JSON.stringify(result.report, null, 2) + "\n");
    return { ...result, authorizationPath: authPath, authorization };
  } catch (error) {
    authorization.status = "attempt-failed";
    authorization.failureMessage = error instanceof Error ? error.message : String(error);
    await writeFile(authPath, JSON.stringify(authorization, null, 2) + "\n").catch(() => {});
    throw error;
  }
}
