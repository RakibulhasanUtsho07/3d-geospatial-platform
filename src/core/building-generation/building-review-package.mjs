import { createHash } from "node:crypto";
import { REQUIRED_REVIEW_VIEWS } from "./render-review-manifest.mjs";
import { canonicalJson } from "./generation-artifact-receipt.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/i;
const requiredArtifactTypes = [
  "candidate-glb",
  "geometry-qa",
  "texture-qa",
  "render-manifest",
  "render-reference-review",
  "correction-task-backlog",
  "correction-verification",
  "accuracy-evidence",
  "release-readiness-report",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isHash = (value) => typeof value === "string" && sha256Pattern.test(value);
const SURVEY_RECORD_TYPE = "single-image-survey-observation-record";
const MAX_SURVEY_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_SURVEY_RECORD_TOTAL_BYTES = 64 * 1024 * 1024;

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
  singleImageEvidence = null,
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

  const singleImageArtifactTypes = [
    "single-image-smoke-report",
    "single-image-generation-artifact-receipt",
    "single-image-workflow-report",
    "single-image-control-point-manifest",
  ];
  const singleImageCounts = new Map(singleImageArtifactTypes.map((type) => [type, byType.get(type) ?? 0]));
  const singleImageArtifactCount = [...singleImageCounts.values()].reduce((sum, count) => sum + count, 0);
  const surveyRecordArtifacts = artifacts.filter((item) => item.artifactType === SURVEY_RECORD_TYPE);
  const surveyRecordInventory = surveyRecordArtifacts.map((item) => {
    const filename = item.relativePath.split("/").at(-1) ?? "";
    const observationId = filename.endsWith(".record") ? filename.slice(0, -7) : "";
    return { observationId, relativePath: item.relativePath, bytes: item.bytes, sha256: item.sha256.toLowerCase() };
  }).sort((a, b) => a.observationId.localeCompare(b.observationId));
  const surveyRecordIds = new Set(surveyRecordInventory.map((item) => item.observationId));
  const surveyRecordPathsValid = surveyRecordInventory.every((item) =>
    /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(item.observationId) &&
    item.relativePath === "evidence/survey-observations/" + item.observationId + ".record" &&
    item.bytes <= MAX_SURVEY_RECORD_BYTES
  ) && surveyRecordIds.size === surveyRecordInventory.length;
  const surveyRecordTotalBytes = surveyRecordArtifacts.reduce((sum, item) => sum + item.bytes, 0);
  const surveyRecordInventorySha256 = hash(Buffer.from(canonicalJson(surveyRecordInventory), "utf8"));
  if (singleImageEvidence === null) {
    if (singleImageArtifactCount !== 0 || surveyRecordArtifacts.length !== 0) {
      throw new Error("review-package-single-image-evidence-metadata-missing");
    }
  } else {
    const hasVerticalCalibration = ["1.1.0", "1.2.0", "1.3.0"].includes(singleImageEvidence?.schemaVersion);
    const hasIndependentCheckpoints = ["1.2.0", "1.3.0"].includes(singleImageEvidence?.schemaVersion);
    const hasByteVerifiedSurveyRecords = singleImageEvidence?.schemaVersion === "1.3.0";
    const surveyRecordMetadataValid = hasByteVerifiedSurveyRecords
      ? surveyRecordPathsValid &&
        surveyRecordArtifacts.length === singleImageEvidence.checkpointCount &&
        singleImageEvidence.surveyObservationRecordCount === surveyRecordArtifacts.length &&
        Number.isSafeInteger(singleImageEvidence.surveyObservationRecordTotalBytes) &&
        singleImageEvidence.surveyObservationRecordTotalBytes === surveyRecordTotalBytes &&
        surveyRecordTotalBytes > 0 && surveyRecordTotalBytes <= MAX_SURVEY_RECORD_TOTAL_BYTES &&
        isHash(singleImageEvidence.surveyObservationRecordInventorySha256) &&
        singleImageEvidence.surveyObservationRecordInventorySha256 === surveyRecordInventorySha256
      : surveyRecordArtifacts.length === 0 &&
        !Object.keys(singleImageEvidence).some((key) => key.startsWith("surveyObservationRecord"));
    const verticalMetadataValid = hasVerticalCalibration
      ? singleImageEvidence.verticalDatum === "EPSG:4979-ellipsoidal" &&
        singleImageEvidence.verticalStatus === "calibrated-needs-human-review" &&
        isHash(singleImageEvidence.verticalEvidenceSha256) &&
        /^WGS 84 \([A-Za-z0-9._ -]{1,40}\)$/.test(singleImageEvidence.verticalReferenceFrame ?? "") &&
        Number.isFinite(singleImageEvidence.verticalCoordinateEpoch) &&
        singleImageEvidence.verticalCoordinateEpoch >= 1980 && singleImageEvidence.verticalCoordinateEpoch <= 2100 &&
        Number.isFinite(singleImageEvidence.verticalHeightOffsetM) &&
        Number.isFinite(singleImageEvidence.verticalRmsErrorM) && singleImageEvidence.verticalRmsErrorM >= 0 &&
        Number.isFinite(singleImageEvidence.verticalMaxResidualM) && singleImageEvidence.verticalMaxResidualM >= 0 &&
        Number.isSafeInteger(singleImageEvidence.verticalControlPointCount) && singleImageEvidence.verticalControlPointCount >= 3
      : singleImageEvidence?.schemaVersion === "1.0.0" &&
        singleImageEvidence.verticalDatum === "not-solved" &&
        !Object.hasOwn(singleImageEvidence, "verticalEvidenceSha256");
    const checkpointMetadataValid = hasIndependentCheckpoints
      ? singleImageEvidence.checkpointValidationStatus === "validated-needs-human-review" &&
        isHash(singleImageEvidence.checkpointEvidenceSha256) &&
        /^WGS 84 \([A-Za-z0-9._ -]{1,40}\)$/.test(singleImageEvidence.checkpointReferenceFrame ?? "") &&
        Number.isFinite(singleImageEvidence.checkpointCoordinateEpoch) &&
        singleImageEvidence.checkpointCoordinateEpoch >= 1980 &&
        singleImageEvidence.checkpointCoordinateEpoch <= 2100 &&
        Number.isSafeInteger(singleImageEvidence.checkpointCount) &&
        singleImageEvidence.checkpointCount >= 6 &&
        ["checkpointHorizontalRmsErrorM", "checkpointHorizontalMaxResidualM",
          "checkpointVerticalRmsErrorM", "checkpointVerticalMaxResidualM",
          "checkpoint3dRmsErrorM", "checkpoint3dMaxResidualM"].every((key) =>
          Number.isFinite(singleImageEvidence[key]) && singleImageEvidence[key] >= 0)
      : !Object.keys(singleImageEvidence).some((key) => key.startsWith("checkpoint"));
    if (!isObject(singleImageEvidence) || !["1.0.0", "1.1.0", "1.2.0", "1.3.0"].includes(singleImageEvidence.schemaVersion) ||
        !nonEmptyString(singleImageEvidence.jobId) || !nonEmptyString(singleImageEvidence.sourceId) ||
        !isHash(singleImageEvidence.sourceSha256) || !isHash(singleImageEvidence.candidateGlbSha256) ||
        !isHash(singleImageEvidence.controlPointManifestSha256) || !isHash(singleImageEvidence.smokeReportSha256) ||
        !isHash(singleImageEvidence.generationArtifactReceiptSha256) || !isHash(singleImageEvidence.workflowReportSha256) ||
        singleImageEvidence.buildingId !== buildingId ||
        singleImageEvidence.georeferenceStatus !== "calibrated-needs-human-review" ||
        !verticalMetadataValid || !checkpointMetadataValid || !surveyRecordMetadataValid ||
        singleImageEvidence.mapReady !== false || singleImageEvidence.publicationEligible !== false ||
        singleImageEvidence.automaticApproval !== false ||
        singleImageEvidence.candidateGlbSha256.toLowerCase() !==
          artifacts.find((item) => item.artifactType === "candidate-glb")?.sha256.toLowerCase()) {
      throw new Error("review-package-single-image-evidence-metadata-invalid");
    }
    for (const [type, count] of singleImageCounts) {
      if (count !== 1) throw new Error("review-package-requires-exactly-one-" + type);
    }
    const expectedDigests = new Map([
      ["single-image-smoke-report", singleImageEvidence.smokeReportSha256],
      ["single-image-generation-artifact-receipt", singleImageEvidence.generationArtifactReceiptSha256],
      ["single-image-workflow-report", singleImageEvidence.workflowReportSha256],
      ["single-image-control-point-manifest", singleImageEvidence.controlPointManifestSha256],
    ]);
    for (const [type, expected] of expectedDigests) {
      const actual = artifacts.find((entry) => entry.artifactType === type);
      if (actual?.sha256.toLowerCase() !== expected.toLowerCase()) {
        throw new Error("review-package-single-image-evidence-digest-mismatch:" + type);
      }
    }
  }

  const readyProvenance = readinessReport.provenance ?? {};
  const expectedDigests = new Map([
    ["render-manifest", { expected: readyProvenance.renderManifestSha256, field: "sha256" }],
    ["render-reference-review", { expected: readyProvenance.renderReferenceReviewSha256, field: "contentDigest" }],
    ["correction-task-backlog", { expected: readyProvenance.correctionTaskBacklogSha256, field: "contentDigest" }],
    ["correction-verification", { expected: readyProvenance.correctionVerificationReportSha256, field: "contentDigest" }],
    ["accuracy-evidence", { expected: readyProvenance.accuracyEvidenceSha256, field: "contentDigest" }],
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
    ...(singleImageEvidence ? { singleImageEvidence: {
      schemaVersion: singleImageEvidence.schemaVersion,
      jobId: singleImageEvidence.jobId,
      buildingId: singleImageEvidence.buildingId,
      sourceId: singleImageEvidence.sourceId,
      sourceSha256: singleImageEvidence.sourceSha256.toLowerCase(),
      candidateGlbSha256: singleImageEvidence.candidateGlbSha256.toLowerCase(),
      georeferenceStatus: singleImageEvidence.georeferenceStatus,
      controlPointManifestSha256: singleImageEvidence.controlPointManifestSha256.toLowerCase(),
      smokeReportSha256: singleImageEvidence.smokeReportSha256.toLowerCase(),
      generationArtifactReceiptSha256: singleImageEvidence.generationArtifactReceiptSha256.toLowerCase(),
      workflowReportSha256: singleImageEvidence.workflowReportSha256.toLowerCase(),
      verticalDatum: singleImageEvidence.verticalDatum,
      ...(["1.1.0", "1.2.0", "1.3.0"].includes(singleImageEvidence.schemaVersion) ? {
        verticalStatus: singleImageEvidence.verticalStatus,
        verticalEvidenceSha256: singleImageEvidence.verticalEvidenceSha256.toLowerCase(),
        verticalReferenceFrame: singleImageEvidence.verticalReferenceFrame,
        verticalCoordinateEpoch: singleImageEvidence.verticalCoordinateEpoch,
        verticalHeightOffsetM: singleImageEvidence.verticalHeightOffsetM,
        verticalRmsErrorM: singleImageEvidence.verticalRmsErrorM,
        verticalMaxResidualM: singleImageEvidence.verticalMaxResidualM,
        verticalControlPointCount: singleImageEvidence.verticalControlPointCount,
      } : {}),
      ...(["1.2.0", "1.3.0"].includes(singleImageEvidence.schemaVersion) ? {
        checkpointValidationStatus: singleImageEvidence.checkpointValidationStatus,
        checkpointEvidenceSha256: singleImageEvidence.checkpointEvidenceSha256.toLowerCase(),
        checkpointReferenceFrame: singleImageEvidence.checkpointReferenceFrame,
        checkpointCoordinateEpoch: singleImageEvidence.checkpointCoordinateEpoch,
        checkpointCount: singleImageEvidence.checkpointCount,
        checkpointHorizontalRmsErrorM: singleImageEvidence.checkpointHorizontalRmsErrorM,
        checkpointHorizontalMaxResidualM: singleImageEvidence.checkpointHorizontalMaxResidualM,
        checkpointVerticalRmsErrorM: singleImageEvidence.checkpointVerticalRmsErrorM,
        checkpointVerticalMaxResidualM: singleImageEvidence.checkpointVerticalMaxResidualM,
        checkpoint3dRmsErrorM: singleImageEvidence.checkpoint3dRmsErrorM,
        checkpoint3dMaxResidualM: singleImageEvidence.checkpoint3dMaxResidualM,
      } : {}),
      ...(singleImageEvidence.schemaVersion === "1.3.0" ? {
        surveyObservationRecordCount: singleImageEvidence.surveyObservationRecordCount,
        surveyObservationRecordTotalBytes: singleImageEvidence.surveyObservationRecordTotalBytes,
        surveyObservationRecordInventorySha256: singleImageEvidence.surveyObservationRecordInventorySha256.toLowerCase(),
      } : {}),
      mapReady: false,
      publicationEligible: false,
      automaticApproval: false,
    } } : {}),
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
