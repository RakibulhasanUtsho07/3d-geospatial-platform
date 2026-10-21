import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readImageDimensions } from "./image-quality-preflight.mjs";
import { buildMultiViewWireframe } from "./multi-view-wireframe-registration.mjs";
import { runWireframeQaRepairPasses } from "./wireframe-qa-repair-passes.mjs";
import { buildMeshFromReviewedWireframe } from "./wireframe-to-mesh.mjs";
import { reviewMeshSurfaces } from "./mesh-surface-review.mjs";
import { reviewTextureProjection } from "./texture-projection-review.mjs";
import { buildTexturedGlb } from "./textured-glb-export.mjs";
import { reviewGlbTextureBindings } from "./glb-texture-binding-qa.mjs";
import { REQUIRED_REVIEW_VIEWS } from "./render-review-manifest.mjs";
import {
  ARCHITECTURAL_GEOMETRY_STAGE_IDS,
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  startReconstructionStage,
  completeReconstructionStage,
  failReconstructionStage,
} from "./reconstruction-job-state.mjs";

const WORKFLOW_VERSION = "architectural-geometry-textured-glb-v2";
const ATLAS_SCRIPT = fileURLToPath(new URL("../../../scripts/build-texture-atlas.mjs", import.meta.url));
const RENDER_SCRIPT = fileURLToPath(new URL("../../../scripts/render-building-review-views.mjs", import.meta.url));
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function safeId(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)) {
    throw new TypeError(label + " must be a safe identifier of at most 80 characters");
  }
  return value;
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

async function hashFile(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function readHeader(filePath, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of createReadStream(filePath, { start: 0, end: maxBytes - 1 })) {
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks, total);
}

async function readRegularFile(root, relativePath, label, maxBytes) {
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
  return { path: realPath, relativePath: path.relative(root, realPath).split(path.sep).join("/"), bytes: entry.size };
}

async function atomicWriteJson(filePath, value) {
  const parent = path.dirname(filePath);
  const tempPath = path.join(parent, "." + path.basename(filePath) + "." + randomUUID() + ".tmp");
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    try {
      const current = await lstat(filePath);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new TypeError("refusing to replace a non-regular workflow report");
      }
      await rm(filePath);
      await rename(tempPath, filePath);
    } catch (replaceError) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw replaceError;
    }
  }
}

async function atomicWriteBytes(filePath, bytes) {
  const parent = path.dirname(filePath);
  const tempPath = path.join(parent, "." + path.basename(filePath) + "." + randomUUID() + ".tmp");
  await writeFile(tempPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error?.code)) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
    try {
      const current = await lstat(filePath);
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new TypeError("refusing to replace a non-regular binary output");
      }
      await rm(filePath);
      await rename(tempPath, filePath);
    } catch (replaceError) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw replaceError;
    }
  }
}

async function ensureWorkflowDirectory(root, segments) {
  let current = root;
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.includes(path.sep)) {
      throw new TypeError("unsafe workflow output directory segment");
    }
    const next = path.join(current, segment);
    try {
      const entry = await lstat(next);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new TypeError("workflow output path must not contain symlinks or non-directories: " + next);
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
        throw new TypeError("unsafe workflow output directory: " + next);
      }
    }
    current = await realpath(next);
    if (!inside(root, current)) throw new TypeError("workflow output directory resolves outside workspaceRoot");
  }
  return current;
}

async function readVerifiedOutput(root, relativePath, label, maxBytes = 512 * 1024 * 1024) {
  const file = await readRegularFile(root, relativePath, label, maxBytes);
  const bytes = await readFile(file.path);
  return { ...file, bytes, sha256: sha256(bytes) };
}

function canonicalFaceKey(vertices) {
  if (!Array.isArray(vertices) || vertices.length !== 3 ||
      vertices.some((id) => typeof id !== "string" || !id) ||
      new Set(vertices).size !== 3) return null;
  return [...vertices].sort().join("\u0000");
}

function attemptLabel(started, stageId) {
  const stage = started.job.stages.find((item) => item.id === stageId);
  if (!stage) throw new TypeError("stage attempt is missing from the active job state");
  return "attempt-" + String(stage.attempts).padStart(4, "0");
}

async function verifySha256File(root, relativePath, expectedSha256, label, maxBytes) {
  const file = await readVerifiedOutput(root, relativePath, label, maxBytes);
  if (file.sha256 !== String(expectedSha256 ?? "").toLowerCase()) {
    throw new TypeError(label + " SHA-256 mismatch");
  }
  return file;
}

function requireAttestations(options) {
  const required = [
    ["confirmCameraCalibrationReviewed", "camera calibration review"],
    ["confirmCorrespondencesReviewed", "cross-view feature correspondence review"],
    ["confirmFaceDefinitionsReviewed", "explicit mesh face definition review"],
    ["confirmTextureEvidenceReviewed", "texture source rights and projection-evidence review"],
  ];
  for (const [field, label] of required) {
    if (options[field] !== true) {
      throw new TypeError(field + " must be true after completing " + label);
    }
  }
}

async function loadAndVerifyInput(root, relativePath) {
  const file = await readRegularFile(root, relativePath, "geometry input", MAX_INPUT_BYTES);
  const bytes = await readFile(file.path);
  let input;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError("geometry input must contain valid JSON: " + error.message);
  }
  if (!isRecord(input)) throw new TypeError("geometry input must be a JSON object");
  if (!Array.isArray(input.cameras) || !Array.isArray(input.features) ||
      !Array.isArray(input.edges) || !Array.isArray(input.faces)) {
    throw new TypeError("geometry input needs cameras, features, edges and explicit faces arrays");
  }
  if (!isRecord(input.textureCandidate) ||
      !Array.isArray(input.textureCandidate.images) ||
      !Array.isArray(input.textureCandidate.cameraCalibrations) ||
      !Array.isArray(input.textureCandidate.faces)) {
    throw new TypeError("textureCandidate needs images, cameraCalibrations and faces arrays");
  }
  if (input.textureCandidate.images.length > 100) {
    throw new RangeError("at most 100 texture source images are allowed");
  }

  const verifiedImages = [];
  const seenImageIds = new Set();
  for (const image of input.textureCandidate.images) {
    if (!isRecord(image) || typeof image.id !== "string" || !image.id || seenImageIds.has(image.id)) {
      throw new TypeError("texture source image IDs must be non-empty and unique");
    }
    seenImageIds.add(image.id);
    if (image.verifiedSource !== true || image.rightsReviewed !== true ||
        typeof image.licence !== "string" || !image.licence.trim() ||
        ["unknown", "n/a", "none"].includes(image.licence.trim().toLowerCase())) {
      throw new TypeError("texture image " + image.id + " requires explicit verifiedSource, rightsReviewed and a known licence");
    }
    if (typeof image.sha256 !== "string" || !SHA256.test(image.sha256)) {
      throw new TypeError("texture image " + image.id + " requires a declared SHA-256 digest");
    }
    const source = await readRegularFile(root, image.path, "texture image " + image.id, MAX_REFERENCE_IMAGE_BYTES);
    const actualHash = await hashFile(source.path);
    if (actualHash.toLowerCase() !== image.sha256.toLowerCase()) {
      throw new TypeError("texture image SHA-256 mismatch for " + image.id);
    }
    const header = await readHeader(source.path);
    const dimensions = readImageDimensions(header);
    if (!dimensions || dimensions.width !== image.width || dimensions.height !== image.height) {
      throw new TypeError("texture image dimensions do not match the verified file for " + image.id);
    }
    verifiedImages.push({
      id: image.id,
      path: source.relativePath,
      sha256: actualHash,
      width: dimensions.width,
      height: dimensions.height,
      verifiedSource: true,
      rightsReviewed: true,
      licence: image.licence.trim(),
    });
  }

  const normalizedInput = {
    ...input,
    textureCandidate: {
      ...input.textureCandidate,
      images: input.textureCandidate.images.map((image) => {
        const verified = verifiedImages.find((record) => record.id === image.id);
        return verified ? { ...image, ...verified } : image;
      }),
    },
  };
  const declaredCameraIds = new Set(normalizedInput.cameras.map((camera) => camera?.id));
  for (const calibration of normalizedInput.textureCandidate.cameraCalibrations) {
    if (!declaredCameraIds.has(calibration?.id)) {
      throw new TypeError("texture camera calibration " + String(calibration?.id) + " must match a registered camera ID");
    }
  }
  return {
    input: normalizedInput,
    sourceManifest: {
      geometryInput: {
        relativePath: file.relativePath,
        sha256: sha256(bytes),
        sizeBytes: bytes.length,
      },
      textureImages: verifiedImages.map(({ id, path: imagePath, sha256: imageSha, width, height, licence }) => ({
        id, relativePath: imagePath, sha256: imageSha, width, height, licence,
      })),
    },
  };
}

async function runStage({ workspaceRoot, buildingId, jobId, stageId, inputFingerprint, execute, validateReused }) {
  const args = { workspaceRoot, buildingId, jobId, stageId, inputFingerprint };
  let started = await startReconstructionStage(args);
  if (started.reused && validateReused) {
    try {
      await validateReused(started.artifact);
    } catch {
      started = await startReconstructionStage({ ...args, force: true });
    }
  }
  if (started.reused) return { artifact: started.artifact, reused: true };
  try {
    const result = await execute(started);
    const completed = await completeReconstructionStage({
      workspaceRoot,
      buildingId,
      jobId,
      stageId,
      payload: result.payload,
      outputs: result.outputs,
    });
    return { artifact: completed.artifact, reused: false };
  } catch (error) {
    await failReconstructionStage({ workspaceRoot, buildingId, jobId, stageId, error }).catch(() => {});
    throw error;
  }
}

function stageFingerprint(stageId, inputHash, upstreamHashes = [], parameters = {}) {
  return fingerprintStageInput({
    stageId,
    inputs: { inputHash, upstreamArtifactSha256: upstreamHashes },
    parameters,
  });
}

export async function runArchitecturalGeometryWorkflow(options) {
  if (!isRecord(options)) throw new TypeError("workflow options are required");
  requireAttestations(options);
  const root = await realpath(path.resolve(options.workspaceRoot));
  const buildingId = safeId(options.buildingId, "buildingId");
  const jobId = safeId(options.jobId, "jobId");
  const inputPath = options.inputPath;
  const loaded = await loadAndVerifyInput(root, inputPath);
  const { input } = loaded;
  const inputSha256 = loaded.sourceManifest.geometryInput.sha256;

  const config = {
    workflowVersion: WORKFLOW_VERSION,
    confirmCameraCalibrationReviewed: options.confirmCameraCalibrationReviewed,
    confirmCorrespondencesReviewed: options.confirmCorrespondencesReviewed,
    confirmFaceDefinitionsReviewed: options.confirmFaceDefinitionsReviewed,
    confirmTextureEvidenceReviewed: options.confirmTextureEvidenceReviewed,
    maxRmsReprojectionError: options.maxRmsReprojectionError ?? input.options?.maxRmsReprojectionError ?? 3,
    maxRepairPasses: options.maxRepairPasses ?? input.options?.maxRepairPasses ?? 3,
    maxBoundaryEdges: options.maxBoundaryEdges ?? input.options?.maxBoundaryEdges ?? 0,
    minTriangleArea: options.minTriangleArea ?? input.options?.minTriangleArea ?? 1e-8,
    maxTextureReprojectionErrorPx: options.maxTextureReprojectionErrorPx ?? input.options?.maxTextureReprojectionErrorPx ?? 2,
    textureAtlasWidth: options.textureAtlasWidth ?? 2048,
    textureAtlasHeight: options.textureAtlasHeight ?? 2048,
    textureAtlasPadding: options.textureAtlasPadding ?? 4,
    renderReviewRequested: options.renderReview === true,
    renderResolution: options.renderResolution ?? 1024,
    blenderExecutable: options.blenderExecutable ?? null,
  };
  if (![config.textureAtlasWidth, config.textureAtlasHeight].every((value) =>
    Number.isInteger(value) && value >= 256 && value <= 4096)) {
    throw new RangeError("texture atlas dimensions must be integers between 256 and 4096");
  }
  if (!Number.isInteger(config.textureAtlasPadding) || config.textureAtlasPadding < 0 ||
      config.textureAtlasPadding > 64) {
    throw new RangeError("texture atlas padding must be an integer between 0 and 64");
  }
  if (config.renderReviewRequested && (!Number.isInteger(config.renderResolution) ||
      config.renderResolution < 256 || config.renderResolution > 2048 ||
      (config.renderResolution & (config.renderResolution - 1)) !== 0)) {
    throw new RangeError("renderResolution must be a power of two between 256 and 2048");
  }
  const state = await createOrResumeReconstructionJob({
    workspaceRoot: root,
    buildingId,
    jobId,
    sourceManifest: loaded.sourceManifest,
    config,
    stageIds: ARCHITECTURAL_GEOMETRY_STAGE_IDS,
  });
  const stateArgs = { workspaceRoot: root, buildingId, jobId };
  const registration = await runStage({
    ...stateArgs,
    stageId: "view-registration",
    inputFingerprint: stageFingerprint("view-registration", inputSha256, [], {
      maxRmsReprojectionError: config.maxRmsReprojectionError,
    }),
    execute: async () => {
      const wireframe = buildMultiViewWireframe({
        cameras: input.cameras,
        features: input.features,
        edges: input.edges,
        options: { maxRmsReprojectionError: config.maxRmsReprojectionError },
      });
      return {
        payload: {
          wireframe,
          cameraCalibrationReviewAttested: true,
          crossViewCorrespondenceReviewAttested: true,
          evidenceInputSha256: inputSha256,
        },
        outputs: {
          status: wireframe.status,
          cameraCount: wireframe.cameraCount,
          inputFeatureCount: wireframe.inputFeatureCount,
          triangulatedVertexCount: wireframe.triangulatedVertexCount,
          edgeCount: wireframe.edgeCount,
          issueCount: wireframe.issues.length,
        },
      };
    },
  });

  const registrationPayload = registration.artifact.payload;
  if (!registrationPayload?.wireframe) throw new TypeError("view-registration artifact has no wireframe output");
  const wireframeStage = await runStage({
    ...stateArgs,
    stageId: "wireframe",
    inputFingerprint: stageFingerprint(
      "wireframe",
      inputSha256,
      [registration.artifact.contentSha256],
      { faceDefinitionCount: input.faces.length, explicitFacesReviewed: true },
    ),
    execute: async () => {
      const wireframe = registrationPayload.wireframe;
      return {
        payload: {
          vertices: wireframe.vertices,
          edges: wireframe.edges,
          faces: input.faces,
          registrationIssues: wireframe.issues,
          registrationStatus: wireframe.status,
          faceDefinitionsReviewed: true,
        },
        outputs: {
          vertexCount: wireframe.vertices.length,
          edgeCount: wireframe.edges.length,
          explicitFaceCount: input.faces.length,
          registrationIssueCount: wireframe.issues.length,
        },
      };
    },
  });

  const wireframePayload = wireframeStage.artifact.payload;
  const wireframeQa = await runStage({
    ...stateArgs,
    stageId: "iterative-sketch-repair",
    inputFingerprint: stageFingerprint(
      "iterative-sketch-repair",
      inputSha256,
      [wireframeStage.artifact.contentSha256],
      {
        maxPasses: config.maxRepairPasses,
        maxRmsReprojectionError: config.maxRmsReprojectionError,
      },
    ),
    execute: async () => {
      const report = runWireframeQaRepairPasses({
        vertices: wireframePayload.vertices,
        edges: wireframePayload.edges,
        maxRmsReprojectionError: config.maxRmsReprojectionError,
      }, {
        maxPasses: config.maxRepairPasses,
        maxRmsReprojectionError: config.maxRmsReprojectionError,
      });
      return {
        payload: { report, faces: wireframePayload.faces, registrationIssues: wireframePayload.registrationIssues },
        outputs: {
          status: report.status,
          passesExecuted: report.passesExecuted,
          repairCount: report.repairs.length,
          flaggedVertexCount: report.history.at(-1)?.flaggedVertices.length ?? 0,
          edgeCount: report.edges.length,
          explicitFaceCount: wireframePayload.faces.length,
        },
      };
    },
  });

  const qaPayload = wireframeQa.artifact.payload;
  const meshStage = await runStage({
    ...stateArgs,
    stageId: "volume-and-facade-model",
    inputFingerprint: stageFingerprint(
      "volume-and-facade-model",
      inputSha256,
      [wireframeQa.artifact.contentSha256],
      { minTriangleArea: config.minTriangleArea },
    ),
    execute: async () => {
      const mesh = buildMeshFromReviewedWireframe({
        vertices: qaPayload.report.vertices,
        faces: qaPayload.faces,
      }, { minTriangleArea: config.minTriangleArea });
      return {
        payload: { mesh, registrationIssues: qaPayload.registrationIssues, wireframeQa: qaPayload.report },
        outputs: {
          acceptedTriangleCount: mesh.qa.acceptedFaceCount,
          rejectedFaceCount: mesh.qa.rejectedFaces.length,
          boundaryEdgeCount: mesh.qa.boundaryEdgeCount,
          nonManifoldEdgeCount: mesh.qa.nonManifoldEdges.length,
          closedManifoldCandidate: mesh.qa.closedManifoldCandidate,
        },
      };
    },
  });

  const meshPayload = meshStage.artifact.payload;
  const geometryReview = await runStage({
    ...stateArgs,
    stageId: "geometry-repair",
    inputFingerprint: stageFingerprint(
      "geometry-repair",
      inputSha256,
      [meshStage.artifact.contentSha256],
      { maxBoundaryEdges: config.maxBoundaryEdges },
    ),
    execute: async () => {
      const report = reviewMeshSurfaces(meshPayload.mesh, { maxBoundaryEdges: config.maxBoundaryEdges });
      return {
        payload: { report, mesh: meshPayload.mesh, registrationIssues: meshPayload.registrationIssues, wireframeQa: meshPayload.wireframeQa },
        outputs: {
          status: report.status,
          acceptedTriangleCount: report.acceptedTriangleCount,
          boundaryEdgeCount: report.boundaryEdges.length,
          nonManifoldEdgeCount: report.nonManifoldEdges.length,
          blockerCount: report.blockers.length,
          repairProposalCount: report.repairProposals.length,
        },
      };
    },
  });

  const geometryPayload = geometryReview.artifact.payload;
  const textureStage = await runStage({
    ...stateArgs,
    stageId: "texture",
    inputFingerprint: stageFingerprint(
      "texture",
      inputSha256,
      [geometryReview.artifact.contentSha256],
      { maxReprojectionErrorPx: config.maxTextureReprojectionErrorPx },
    ),
    execute: async () => {
      const report = reviewTextureProjection(input.textureCandidate, {
        maxReprojectionErrorPx: config.maxTextureReprojectionErrorPx,
      });
      return {
        payload: { report, meshSha256: meshStage.artifact.contentSha256 },
        outputs: {
          status: report.status,
          inputFaceCount: report.faceCount,
          evidenceEligibleFaceCount: report.evidenceEligibleFaceIndices.length,
          rejectedFaceCount: report.rejectedFaces.length,
          blockerCount: report.blockers.length,
          texturePixelProjectionPerformed: false,
          atlasBakingPerformed: false,
        },
      };
    },
  });

  const texturePayload = textureStage.artifact.payload;
  const atlasStage = await runStage({
    ...stateArgs,
    stageId: "texture-atlas-bake",
    inputFingerprint: stageFingerprint(
      "texture-atlas-bake",
      inputSha256,
      [geometryReview.artifact.contentSha256, textureStage.artifact.contentSha256],
      {
        width: config.textureAtlasWidth,
        height: config.textureAtlasHeight,
        padding: config.textureAtlasPadding,
        baker: "ffmpeg-edge-gutter-v1",
      },
    ),
    validateReused: async (artifact) => {
      if (artifact.payload.status !== "baked") return;
      const atlasFile = await verifySha256File(root, artifact.outputs.atlasPath, artifact.outputs.atlasSha256, "cached texture atlas", 512 * 1024 * 1024);
      const manifestFile = await verifySha256File(root, artifact.outputs.manifestPath, artifact.outputs.manifestSha256, "cached texture atlas manifest", 64 * 1024 * 1024);
      const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
      const dimensions = readImageDimensions(await readHeader(atlasFile.path));
      if (!dimensions || dimensions.width !== artifact.outputs.width || dimensions.height !== artifact.outputs.height ||
          manifest.atlas?.width !== dimensions.width || manifest.atlas?.height !== dimensions.height) {
        throw new TypeError("cached texture atlas dimensions do not match its manifest");
      }
    },
    execute: async (started) => {
      const reviewedFaceIndices = new Set(texturePayload.report?.evidenceEligibleFaceIndices ?? []);
      const mesh = geometryPayload.mesh;
      const meshKeys = new Set(mesh.triangles.map((triangle) => canonicalFaceKey(triangle.vertices)).filter(Boolean));
      const candidateFaces = input.textureCandidate.faces.filter((face, index) =>
        reviewedFaceIndices.has(index) && meshKeys.has(canonicalFaceKey(face?.vertices)));
      const usedImageIds = new Set(candidateFaces.map((face) => face.sourceImageId));
      const images = input.textureCandidate.images.filter((image) => usedImageIds.has(image.id));
      if (!candidateFaces.length || !images.length) {
        return {
          payload: {
            status: "blocked",
            reason: "no-mesh-triangles-have-verified-texture-and-UV-evidence",
            atlasBakingPerformed: false,
          },
          outputs: {
            status: "blocked",
            candidateFaceCount: candidateFaces.length,
            sourceImageCount: images.length,
            atlasBakingPerformed: false,
          },
        };
      }
      const outputDir = await ensureWorkflowDirectory(root, [
        ".building-engine", "reconstruction-jobs", buildingId, jobId, "outputs",
        "texture-atlas-bake", attemptLabel(started, "texture-atlas-bake"),
      ]);
      const candidatePath = path.join(outputDir, "verified-texture-candidate.json");
      const manifestPath = path.join(outputDir, "texture-atlas-manifest.json");
      const atlasPath = path.join(outputDir, "texture-atlas.png");
      const candidate = {
        images: images.map((image) => ({ ...image, path: path.resolve(root, image.path) })),
        faces: candidateFaces,
      };
      await writeFile(candidatePath, JSON.stringify(candidate, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      const result = spawnSync(process.execPath, [
        ATLAS_SCRIPT,
        candidatePath,
        manifestPath,
        atlasPath,
        "--width=" + config.textureAtlasWidth,
        "--height=" + config.textureAtlasHeight,
        "--padding=" + config.textureAtlasPadding,
      ], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      if (result.error) throw new Error("Unable to start texture atlas builder: " + result.error.message);
      if (result.status !== 0) {
        throw new Error("Texture atlas builder failed: " + ((result.stderr || result.stdout || "unknown error").trim()).slice(-5000));
      }
      const relativeAtlasPath = path.relative(root, atlasPath).split(path.sep).join("/");
      const relativeManifestPath = path.relative(root, manifestPath).split(path.sep).join("/");
      const atlasFile = await readVerifiedOutput(root, relativeAtlasPath, "generated texture atlas", 512 * 1024 * 1024);
      const manifestFile = await readVerifiedOutput(root, relativeManifestPath, "generated texture atlas manifest", 64 * 1024 * 1024);
      const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
      const dimensions = readImageDimensions(await readHeader(atlasFile.path));
      if (!dimensions || dimensions.width !== config.textureAtlasWidth || dimensions.height !== config.textureAtlasHeight ||
          manifest.atlas?.width !== dimensions.width || manifest.atlas?.height !== dimensions.height ||
          !Array.isArray(manifest.faces) || manifest.faces.length !== candidateFaces.length) {
        throw new TypeError("texture atlas output or remapped-face manifest failed validation");
      }
      return {
        payload: {
          status: "baked",
          atlasBakingPerformed: true,
          selectedFaceCount: candidateFaces.length,
          sourceImageCount: images.length,
          atlasSha256: atlasFile.sha256,
          manifestSha256: manifestFile.sha256,
        },
        outputs: {
          status: "baked",
          atlasPath: relativeAtlasPath,
          atlasSha256: atlasFile.sha256,
          manifestPath: relativeManifestPath,
          manifestSha256: manifestFile.sha256,
          width: dimensions.width,
          height: dimensions.height,
          sourceImageCount: images.length,
          texturedFaceCount: manifest.faces.length,
          uniformScale: manifest.packing.uniformScale,
          publicationEligible: false,
        },
      };
    },
  });

  const atlasPayload = atlasStage.artifact.payload;
  const glbExport = await runStage({
    ...stateArgs,
    stageId: "glb-export",
    inputFingerprint: stageFingerprint(
      "glb-export",
      inputSha256,
      [geometryReview.artifact.contentSha256, atlasStage.artifact.contentSha256],
      { exporter: "textured-glb-export-v1" },
    ),
    validateReused: async (artifact) => {
      if (artifact.payload.status !== "exported" && artifact.payload.status !== "partial-textured-mesh") return;
      const modelFile = await verifySha256File(root, artifact.outputs.modelPath, artifact.outputs.modelSha256, "cached textured GLB", 512 * 1024 * 1024);
      if (modelFile.bytes.readUInt32LE(0) !== 0x46546c67 || modelFile.bytes.readUInt32LE(4) !== 2) {
        throw new TypeError("cached textured GLB does not have a valid GLB 2.0 header");
      }
    },
    execute: async (started) => {
      if (atlasPayload.status !== "baked") {
        return {
          payload: { status: "blocked", reason: "texture-atlas-stage-did-not-produce-an-atlas" },
          outputs: { status: "blocked", texturedTriangleCount: 0, untexturedTriangleCount: meshPayload.mesh.triangles.length },
        };
      }
      const atlasFile = await verifySha256File(root, atlasStage.artifact.outputs.atlasPath, atlasStage.artifact.outputs.atlasSha256, "texture atlas for GLB export", 512 * 1024 * 1024);
      const manifestFile = await verifySha256File(root, atlasStage.artifact.outputs.manifestPath, atlasStage.artifact.outputs.manifestSha256, "texture atlas manifest for GLB export", 64 * 1024 * 1024);
      const manifest = JSON.parse(manifestFile.bytes.toString("utf8"));
      const built = buildTexturedGlb({
        mesh: geometryPayload.mesh,
        faces: manifest.faces,
        atlasBytes: atlasFile.bytes,
        atlasWidth: manifest.atlas.width,
        atlasHeight: manifest.atlas.height,
        atlasSha256: atlasFile.sha256,
      });
      const outputDir = await ensureWorkflowDirectory(root, [
        ".building-engine", "reconstruction-jobs", buildingId, jobId, "outputs",
        "glb-export", attemptLabel(started, "glb-export"),
      ]);
      const modelPath = path.join(outputDir, "textured-building-candidate.glb");
      await atomicWriteBytes(modelPath, built.buffer);
      const relativeModelPath = path.relative(root, modelPath).split(path.sep).join("/");
      const modelSha256 = await hashFile(modelPath);
      return {
        payload: {
          status: built.report.untexturedTriangleCount > 0 ? "partial-textured-mesh" : "exported",
          modelPath: relativeModelPath,
          modelSha256,
          report: built.report,
        },
        outputs: {
          status: "exported",
          modelPath: relativeModelPath,
          modelSha256,
          texturedTriangleCount: built.report.texturedTriangleCount,
          untexturedTriangleCount: built.report.untexturedTriangleCount,
          meshTriangleCount: built.report.meshTriangleCount,
          atlasSha256: built.report.atlasSha256,
          publicationEligible: false,
        },
      };
    },
  });

  const glbPayload = glbExport.artifact.payload;
  const glbValidation = await runStage({
    ...stateArgs,
    stageId: "glb-validation",
    inputFingerprint: stageFingerprint(
      "glb-validation",
      inputSha256,
      [atlasStage.artifact.contentSha256, glbExport.artifact.contentSha256],
      { validator: "glb-texture-binding-qa-v1", expectedAtlasSha256: atlasStage.artifact.outputs.atlasSha256 ?? null },
    ),
    validateReused: async (artifact) => {
      if (artifact.payload.status === "blocked") return;
      const modelFile = await verifySha256File(root, artifact.outputs.modelPath, artifact.outputs.modelSha256, "cached GLB for texture QA", 512 * 1024 * 1024);
      const qaFile = await verifySha256File(root, artifact.outputs.qaPath, artifact.outputs.qaSha256, "cached GLB texture QA report", 64 * 1024 * 1024);
      if (modelFile.bytes.readUInt32LE(0) !== 0x46546c67) throw new TypeError("cached GLB is corrupt");
      JSON.parse(qaFile.bytes.toString("utf8"));
    },
    execute: async (started) => {
      if (atlasPayload.status !== "baked" ||
          !["exported", "partial-textured-mesh"].includes(glbPayload.status)) {
        return {
          payload: { status: "blocked", report: null, reason: "textured-GLB-export-not-available" },
          outputs: { status: "blocked", qaValid: false, errorCount: 0 },
        };
      }
      const modelFile = await verifySha256File(root, glbExport.artifact.outputs.modelPath, glbExport.artifact.outputs.modelSha256, "GLB for texture QA", 512 * 1024 * 1024);
      let qaReport;
      try {
        qaReport = reviewGlbTextureBindings(modelFile.bytes, {
          expectedAtlas: {
            sha256: atlasStage.artifact.outputs.atlasSha256,
            width: atlasStage.artifact.outputs.width,
            height: atlasStage.artifact.outputs.height,
          },
        });
      } catch (error) {
        qaReport = {
          schemaVersion: "1.0.0",
          engine: "glb-texture-binding-qa-v1",
          status: "failed",
          valid: false,
          publicationEligible: false,
          errors: [error instanceof Error ? error.message : String(error)],
          warnings: [],
          counts: { meshCount: 0, materialCount: 0, textureCount: 0, imageCount: 0, texturedPrimitiveCount: 0 },
        };
      }
      const outputDir = await ensureWorkflowDirectory(root, [
        ".building-engine", "reconstruction-jobs", buildingId, jobId, "outputs",
        "glb-validation", attemptLabel(started, "glb-validation"),
      ]);
      const qaPath = path.join(outputDir, "glb-texture-qa.json");
      await atomicWriteJson(qaPath, qaReport);
      const relativeQaPath = path.relative(root, qaPath).split(path.sep).join("/");
      const qaSha256 = await hashFile(qaPath);
      return {
        payload: { status: qaReport.valid ? "valid" : "failed", report: qaReport, modelSha256: modelFile.sha256 },
        outputs: {
          status: qaReport.status,
          qaValid: qaReport.valid,
          qaPath: relativeQaPath,
          qaSha256,
          modelPath: glbExport.artifact.outputs.modelPath,
          modelSha256: modelFile.sha256,
          errorCount: qaReport.errors?.length ?? 0,
          warningCount: qaReport.warnings?.length ?? 0,
          embeddedImageCount: qaReport.counts?.imageCount ?? 0,
          publicationEligible: false,
        },
      };
    },
  });

  const glbValidationPayload = glbValidation.artifact.payload;
  const renderReview = await runStage({
    ...stateArgs,
    stageId: "render-review",
    inputFingerprint: stageFingerprint(
      "render-review",
      inputSha256,
      [glbExport.artifact.contentSha256, glbValidation.artifact.contentSha256],
      {
        requested: config.renderReviewRequested,
        resolution: config.renderResolution,
        blenderExecutable: config.blenderExecutable,
      },
    ),
    validateReused: async (artifact) => {
      await verifySha256File(root, artifact.outputs.reviewManifestPath, artifact.outputs.reviewManifestSha256, "cached render-review manifest", 64 * 1024 * 1024);
      if (artifact.outputs.rendererReportPath) {
        await verifySha256File(root, artifact.outputs.rendererReportPath, artifact.outputs.rendererReportSha256, "cached Blender render report", 64 * 1024 * 1024);
      }
    },
    execute: async (started) => {
      const outputDir = await ensureWorkflowDirectory(root, [
        ".building-engine", "reconstruction-jobs", buildingId, jobId, "outputs",
        "render-review", attemptLabel(started, "render-review"),
      ]);
      const manifestPath = path.join(outputDir, "render-review-plan.json");
      const canRender = config.renderReviewRequested && atlasPayload.status === "baked" &&
        ["exported", "partial-textured-mesh"].includes(glbPayload.status);
      let renderStatus = canRender ? "renderer-not-run" : "render-plan-only";
      let rendererError = null;
      let rendererReportPath = null;
      let rendererReportSha256 = null;
      let renderedViewCount = 0;
      if (canRender) {
        const modelPath = path.resolve(root, glbExport.artifact.outputs.modelPath);
        const renderOutputDir = path.join(outputDir, "blender-renders");
        const args = [RENDER_SCRIPT, modelPath, renderOutputDir, "--resolution=" + config.renderResolution];
        if (config.blenderExecutable) args.push("--blender=" + config.blenderExecutable);
        const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
        if (result.status === 0) {
          const reportPath = path.join(renderOutputDir, "render-review-manifest.json");
          const reportBytes = await readFile(reportPath);
          const report = JSON.parse(reportBytes.toString("utf8"));
          rendererReportPath = path.relative(root, reportPath).split(path.sep).join("/");
          rendererReportSha256 = sha256(reportBytes);
          renderedViewCount = report.counts?.generatedViews ?? 0;
          renderStatus = report.valid ? report.status : "render-review-invalid";
        } else {
          rendererError = (result.error?.message || result.stderr || result.stdout || "renderer failed").trim().slice(-5000);
          renderStatus = "renderer-failed";
        }
      }
      const envelope = {
        schemaVersion: "1.0.0",
        status: renderStatus,
        requested: config.renderReviewRequested,
        rendersGenerated: renderedViewCount > 0,
        renderedViewCount,
        requiredViewIds: [...REQUIRED_REVIEW_VIEWS],
        rendererReportPath,
        rendererReportSha256,
        error: rendererError,
        humanReviewStatus: "pending",
        publicationEligible: false,
      };
      await atomicWriteJson(manifestPath, envelope);
      const relativeManifestPath = path.relative(root, manifestPath).split(path.sep).join("/");
      const manifestSha256 = await hashFile(manifestPath);
      return {
        payload: envelope,
        outputs: {
          status: renderStatus,
          requested: config.renderReviewRequested,
          rendersGenerated: renderedViewCount > 0,
          renderedViewCount,
          reviewManifestPath: relativeManifestPath,
          reviewManifestSha256: manifestSha256,
          rendererReportPath,
          rendererReportSha256,
          publicationEligible: false,
        },
      };
    },
  });

  const renderPayload = renderReview.artifact.payload;
  const finalFingerprint = stageFingerprint(
    "final-acceptance",
    inputSha256,
    [
      registration.artifact.contentSha256,
      wireframeStage.artifact.contentSha256,
      wireframeQa.artifact.contentSha256,
      meshStage.artifact.contentSha256,
      geometryReview.artifact.contentSha256,
      textureStage.artifact.contentSha256,
      atlasStage.artifact.contentSha256,
      glbExport.artifact.contentSha256,
      glbValidation.artifact.contentSha256,
      renderReview.artifact.contentSha256,
    ],
    { workflowVersion: WORKFLOW_VERSION },
  );
  const finalStage = await runStage({
    ...stateArgs,
    stageId: "final-acceptance",
    inputFingerprint: finalFingerprint,
    execute: async () => {
      const wireframe = registrationPayload.wireframe;
      const qaReport = qaPayload.report;
      const mesh = meshPayload.mesh;
      const surfaceReport = geometryPayload.report;
      const textureReport = texturePayload.report;
      const atlasResult = atlasStage.artifact.payload;
      const glbResult = glbExport.artifact.payload;
      const glbQa = glbValidationPayload.report;
      const blockers = [];
      if (wireframe.status !== "candidate-wireframe" || wireframe.issues.length) blockers.push("multi-view-registration-needs-review");
      if (!wireframe.vertices.length) blockers.push("no-triangulated-vertices");
      if (qaReport.status !== "qa-clean") blockers.push("wireframe-qa-needs-review");
      if (qaReport.repairs.length) blockers.push("wireframe-safe-repairs-were-applied");
      if (mesh.qa.acceptedFaceCount === 0) blockers.push("no-valid-mesh-triangles");
      if (mesh.qa.rejectedFaces.length) blockers.push("mesh-has-rejected-faces");
      if (mesh.qa.boundaryEdgeCount > 0) blockers.push("mesh-has-boundary-edges");
      if (mesh.qa.nonManifoldEdges.length > 0) blockers.push("mesh-has-non-manifold-edges");
      if (surfaceReport.blockers.length) blockers.push("mesh-surface-review-needs-review");
      if (textureReport.status !== "evidence-validation-passed" || textureReport.blockers.length) blockers.push("texture-projection-evidence-needs-review");
      if (!textureReport.faceCount) blockers.push("no-texture-projection-faces-reviewed");
      if (atlasResult.status !== "baked") blockers.push("texture-atlas-bake-blocked");
      if (!["exported", "partial-textured-mesh"].includes(glbResult.status)) blockers.push("textured-glb-export-blocked");
      if (glbQa && glbQa.valid !== true) blockers.push("glb-texture-binding-qa-failed");
      if ((glbResult.report?.untexturedTriangleCount ?? glbResult.untexturedTriangleCount ?? 0) > 0) blockers.push("mesh-triangles-missing-texture-evidence");
      if (config.renderReviewRequested && renderPayload.status === "renderer-failed") blockers.push("render-review-rendering-failed");
      if (config.renderReviewRequested && renderPayload.status === "render-review-invalid") blockers.push("render-review-manifest-invalid");

      const stages = [
        { id: "view-registration", status: wireframe.status, artifactSha256: registration.artifact.contentSha256, reused: registration.reused },
        { id: "wireframe", status: wireframe.status, artifactSha256: wireframeStage.artifact.contentSha256, reused: wireframeStage.reused },
        { id: "iterative-sketch-repair", status: qaReport.status, artifactSha256: wireframeQa.artifact.contentSha256, reused: wireframeQa.reused },
        { id: "volume-and-facade-model", status: mesh.qa.closedManifoldCandidate ? "closed-manifold-candidate" : "mesh-review-required", artifactSha256: meshStage.artifact.contentSha256, reused: meshStage.reused },
        { id: "geometry-repair", status: surfaceReport.status, artifactSha256: geometryReview.artifact.contentSha256, reused: geometryReview.reused },
        { id: "texture", status: textureReport.status, artifactSha256: textureStage.artifact.contentSha256, reused: textureStage.reused },
        { id: "texture-atlas-bake", status: atlasResult.status, artifactSha256: atlasStage.artifact.contentSha256, reused: atlasStage.reused },
        { id: "glb-export", status: glbResult.status, artifactSha256: glbExport.artifact.contentSha256, reused: glbExport.reused },
        { id: "glb-validation", status: glbValidationPayload.status, artifactSha256: glbValidation.artifact.contentSha256, reused: glbValidation.reused },
        { id: "render-review", status: renderPayload.status, artifactSha256: renderReview.artifact.contentSha256, reused: renderReview.reused },
        { id: "final-acceptance", status: blockers.length ? "review-required" : "technical-checks-passed-requires-human-review" },
      ];
      const report = {
        schemaVersion: "1.0.0",
        workflow: WORKFLOW_VERSION,
        buildingId,
        jobId,
        status: blockers.length ? "review-required" : "technical-checks-passed-requires-human-review",
        createdAt: new Date().toISOString(),
        input: {
          relativePath: loaded.sourceManifest.geometryInput.relativePath,
          sha256: inputSha256,
          cameraCount: input.cameras.length,
          featureCount: input.features.length,
          declaredEdgeCount: input.edges.length,
          explicitFaceCount: input.faces.length,
          verifiedTextureImageCount: input.textureCandidate.images.length,
          textureCandidateFaceCount: input.textureCandidate.faces.length,
          reviewedAttestations: {
            cameraCalibration: true,
            crossViewCorrespondences: true,
            explicitMeshFaces: true,
            textureSourceRightsAndProjectionEvidence: true,
          },
        },
        checks: {
          registrationStatus: wireframe.status,
          registrationIssueCount: wireframe.issues.length,
          triangulatedVertexCount: wireframe.triangulatedVertexCount,
          wireframeQaStatus: qaReport.status,
          wireframeRepairsApplied: qaReport.repairs.length,
          wireframeFlaggedVertexCount: qaReport.history.at(-1)?.flaggedVertices.length ?? 0,
          acceptedMeshTriangleCount: mesh.qa.acceptedFaceCount,
          rejectedMeshFaceCount: mesh.qa.rejectedFaces.length,
          boundaryEdgeCount: surfaceReport.boundaryEdges.length,
          nonManifoldEdgeCount: surfaceReport.nonManifoldEdges.length,
          surfaceReviewStatus: surfaceReport.status,
          textureProjectionEvidenceStatus: textureReport.status,
          textureProjectionFaceCount: textureReport.faceCount,
          textureEvidenceEligibleFaceCount: textureReport.evidenceEligibleFaceIndices.length,
          textureAtlasBakingPerformed: atlasResult.status === "baked",
          textureAtlasSha256: atlasStage.artifact.outputs.atlasSha256 ?? null,
          glbExportStatus: glbResult.status,
          texturedTriangleCount: glbExport.artifact.outputs.texturedTriangleCount ?? 0,
          untexturedTriangleCount: glbExport.artifact.outputs.untexturedTriangleCount ?? mesh.triangles.length,
          glbTextureBindingQaStatus: glbQa?.status ?? "not-run",
          glbTextureBindingQaValid: glbQa?.valid === true,
          embeddedTextureCount: glbQa?.counts?.imageCount ?? 0,
          renderReviewRequested: config.renderReviewRequested,
          renderReviewStatus: renderPayload.status,
          renderImagesGenerated: renderPayload.rendersGenerated === true,
          automaticSurfaceFillingPerformed: false,
          automaticCoordinateCorrectionPerformed: false,
        },
        stages,
        blockers: [...new Set(blockers)],
        limitations: [
          "Calibration, cross-view feature matching, explicit faces, per-face UVs and texture evidence are supplied by the operator and are not independently surveyed by this workflow.",
          "The wireframe repair worker only removes malformed/duplicate edges; it never moves coordinates or invents architecture.",
          "Mesh generation uses explicit triangular faces only. Missing surfaces are not guessed or auto-filled.",
          "The atlas baker composites verified source images and remaps supplied UVs; it does not solve camera poses, project pixels from photographs, or infer missing facade texture.",
          "The exporter writes only triangles with matching texture evidence. Any uncovered mesh triangles remain a blocker and are listed in the GLB export artifact.",
          "Render images are generated only when renderReview is true and Blender is configured. A render manifest or clean texture QA does not establish architectural fidelity.",
          "A clean topology or low reprojection error does not establish real-world dimensions, building identity or geographic accuracy.",
          "Human review, independent dimensional evidence, surveyed horizontal control and a defensible vertical datum remain required for map placement and publication.",
        ],
        output: {
          meshVertexCount: mesh.vertices.length,
          meshTriangleCount: mesh.triangles.length,
          meshCandidate: geometryPayload.mesh,
          meshSurfaceReview: surfaceReport,
          textureProjectionReview: textureReport,
          textureAtlas: atlasResult.status === "baked" ? {
            path: atlasStage.artifact.outputs.atlasPath,
            manifestPath: atlasStage.artifact.outputs.manifestPath,
            sha256: atlasStage.artifact.outputs.atlasSha256,
            manifestSha256: atlasStage.artifact.outputs.manifestSha256,
            width: atlasStage.artifact.outputs.width,
            height: atlasStage.artifact.outputs.height,
          } : null,
          texturedModel: ["exported", "partial-textured-mesh"].includes(glbResult.status) ? {
            path: glbExport.artifact.outputs.modelPath,
            sha256: glbExport.artifact.outputs.modelSha256,
            texturedTriangleCount: glbExport.artifact.outputs.texturedTriangleCount,
            untexturedTriangleCount: glbExport.artifact.outputs.untexturedTriangleCount,
          } : null,
          glbTextureQa: glbQa,
          renderReview: renderPayload,
        },
        mapReady: false,
        publicationEligible: false,
      };
      return {
        payload: { report },
        outputs: {
          status: report.status,
          blockerCount: report.blockers.length,
          meshTriangleCount: report.output.meshTriangleCount,
          glbTextureBindingQaValid: report.checks.glbTextureBindingQaValid,
          mapReady: false,
          publicationEligible: false,
        },
      };
    },
  });

  const report = finalStage.artifact.payload.report;
  if (!isRecord(report) || report.mapReady !== false || report.publicationEligible !== false) {
    throw new TypeError("final-acceptance artifact violates the fail-closed publication contract");
  }
  const reportPath = path.join(state.jobDirectory, "geometry-workflow-report.json");
  await atomicWriteJson(reportPath, report);
  const finalState = await createOrResumeReconstructionJob({
    workspaceRoot: root,
    buildingId,
    jobId,
    sourceManifest: loaded.sourceManifest,
    config,
    stageIds: ARCHITECTURAL_GEOMETRY_STAGE_IDS,
  });
  return {
    jobDirectory: state.jobDirectory,
    statePath: path.join(state.jobDirectory, "job-state.json"),
    reportPath,
    report,
    state: finalState.job,
    resumed: state.resumed,
  };
}
