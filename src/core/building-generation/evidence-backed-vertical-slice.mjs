import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { runMediaToModelWorkflow } from "./media-to-model-workflow.mjs";
import { runArchitecturalGeometryWorkflow } from "./architectural-geometry-workflow.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const REQUIRED_SCOPES = Object.freeze([
  "private-media-ingestion",
  "photogrammetry-reconstruction",
  "texture-baking",
]);
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const MAX_GEOMETRY_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function safeId(value, label, max = 60) {
  if (typeof value !== "string" || value.length > max || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier of at most " + max + " characters");
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\\")) {
    throw new TypeError(label + " must be a non-empty workspace-relative POSIX path");
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new TypeError(label + " must not be absolute");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new TypeError(label + " contains an unsafe path segment");
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readWorkspaceFile(root, relativePath, label, maxBytes) {
  const safePath = safeRelativePath(relativePath, label);
  const candidate = path.resolve(root, ...safePath.split("/"));
  if (!inside(root, candidate)) throw new TypeError(label + " escapes workspaceRoot");
  const entry = await lstat(candidate);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError(label + " must be a regular, non-symlink file");
  }
  if (entry.size <= 0 || entry.size > maxBytes) {
    throw new RangeError(label + " must be non-empty and no larger than " + maxBytes + " bytes");
  }
  const realPath = await realpath(candidate);
  if (!inside(root, realPath)) throw new TypeError(label + " resolves outside workspaceRoot");
  const bytes = await readFile(realPath);
  return {
    absolutePath: realPath,
    relativePath: path.relative(root, realPath).split(path.sep).join("/"),
    bytes,
    sha256: sha256(bytes),
  };
}

async function ensureDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    try {
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("vertical-slice output path contains a symlink or non-directory");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (createError) {
        if (createError?.code !== "EEXIST") throw createError;
      }
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("unsafe vertical-slice output directory");
      }
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("vertical-slice output resolves outside workspaceRoot");
  }
  return current;
}

async function atomicJson(filePath, value) {
  const temporary = filePath + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function assertGlb(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 ||
      bytes.readUInt32LE(0) !== GLB_MAGIC ||
      bytes.readUInt32LE(4) !== GLB_VERSION ||
      bytes.readUInt32LE(8) !== bytes.length) {
    throw new TypeError(label + " must be a complete GLB 2.0 binary");
  }
}

function requireAttestations(media, geometry) {
  if (media.confirmRights !== true) {
    throw new TypeError("media.confirmRights must be true after reviewing every source licence and usage scope");
  }
  if (media.confirmSameBuilding !== true ||
      media.confirmOverlapReviewed !== true ||
      media.confirmUpAxisReviewed !== true ||
      !["X", "Y", "Z"].includes(media.upAxis)) {
    throw new TypeError("multi-view intake requires same-building, overlap and source-axis attestations");
  }
  for (const [field, description] of [
    ["confirmCameraCalibrationReviewed", "camera calibration"],
    ["confirmCorrespondencesReviewed", "cross-view correspondences"],
    ["confirmFaceDefinitionsReviewed", "explicit mesh faces"],
    ["confirmTextureEvidenceReviewed", "texture source rights/projection evidence"],
  ]) {
    if (geometry[field] !== true) {
      throw new TypeError("geometry." + field + " must be true after reviewing " + description);
    }
  }
}

async function prepareEvidence({ root, media, geometry }) {
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    throw new TypeError("media options are required");
  }
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) {
    throw new TypeError("geometry options are required");
  }
  requireAttestations(media, geometry);
  if (!media.buildingSpec || typeof media.buildingSpec !== "object" ||
      media.buildingSpec.id !== buildingId) {
    throw new TypeError("media BuildingSpec.id must exactly match the parent buildingId");
  }

  if (!Array.isArray(media.sources) || media.sources.length < 3 || media.sources.length > 100) {
    throw new RangeError("the vertical slice requires 3–100 rights-cleared multi-view image sources");
  }
  const inputFile = await readWorkspaceFile(
    root,
    geometry.inputPath,
    "geometry input",
    MAX_GEOMETRY_INPUT_BYTES,
  );
  let input;
  try {
    input = JSON.parse(inputFile.bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError("geometry input must be valid JSON: " + error.message);
  }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !Array.isArray(input.cameras) || !Array.isArray(input.features) ||
      !Array.isArray(input.edges) || !Array.isArray(input.faces) ||
      !input.textureCandidate || !Array.isArray(input.textureCandidate.images)) {
    throw new TypeError("geometry input needs cameras, features, edges, faces and textureCandidate.images");
  }
  if (input.textureCandidate.images.length !== media.sources.length) {
    throw new TypeError("geometry texture images must match the media source set exactly");
  }

  const sourceById = new Map();
  for (const [index, source] of media.sources.entries()) {
    if (!source || typeof source !== "object") throw new TypeError("media.sources[" + index + "] must be an object");
    const sourceId = safeId(source.sourceId, "media source ID");
    if (sourceById.has(sourceId)) throw new TypeError("media source IDs must be unique");
    if (source.kind !== undefined && source.kind !== "image") {
      throw new TypeError("D3M-ENGINE-03 v1 accepts still images only; video-frame sources require a separate reviewed intake");
    }
    if (typeof source.licence !== "string" || !source.licence.trim() ||
        ["unknown", "none", "n/a"].includes(source.licence.trim().toLowerCase())) {
      throw new TypeError("media source " + sourceId + " requires a known licence");
    }
    if (!Array.isArray(source.permittedOperations) ||
        REQUIRED_SCOPES.some((scope) => !source.permittedOperations.includes(scope))) {
      throw new TypeError("media source " + sourceId + " lacks explicit private intake, photogrammetry and texture-baking scopes");
    }
    const file = await readWorkspaceFile(root, source.relativePath, "media source " + sourceId, MAX_IMAGE_BYTES);
    sourceById.set(sourceId, {
      ...source,
      sourceId,
      kind: "image",
      relativePath: file.relativePath,
      sha256: file.sha256,
      licence: source.licence.trim(),
    });
  }

  const imageIds = new Set();
  const boundImages = [];
  for (const [index, image] of input.textureCandidate.images.entries()) {
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new TypeError("textureCandidate.images[" + index + "] must be an object");
    }
    const id = safeId(image.id, "texture image ID");
    if (imageIds.has(id)) throw new TypeError("texture image IDs must be unique");
    imageIds.add(id);
    const source = sourceById.get(id);
    if (!source) throw new TypeError("texture image " + id + " does not map to a media source ID");
    const relativePath = safeRelativePath(image.path, "texture image " + id + " path");
    if (relativePath !== source.relativePath) {
      throw new TypeError("texture image " + id + " path differs from its exact media-intake source path");
    }
    if (typeof image.sha256 !== "string" || !SHA256.test(image.sha256) ||
        image.sha256.toLowerCase() !== source.sha256) {
      throw new TypeError("texture image " + id + " SHA-256 does not match the exact media source bytes");
    }
    if (image.licence !== source.licence) {
      throw new TypeError("texture image " + id + " licence does not match the media source rights record");
    }
    if (image.verifiedSource !== true || image.rightsReviewed !== true) {
      throw new TypeError("texture image " + id + " requires verifiedSource and rightsReviewed attestations");
    }
    if (!Number.isInteger(image.width) || image.width < 1 ||
        !Number.isInteger(image.height) || image.height < 1) {
      throw new TypeError("texture image " + id + " requires positive integer width and height");
    }
    boundImages.push({
      id,
      path: relativePath,
      sha256: source.sha256,
      licence: source.licence,
      width: image.width,
      height: image.height,
      verifiedSource: true,
      rightsReviewed: true,
    });
  }

  if (imageIds.size !== sourceById.size ||
      [...sourceById.keys()].some((id) => !imageIds.has(id))) {
    throw new TypeError("every media source must have one exact geometry texture-image evidence record");
  }
  const sourceManifest = [...sourceById.values()].map((source) => ({
    sourceId: source.sourceId,
    relativePath: source.relativePath,
    sha256: source.sha256,
    licence: source.licence,
    permittedOperations: [...source.permittedOperations].sort(),
  })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));

  return {
    input,
    inputSha256: inputFile.sha256,
    sourceManifest,
    boundImages,
    viewSourceIds: sourceManifest.map((source) => source.sourceId),
  };
}

/**
 * Orchestrates the existing resumable media and architectural-geometry workflows
 * as two hash-bound child jobs. The geometry workflow consumes its reviewed
 * camera/feature/face input and the same exact images; it is not a hidden
 * post-process of the first procedural/photogrammetry GLB.
 */
export async function runEvidenceBackedVerticalSlice(options, dependencies = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("vertical-slice options are required");
  }
  const workspaceRoot = await realpath(path.resolve(options.workspaceRoot ?? ""));
  const buildingId = safeId(options.buildingId, "buildingId");
  const jobId = safeId(options.jobId, "jobId", 40);
  const media = options.media;
  const geometry = options.geometry;
  const evidence = await prepareEvidence({ root: workspaceRoot, media, geometry });

  const mediaJobId = safeId(jobId + "-media", "media child job ID");
  const geometryJobId = safeId(jobId + "-geometry", "geometry child job ID");
  const runMedia = dependencies.runMediaToModelWorkflow ?? runMediaToModelWorkflow;
  const runGeometry = dependencies.runArchitecturalGeometryWorkflow ?? runArchitecturalGeometryWorkflow;
  if (typeof runMedia !== "function" || typeof runGeometry !== "function") {
    throw new TypeError("workflow dependencies must be functions");
  }

  const outputDirectory = await ensureDirectory(workspaceRoot, [
    ".building-engine", "vertical-slices", buildingId, jobId,
  ]);
  const reportPath = path.join(outputDirectory, "vertical-slice-report.json");
  const report = {
    schemaVersion: "1.0.0",
    workflow: "D3M-ENGINE-03",
    buildingId,
    jobId,
    status: "running",
    createdAt: new Date().toISOString(),
    sourceEvidence: {
      geometryInputPath: geometry.inputPath,
      geometryInputSha256: evidence.inputSha256,
      sources: evidence.sourceManifest,
      selectedViewSourceIds: evidence.viewSourceIds,
      sourceSetSha256: sha256(Buffer.from(JSON.stringify(evidence.sourceManifest))),
    },
    childJobs: {
      media: { jobId: mediaJobId, status: "pending", output: null },
      geometry: { jobId: geometryJobId, status: "pending", output: null },
    },
    acceptance: {
      candidateGlbAvailable: false,
      texturedGlbAvailable: false,
      sourceEvidenceBound: true,
      geometryWorkflowChecksPassed: false,
      realWorkerInferenceVerified: false,
      independentBuildingTruthVerified: false,
      trustedHumanReviewVerified: false,
      surveyedWgs84PlacementVerified: false,
      verticalDatumVerified: false,
      cesiumProductionRenderingVerified: false,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
    blockers: [
      "real-worker-inference-not-verified-by-orchestration",
      "independent-building-truth-not-supplied",
      "trusted-human-review-not-supplied",
      "surveyed-horizontal-and-vertical-placement-not-supplied",
      "cesium-production-publication-not-performed",
    ],
    warnings: [
      "The media candidate and reviewed architectural-geometry candidate are separate outputs bound to the same exact source-image hashes; the latter is not represented as an automatic transformation of the former GLB.",
      "Still images only are accepted by this orchestration profile; video-frame extraction must be admitted in a separate rights-reviewed intake.",
    ],
  };
  await atomicJson(reportPath, report);

  try {
    report.childJobs.media.status = "running";
    await atomicJson(reportPath, report);
    const mediaResult = await runMedia({
      ...media,
      workspaceRoot,
      buildingSpec: media.buildingSpec,
      jobId: mediaJobId,
      strategy: "photogrammetry",
      confirmRights: true,
      confirmSameBuilding: true,
      confirmOverlapReviewed: true,
      confirmUpAxisReviewed: true,
      viewSourceIds: evidence.viewSourceIds,
      sources: evidence.sourceManifest.map((source) => ({
        sourceId: source.sourceId,
        kind: "image",
        relativePath: source.relativePath,
        licence: source.licence,
        permittedOperations: source.permittedOperations,
        ...(source.author ? { author: source.author } : {}),
        ...(source.attribution ? { attribution: source.attribution } : {}),
        ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
        ...(source.capturedAt ? { capturedAt: source.capturedAt } : {}),
        ...(source.description ? { description: source.description } : {}),
        ...(source.captureLocation ? { captureLocation: source.captureLocation } : {}),
      })),
    });
    const mediaModelPath = mediaResult?.modelPath;
    if (typeof mediaModelPath !== "string") {
      throw new TypeError("media-to-model workflow returned no modelPath");
    }
    const mediaModelRelative = path.relative(workspaceRoot, path.resolve(mediaModelPath)).split(path.sep).join("/");
    const mediaModelFile = await readWorkspaceFile(workspaceRoot, mediaModelRelative, "media model candidate", 512 * 1024 * 1024);
    assertGlb(mediaModelFile.bytes, "media model candidate");
    const mediaReport = mediaResult.report;
    if (!mediaReport || mediaReport.mapReady !== false || mediaReport.publicationEligible !== false) {
      throw new TypeError("media-to-model report must retain fail-closed publication gates");
    }
    if (mediaReport.output?.modelSha256 !== mediaModelFile.sha256) {
      throw new TypeError("media-to-model report model SHA-256 does not match the emitted GLB bytes");
    }
    if (mediaReport.output?.modelPath !== mediaModelRelative) {
      throw new TypeError("media-to-model report path does not match the emitted GLB");
    }
    const ingestedRecords = new Map((mediaReport.inputs?.mediaRecords ?? []).map((record) => [record.id, record]));
    for (const source of evidence.sourceManifest) {
      const ingested = ingestedRecords.get(source.sourceId);
      if (!ingested || ingested.sha256 !== source.sha256) {
        throw new TypeError("media workflow did not preserve exact source bytes for " + source.sourceId);
      }
      if (ingested.kind !== "image" || ingested.licence !== source.licence ||
          ingested.usageStatus !== "approved" ||
          REQUIRED_SCOPES.some((scope) => !(ingested.permittedOperations ?? []).includes(scope))) {
        throw new TypeError("media rights/intake record does not preserve the exact approved still-image scope for " + source.sourceId);
      }
    }
    const actualSelectedIds = mediaReport.inputs?.selectedViewIds;
    if (!Array.isArray(actualSelectedIds) ||
        actualSelectedIds.length !== evidence.viewSourceIds.length ||
        [...actualSelectedIds].sort().join("\\u0000") !== [...evidence.viewSourceIds].sort().join("\\u0000")) {
      throw new TypeError("media-to-model workflow selected-view IDs do not match the exact preflight source set");
    }
    report.childJobs.media.status = mediaReport.status ?? "completed-requires-review";
    report.childJobs.media.output = {
      modelPath: mediaModelRelative,
      modelSha256: mediaModelFile.sha256,
      modelBytes: mediaModelFile.bytes.length,
      reportPath: mediaResult.reportPath ?? null,
      selectedViewSourceIds: mediaReport.inputs?.selectedViewIds ?? [],
    };
    report.acceptance.candidateGlbAvailable = true;
    report.mediaWorkflowStatus = mediaReport.status ?? null;
    await atomicJson(reportPath, report);

    report.childJobs.geometry.status = "running";
    await atomicJson(reportPath, report);
    const geometryResult = await runGeometry({
      ...geometry,
      workspaceRoot,
      buildingId,
      jobId: geometryJobId,
      inputPath: geometry.inputPath,
      confirmCameraCalibrationReviewed: true,
      confirmCorrespondencesReviewed: true,
      confirmFaceDefinitionsReviewed: true,
      confirmTextureEvidenceReviewed: true,
    });
    const geometryReport = geometryResult?.report;
    if (!geometryReport || geometryReport.mapReady !== false || geometryReport.publicationEligible !== false) {
      throw new TypeError("architectural geometry report must retain fail-closed publication gates");
    }
    if (geometryReport.input?.sha256 !== evidence.inputSha256) {
      throw new TypeError("architectural geometry report input SHA-256 does not match the preflight geometry input");
    }

    const texturedModel = geometryReport.output?.texturedModel;
    let texturedOutput = null;
    if (texturedModel?.path && texturedModel?.sha256) {
      const texturedRelative = path.relative(workspaceRoot, path.resolve(workspaceRoot, texturedModel.path))
        .split(path.sep).join("/");
      const texturedFile = await readWorkspaceFile(workspaceRoot, texturedRelative, "textured geometry candidate", 512 * 1024 * 1024);
      assertGlb(texturedFile.bytes, "textured geometry candidate");
      if (texturedFile.sha256 !== String(texturedModel.sha256).toLowerCase()) {
        throw new TypeError("architectural geometry textured-GLB hash does not match the emitted file");
      }
      const texturedTriangleCount = texturedModel.texturedTriangleCount;
      const untexturedTriangleCount = texturedModel.untexturedTriangleCount;
      if (!Number.isSafeInteger(texturedTriangleCount) || texturedTriangleCount < 1 ||
          !Number.isSafeInteger(untexturedTriangleCount) || untexturedTriangleCount < 0) {
        throw new TypeError("textured geometry candidate must report positive textured-triangle and non-negative untextured-triangle counts");
      }
      texturedOutput = {
        path: texturedRelative,
        sha256: texturedFile.sha256,
        bytes: texturedFile.bytes.length,
        texturedTriangleCount,
        untexturedTriangleCount,
      };
      report.acceptance.texturedGlbAvailable = true;
    }
    const geometryInputAfter = await readWorkspaceFile(
      workspaceRoot,
      geometry.inputPath,
      "geometry input",
      MAX_GEOMETRY_INPUT_BYTES,
    );
    if (geometryInputAfter.sha256 !== evidence.inputSha256) {
      throw new TypeError("geometry input changed while the vertical-slice workflow was running");
    }

    report.childJobs.geometry.status = geometryReport.status ?? "review-required";
    report.childJobs.geometry.output = {
      reportPath: geometryResult.reportPath ?? null,
      inputSha256: geometryReport.input.sha256,
      texturedModel: texturedOutput,
      blockerCount: geometryReport.blockers?.length ?? 0,
      blockers: geometryReport.blockers ?? [],
      checks: geometryReport.checks ?? {},
    };
    report.geometryWorkflowStatus = geometryReport.status ?? null;
    report.acceptance.geometryWorkflowChecksPassed = geometryReport.blockers?.length === 0 &&
      geometryReport.checks?.glbTextureBindingQaValid === true &&
      Boolean(texturedOutput) &&
      texturedOutput.texturedTriangleCount > 0 &&
      texturedOutput.untexturedTriangleCount === 0;
    report.status = report.acceptance.texturedGlbAvailable
      ? "completed-requires-human-review"
      : "blocked-geometry-workflow-did-not-export-a-textured-glb";
    report.completedAt = new Date().toISOString();
    report.acceptance.acceptanceEligible = false;
    report.acceptance.publicationEligible = false;
    report.acceptance.mapReady = false;
    report.acceptance.automaticApproval = false;
    if (!texturedOutput) report.blockers.push("architectural-geometry-workflow-did-not-export-a-textured-glb");
    if (texturedOutput?.untexturedTriangleCount > 0) report.blockers.push("textured-glb-still-has-untextured-triangles");
    if (geometryReport.blockers?.length) report.blockers.push(...geometryReport.blockers);
    if (!report.acceptance.geometryWorkflowChecksPassed) {
      report.blockers.push("architectural-geometry-workflow-has-unresolved-technical-checks");
    }
  } catch (error) {
    report.status = "failed";
    report.failedAt = new Date().toISOString();
    report.failure = {
      name: error?.name ?? "Error",
      message: String(error?.message ?? error).slice(0, 2000),
    };
    if (report.childJobs.media.status === "running") report.childJobs.media.status = "failed";
    if (report.childJobs.geometry.status === "running") report.childJobs.geometry.status = "failed";
    report.blockers.push("vertical-slice-child-workflow-failed");
  }

  // Re-assert the release boundary immediately before persisting, regardless of
  // child workflow status or any upstream synthetic/test report values.
  report.acceptance.acceptanceEligible = false;
  report.acceptance.publicationEligible = false;
  report.acceptance.mapReady = false;
  report.acceptance.automaticApproval = false;
  await atomicJson(reportPath, report);
  return { reportPath, report };
}
