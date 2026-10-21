import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { readImageDimensions } from "./image-quality-preflight.mjs";
import { buildMultiViewWireframe } from "./multi-view-wireframe-registration.mjs";
import { runWireframeQaRepairPasses } from "./wireframe-qa-repair-passes.mjs";
import { buildMeshFromReviewedWireframe } from "./wireframe-to-mesh.mjs";
import { reviewMeshSurfaces } from "./mesh-surface-review.mjs";
import { reviewTextureProjection } from "./texture-projection-review.mjs";
import {
  ARCHITECTURAL_GEOMETRY_STAGE_IDS,
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  startReconstructionStage,
  completeReconstructionStage,
  failReconstructionStage,
} from "./reconstruction-job-state.mjs";

const WORKFLOW_VERSION = "architectural-geometry-evidence-v1";
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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
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
    const header = (await readFile(source.path)).subarray(0, 1024 * 1024);
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

async function runStage({ workspaceRoot, buildingId, jobId, stageId, inputFingerprint, execute }) {
  const args = { workspaceRoot, buildingId, jobId, stageId, inputFingerprint };
  const started = await startReconstructionStage(args);
  if (started.reused) return { artifact: started.artifact, reused: true };
  try {
    const result = await execute();
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
  };
  const state = await createOrResumeReconstructionJob({
    workspaceRoot: root,
    buildingId,
    jobId,
    sourceManifest: loaded.sourceManifest,
    config,
    stageIds: ARCHITECTURAL_GEOMETRY_STAGE_IDS,
  });
  const stateArgs = { workspaceRoot: root, buildingId, jobId };
  const stateArtifactSha = (stageId) => {
    const stage = state.job.stages.find((candidate) => candidate.id === stageId);
    const active = stage?.artifacts.find((record) => record.artifactId === stage.activeArtifactId);
    return active?.contentSha256 ?? null;
  };

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

      const stages = [
        { id: "view-registration", status: wireframe.status, artifactSha256: registration.artifact.contentSha256, reused: registration.reused },
        { id: "wireframe", status: wireframe.status, artifactSha256: wireframeStage.artifact.contentSha256, reused: wireframeStage.reused },
        { id: "iterative-sketch-repair", status: qaReport.status, artifactSha256: wireframeQa.artifact.contentSha256, reused: wireframeQa.reused },
        { id: "volume-and-facade-model", status: mesh.qa.closedManifoldCandidate ? "closed-manifold-candidate" : "mesh-review-required", artifactSha256: meshStage.artifact.contentSha256, reused: meshStage.reused },
        { id: "geometry-repair", status: surfaceReport.status, artifactSha256: geometryReview.artifact.contentSha256, reused: geometryReview.reused },
        { id: "texture", status: textureReport.status, artifactSha256: textureStage.artifact.contentSha256, reused: textureStage.reused },
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
          texturePixelProjectionPerformed: false,
          textureAtlasBakingPerformed: false,
          automaticSurfaceFillingPerformed: false,
          automaticCoordinateCorrectionPerformed: false,
        },
        stages,
        blockers: [...new Set(blockers)],
        limitations: [
          "Calibration, cross-view feature matching, explicit faces and texture evidence are supplied by the operator and are not independently surveyed by this workflow.",
          "The wireframe repair worker only removes malformed/duplicate edges; it never moves coordinates or invents architecture.",
          "Mesh generation uses explicit triangular faces only. Missing surfaces are not guessed or auto-filled.",
          "Texture stage validates existing image/UV/calibration evidence. It does not project texture pixels or bake a texture atlas.",
          "A clean topology or low reprojection error does not establish real-world dimensions, building identity or geographic accuracy.",
          "Human review, independent dimensional evidence, horizontal control and a defensible vertical datum remain required for map placement and publication.",
        ],
        output: {
          meshVertexCount: mesh.vertices.length,
          meshTriangleCount: mesh.triangles.length,
          meshCandidate: geometryPayload.mesh,
          meshSurfaceReview: surfaceReport,
          textureProjectionReview: textureReport,
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
