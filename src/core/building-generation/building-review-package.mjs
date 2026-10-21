import { createHash } from "node:crypto";
import { REQUIRED_REVIEW_VIEWS } from "./render-review-manifest.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/i;
const requiredArtifactTypes = [
  "candidate-glb",
  "geometry-qa",
  "texture-qa",
  "render-manifest",
  "render-reference-review",
  "correction-task-backlog",
  "correction-verification",
  "release-readiness-report",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isHash = (value) => typeof value === "string" && sha256Pattern.test(value);

function safeRelativePath(value) {
  if (!nonEmptyString(value) || value.includes("\\") || value.startsWith("/")) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}

function assertArtifact(artifact, index) {
  if (!isObject(artifact) || !nonEmptyString(artifact.artifactType) ||
    !safeRelativePath(artifact.relativePath) || !isHash(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) {
    throw new Error("review-package-artifact-invalid:" + index);
  }
}

export function buildBuildingReviewPackageManifest({
  buildingId,
  readinessReport,
  artifacts,
  requiredRenderViews = REQUIRED_REVIEW_VIEWS,
  renderManifestViews = [],
  generatedAt = new Date().toISOString(),
}) {
  if (!nonEmptyString(buildingId)) throw new TypeError("buildingId is required");
  if (!isObject(readinessReport) || readinessReport.schemaVersion !== "1.0.0" ||
    readinessReport.engine !== "building-release-readiness-gate-v1" ||
    readinessReport.buildingId !== buildingId) {
    throw new Error("review-package-release-readiness-report-invalid");
  }
  if (!["ready-for-final-human-review", "ready-for-final-human-review-with-warnings"].includes(readinessReport.status)) {
    throw new Error("cannot-package-blocked-release-candidate");
  }
  if (readinessReport.publicationEligible !== false || readinessReport.finalHumanReviewRequired !== true) {
    throw new Error("review-package-release-policy-invalid");
  }
  if (!Array.isArray(artifacts)) throw new TypeError("artifacts must be an array");
  if (!Array.isArray(renderManifestViews)) throw new TypeError("renderManifestViews must be an array");
  if (!Array.isArray(requiredRenderViews) || !requiredRenderViews.length) {
    throw new TypeError("requiredRenderViews must be a non-empty array");
  }
  if (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) {
    throw new TypeError("generatedAt must be a valid timestamp");
  }

  const paths = new Set();
  const byType = new Map();
  const renderViews = new Map();
  const referenceFiles = new Map();
  const cleanArtifacts = [];

  for (let index = 0; index < artifacts.length; index++) {
    const artifact = artifacts[index];
    assertArtifact(artifact, index);
    if (paths.has(artifact.relativePath)) throw new Error("review-package-duplicate-path:" + artifact.relativePath);
    paths.add(artifact.relativePath);
    if (artifact.contentDigest !== undefined && !isHash(artifact.contentDigest)) {
      throw new Error("review-package-artifact-content-digest-invalid:" + artifact.relativePath);
    }
    byType.set(artifact.artifactType, (byType.get(artifact.artifactType) ?? 0) + 1);

    if (artifact.artifactType === "render-image") {
      if (!nonEmptyString(artifact.viewId) || renderViews.has(artifact.viewId) ||
        !Number.isSafeInteger(artifact.width) || artifact.width < 1 ||
        !Number.isSafeInteger(artifact.height) || artifact.height < 1) {
        throw new Error("review-package-render-image-invalid:" + artifact.relativePath);
      }
      renderViews.set(artifact.viewId, artifact);
    } else if (artifact.artifactType === "reference-image") {
      if (!nonEmptyString(artifact.referenceImageId) || referenceFiles.has(artifact.referenceImageId) ||
        artifact.rightsStatus !== "verified" || !Number.isSafeInteger(artifact.width) || artifact.width < 1 ||
        !Number.isSafeInteger(artifact.height) || artifact.height < 1) {
        throw new Error("review-package-reference-image-invalid-or-rights-unverified:" + artifact.relativePath);
      }
      referenceFiles.set(artifact.referenceImageId, artifact);
    }

    cleanArtifacts.push({
      artifactType: artifact.artifactType,
      relativePath: artifact.relativePath,
      sha256: artifact.sha256.toLowerCase(),
      bytes: artifact.bytes,
      ...(artifact.contentDigest ? { contentDigest: artifact.contentDigest.toLowerCase() } : {}),
      ...(artifact.viewId ? { viewId: artifact.viewId } : {}),
      ...(artifact.referenceImageId ? { referenceImageId: artifact.referenceImageId } : {}),
      ...(artifact.width ? { width: artifact.width } : {}),
      ...(artifact.height ? { height: artifact.height } : {}),
      ...(artifact.rightsStatus ? { rightsStatus: artifact.rightsStatus } : {}),
    });
  }

  for (const artifactType of requiredArtifactTypes) {
    if (byType.get(artifactType) !== 1) {
      throw new Error("review-package-requires-exactly-one-" + artifactType);
    }
  }

  for (const viewId of requiredRenderViews) {
    if (!renderViews.has(viewId)) throw new Error("review-package-required-render-view-missing:" + viewId);
  }

  const readyProvenance = readinessReport.provenance ?? {};
  const expectedDigests = new Map([
    ["render-manifest", { expected: readyProvenance.renderManifestSha256, field: "sha256" }],
    ["render-reference-review", { expected: readyProvenance.renderReferenceReviewSha256, field: "contentDigest" }],
    ["correction-task-backlog", { expected: readyProvenance.correctionTaskBacklogSha256, field: "contentDigest" }],
    ["correction-verification", { expected: readyProvenance.correctionVerificationReportSha256, field: "contentDigest" }],
    ["geometry-qa", { expected: readyProvenance.geometryQaReportSha256, field: "contentDigest" }],
    ["texture-qa", { expected: readyProvenance.textureQaReportSha256, field: "contentDigest" }],
  ]);
  for (const [artifactType, binding] of expectedDigests) {
    const item = artifacts.find((entry) => entry.artifactType === artifactType);
    const actualDigest = item?.[binding.field];
    if (!isHash(binding.expected) || actualDigest?.toLowerCase() !== binding.expected.toLowerCase()) {
      throw new Error("review-package-evidence-digest-mismatch:" + artifactType);
    }
  }
  const candidate = artifacts.find((item) => item.artifactType === "candidate-glb");
  if (candidate?.sha256.toLowerCase() !== readyProvenance.candidateGlbSha256?.toLowerCase?.() &&
    candidate?.sha256.toLowerCase() !== readinessReport.candidateGlbSha256?.toLowerCase?.()) {
    throw new Error("review-package-candidate-glb-hash-mismatch");
  }
  const readinessArtifact = artifacts.find((item) => item.artifactType === "release-readiness-report");
  if (readinessArtifact?.contentDigest !== undefined &&
    readinessArtifact.contentDigest.toLowerCase() !== hash(Buffer.from(JSON.stringify(readinessReport))).toLowerCase()) {
    throw new Error("review-package-readiness-report-digest-mismatch");
  }

  for (const artifact of cleanArtifacts) {
    if (artifact.artifactType === "render-image") {
      const manifestView = renderManifestViews.find((view) => view.id === artifact.viewId);
      if (manifestView && (manifestView.sha256.toLowerCase() !== artifact.sha256 ||
        manifestView.width !== artifact.width || manifestView.height !== artifact.height)) {
        throw new Error("review-package-render-image-evidence-mismatch:" + artifact.viewId);
      }
    }
  }

  const totalBytes = cleanArtifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  return {
    schemaVersion: "1.0.0",
    engine: "building-review-package-v1",
    buildingId,
    packagePurpose: "final-human-release-review",
    generatedAt,
    readiness: {
      status: readinessReport.status,
      sourceCandidateGlbSha256: candidate.sha256.toLowerCase(),
      blockerCount: readinessReport.counts?.blockers ?? null,
      warningCount: readinessReport.counts?.warnings ?? null,
      requiredRenderViews: [...requiredRenderViews],
      finalHumanReviewRequired: true,
      publicationEligible: false,
    },
    counts: {
      artifacts: cleanArtifacts.length,
      renderImages: renderViews.size,
      referenceImages: referenceFiles.size,
      totalBytes,
    },
    artifacts: cleanArtifacts,
    policy: {
      candidateModified: false,
      assetPublished: false,
      referenceRightsRequired: "verified",
      missingEvidenceAllowed: false,
      finalHumanReviewRequired: true,
      publicationEligible: false,
      note: "This evidence package is for a human release reviewer. It is not publication approval and is not an independent proof of architectural or heritage accuracy.",
    },
  };
}
