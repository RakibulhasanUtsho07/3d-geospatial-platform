import { createHash } from "node:crypto";

const sha256Pattern = /^[a-f0-9]{64}$/i;
const supportedOutcomes = new Set(["pending", "match", "partial", "mismatch", "not-comparable"]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableTaskId({ sourceModelSha256, renderManifestSha256, viewId, referenceImageId, kind }) {
  const key = JSON.stringify([sourceModelSha256, renderManifestSha256, viewId, referenceImageId ?? null, kind]);
  return "rrt-" + digest(key).slice(0, 20);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSimilarityDiagnostics(value, comparison) {
  if (value === undefined || value === null) return null;
  const label = comparison?.viewId + ":" + comparison?.referenceImageId;
  if (!comparison || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("review-report-similarity-diagnostics-invalid:" + label);
  }

  const metrics = value.metrics;
  const comparability = value.comparability;
  const validMetricNumber = (number, min, max) =>
    typeof number === "number" && Number.isFinite(number) && number >= min && number <= max;
  const validPsnr = metrics?.psnrDb === null ||
    typeof metrics?.psnrDb === "number" && Number.isFinite(metrics.psnrDb) && metrics.psnrDb >= 0;
  const valid =
    value.engine === "render-image-similarity-diagnostics-v1" &&
    value.status === "diagnostics-computed" &&
    value.automaticMatch === false &&
    sha256Pattern.test(value.reportSha256 ?? "") &&
    sha256Pattern.test(value.renderSha256 ?? "") &&
    sha256Pattern.test(value.referenceSha256 ?? "") &&
    value.renderSha256.toLowerCase() === comparison.renderSha256.toLowerCase() &&
    value.referenceSha256.toLowerCase() === comparison.referenceSha256.toLowerCase() &&
    nonEmptyString(value.interpretation) &&
    validMetricNumber(metrics?.meanAbsoluteError, 0, 255) &&
    validMetricNumber(metrics?.rootMeanSquaredError, 0, 255) &&
    validPsnr &&
    validMetricNumber(metrics?.localSsim8x8, -1, 1) &&
    Number.isSafeInteger(metrics?.differenceHashHammingDistance) &&
    metrics.differenceHashHammingDistance >= 0 &&
    metrics.differenceHashHammingDistance <= 64 &&
    validMetricNumber(comparability?.aspectRatioDifferencePercent, 0, Number.MAX_SAFE_INTEGER) &&
    typeof comparability?.aspectRatioWithinScreeningThreshold === "boolean" &&
    comparability.sameFacadeConfirmedByTool === false &&
    comparability.cameraPoseAlignmentVerifiedByTool === false &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string");
  if (!valid) {
    throw new Error("review-report-similarity-diagnostics-invalid:" + label);
  }

  return {
    reportSha256: value.reportSha256.toLowerCase(),
    engine: value.engine,
    status: value.status,
    interpretation: value.interpretation,
    renderSha256: value.renderSha256.toLowerCase(),
    referenceSha256: value.referenceSha256.toLowerCase(),
    metrics: {
      meanAbsoluteError: metrics.meanAbsoluteError,
      rootMeanSquaredError: metrics.rootMeanSquaredError,
      psnrDb: metrics.psnrDb,
      localSsim8x8: metrics.localSsim8x8,
      differenceHashHammingDistance: metrics.differenceHashHammingDistance,
    },
    comparability: {
      aspectRatioDifferencePercent: comparability.aspectRatioDifferencePercent,
      aspectRatioWithinScreeningThreshold: comparability.aspectRatioWithinScreeningThreshold,
      sameFacadeConfirmedByTool: false,
      cameraPoseAlignmentVerifiedByTool: false,
    },
    warnings: [...value.warnings],
    automaticMatch: false,
  };
}

/**
 * Turn a valid, human-authored render/reference review report into a deterministic
 * task backlog. This function never edits geometry, textures, UVs or source files.
 */
export function createRenderCorrectionTasks(reviewReport) {
  if (!reviewReport || typeof reviewReport !== "object" || Array.isArray(reviewReport)) {
    throw new TypeError("reviewReport must be an object");
  }
  if (reviewReport.engine !== "render-reference-review-v1" || reviewReport.schemaVersion !== "1.0.0") {
    throw new Error("unsupported-render-reference-review-report");
  }
  if (reviewReport.valid !== true || reviewReport.reviewStatus === "invalid-review-package") {
    throw new Error("cannot-create-tasks-from-invalid-review-report");
  }
  if (!nonEmptyString(reviewReport.buildingId)) throw new Error("review-report-building-id-missing");

  const sourceModelSha256 = reviewReport.provenance?.sourceModelSha256;
  const renderManifestSha256 = reviewReport.provenance?.renderManifestSha256;
  if (!sha256Pattern.test(sourceModelSha256 ?? "")) throw new Error("review-report-source-model-sha256-invalid");
  if (!sha256Pattern.test(renderManifestSha256 ?? "")) throw new Error("review-report-render-manifest-sha256-invalid");
  if (!Array.isArray(reviewReport.comparisons)) throw new Error("review-report-comparisons-missing");

  const reviewReportSha256 = digest(JSON.stringify(reviewReport));
  const tasks = [];
  const seen = new Set();

  function addTask({ kind, priority, viewId, referenceImageId = null, comparison = null, title, action, correctionRequest = null }) {
    const id = stableTaskId({ sourceModelSha256, renderManifestSha256, viewId, referenceImageId, kind });
    if (seen.has(id)) return;
    seen.add(id);
    tasks.push({
      id,
      buildingId: reviewReport.buildingId,
      kind,
      priority,
      status: "open",
      title,
      action,
      correctionRequest,
      evidence: {
        reviewReportSha256,
        sourceModelSha256,
        renderManifestSha256,
        viewId,
        renderFilename: comparison?.renderFilename ?? null,
        renderSha256: comparison?.renderSha256 ?? null,
        referenceImageId,
        referenceSha256: comparison?.referenceSha256 ?? null,
        comparisonBasis: comparison?.comparisonBasis ?? null,
        outcome: comparison?.outcome ?? null,
        reviewer: comparison?.reviewer ?? null,
        reviewedAt: comparison?.reviewedAt ?? null,
        notes: comparison?.notes ?? null,
        similarityDiagnostics: normalizeSimilarityDiagnostics(comparison?.similarityDiagnostics, comparison),
      },
      nextChecks: [
        "Open the exact render and reference identified by the recorded hashes; confirm the comparison basis.",
        "Write a specific, human-approved correction proposal before changing geometry, scale, orientation, texture projection or UVs.",
        "Apply the approved change in the modelling workflow, then rerun geometry/UV QA and regenerate the render set.",
        "Create a new render/reference review against the new hashes; do not mark this task verified from the old report.",
      ],
      verificationStatus: "not-verified",
      autoApplied: false,
      publicationEligible: false,
    });
  }

  for (const comparison of reviewReport.comparisons) {
    if (!comparison || !nonEmptyString(comparison.viewId) ||
      !nonEmptyString(comparison.referenceImageId) || !supportedOutcomes.has(comparison.outcome)) {
      throw new Error("review-report-comparison-invalid");
    }
    if (!sha256Pattern.test(comparison.renderSha256 ?? "") ||
      !sha256Pattern.test(comparison.referenceSha256 ?? "")) {
      throw new Error("review-report-comparison-evidence-hash-invalid:" + comparison.viewId);
    }

    if (comparison.outcome === "mismatch" || comparison.outcome === "partial") {
      const isMismatch = comparison.outcome === "mismatch";
      addTask({
        kind: "model-correction-review",
        priority: isMismatch ? "high" : "medium",
        viewId: comparison.viewId,
        referenceImageId: comparison.referenceImageId,
        comparison,
        title: (isMismatch ? "Resolve render/reference mismatch: " : "Review partial render/reference match: ") + comparison.viewId,
        action: "review-and-propose-change",
        correctionRequest: nonEmptyString(comparison.correctionRequest)
          ? comparison.correctionRequest.trim()
          : "No structured correction request was recorded. Inspect the evidence pair and write a specific proposal before modifying the model.",
      });
    } else if (comparison.outcome === "pending") {
      addTask({
        kind: "complete-reference-review",
        priority: "medium",
        viewId: comparison.viewId,
        referenceImageId: comparison.referenceImageId,
        comparison,
        title: "Complete human comparison: " + comparison.viewId,
        action: "inspect-pair-and-record-review",
        correctionRequest: null,
      });
    } else if (comparison.outcome === "not-comparable") {
      addTask({
        kind: "resolve-reference-comparability",
        priority: "medium",
        viewId: comparison.viewId,
        referenceImageId: comparison.referenceImageId,
        comparison,
        title: "Resolve reference comparability: " + comparison.viewId,
        action: "obtain-comparable-reference-or-document-limitation",
        correctionRequest: null,
      });
    }
    // "match" is recorded evidence only; it deliberately creates no correction task.
  }

  if (reviewReport.viewsWithoutComparisons !== undefined && !Array.isArray(reviewReport.viewsWithoutComparisons)) {
    throw new Error("review-report-views-without-comparisons-invalid");
  }
  for (const viewId of reviewReport.viewsWithoutComparisons ?? []) {
    if (!nonEmptyString(viewId)) throw new Error("review-report-uncovered-view-id-invalid");
    addTask({
      kind: "add-reference-comparison",
      priority: "medium",
      viewId,
      title: "Add reference comparison: " + viewId,
      action: "select-a-suitable-reference-and-record-human-review",
      correctionRequest: "This render view has no comparison in the report. Do not infer a mismatch; add suitable evidence and perform a human review.",
    });
  }

  const kindCounts = {};
  for (const task of tasks) kindCounts[task.kind] = (kindCounts[task.kind] ?? 0) + 1;

  return {
    schemaVersion: "1.0.0",
    engine: "render-review-correction-tasks-v1",
    buildingId: reviewReport.buildingId,
    sourceReviewStatus: reviewReport.reviewStatus,
    createdFromReviewReportSha256: reviewReportSha256,
    provenance: {
      sourceModelSha256,
      renderManifestSha256,
    },
    counts: {
      total: tasks.length,
      open: tasks.length,
      highPriority: tasks.filter((task) => task.priority === "high").length,
      mediumPriority: tasks.filter((task) => task.priority === "medium").length,
      byKind: kindCounts,
    },
    similarityDiagnosticsSummary: {
      attachedToTasks: tasks.filter((task) => task.evidence.similarityDiagnostics !== null).length,
      withWarnings: tasks.filter((task) => (task.evidence.similarityDiagnostics?.warnings.length ?? 0) > 0).length,
      automaticPriorityChanges: false,
    },
    tasks,
    automationPolicy: {
      geometryOrTextureEditsApplied: false,
      reviewerJudgementReinterpreted: false,
      publicationEligible: false,
      note: "Tasks are traceable follow-ups, not automatic repairs. Only a person can approve a correction and a new review report is required for verification.",
    },
  };
}
