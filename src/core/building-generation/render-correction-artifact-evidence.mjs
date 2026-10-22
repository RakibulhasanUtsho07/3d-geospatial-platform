import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { analyzeGlbQuality } from "./glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "./glb-texture-binding-qa.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

export async function readRegularEvidenceFile(filePath, label) {
  if (!nonEmptyString(filePath)) throw new TypeError(label + " path is required");
  const details = await lstat(filePath);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(label + " must be a regular file, not a symlink or directory");
  }
  const bytes = await readFile(filePath);
  if (bytes.length < 1) throw new Error(label + " must not be empty");
  return bytes;
}

/**
 * Hash real evidence files and independently recompute geometry/texture QA from
 * the exact candidate GLB bytes. A JSON hash is accepted only when the file body
 * equals the report reproducibly computed from that candidate.
 */
export async function inspectRenderCorrectionArtifactEvidence({
  candidateModelPath,
  renderManifestPath,
  geometryQaReportPath,
  textureQaReportPath,
  reviewReport,
}) {
  const [candidateModelBytes, renderManifestBytes, geometryQaBytes, textureQaBytes] = await Promise.all([
    readRegularEvidenceFile(candidateModelPath, "candidate model"),
    readRegularEvidenceFile(renderManifestPath, "render manifest"),
    readRegularEvidenceFile(geometryQaReportPath, "geometry QA report"),
    readRegularEvidenceFile(textureQaReportPath, "texture QA report"),
  ]);

  const candidateGlbSha256 = sha256(candidateModelBytes);
  const renderManifestSha256 = sha256(renderManifestBytes);
  if (candidateGlbSha256.toLowerCase() !== reviewReport?.provenance?.sourceModelSha256?.toLowerCase?.()) {
    throw new Error("artifact-candidate-model-hash-does-not-match-review-report");
  }
  if (renderManifestSha256.toLowerCase() !== reviewReport?.provenance?.renderManifestSha256?.toLowerCase?.()) {
    throw new Error("artifact-render-manifest-hash-does-not-match-review-report");
  }

  let renderManifest;
  let suppliedGeometryQa;
  let suppliedTextureQa;
  try {
    renderManifest = JSON.parse(renderManifestBytes.toString("utf8"));
    suppliedGeometryQa = JSON.parse(geometryQaBytes.toString("utf8"));
    suppliedTextureQa = JSON.parse(textureQaBytes.toString("utf8"));
  } catch {
    throw new Error("artifact-evidence-json-invalid");
  }
  if (renderManifest?.schemaVersion !== "1.0.0" ||
    renderManifest?.engine !== "building-render-review-manifest-v1" ||
    renderManifest?.valid !== true ||
    renderManifest?.modelSha256?.toLowerCase?.() !== candidateGlbSha256.toLowerCase()) {
    throw new Error("artifact-render-manifest-does-not-bind-to-candidate-model");
  }

  const geometryQa = JSON.parse(JSON.stringify(analyzeGlbQuality(candidateModelBytes)));
  if (!isDeepStrictEqual(suppliedGeometryQa, geometryQa)) {
    throw new Error("artifact-geometry-qa-does-not-match-recomputed-candidate-report");
  }

  const textureQa = JSON.parse(JSON.stringify(reviewGlbTextureBindings(candidateModelBytes)));
  if (!isDeepStrictEqual(suppliedTextureQa, textureQa)) {
    throw new Error("artifact-texture-qa-does-not-match-recomputed-candidate-report");
  }

  return {
    candidateModelBytes,
    renderManifestBytes,
    geometryQaBytes,
    textureQaBytes,
    candidateGlbSha256,
    renderManifestSha256,
    geometryQaReportSha256: sha256(geometryQaBytes),
    textureQaReportSha256: sha256(textureQaBytes),
    renderManifest,
    geometryQa,
    textureQa,
    artifactEvidence: {
      validated: true,
      candidateGlbSha256,
      renderManifestSha256,
      geometryQaReportSha256: sha256(geometryQaBytes),
      textureQaReportSha256: sha256(textureQaBytes),
      qaReportsRecomputedFromCandidateModel: true,
    },
  };
}
