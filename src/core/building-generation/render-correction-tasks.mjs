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

function finiteInRange(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function sameCellRanking(supplied, expected) {
  return Array.isArray(supplied) && supplied.length === 4 &&
    supplied.every((cell, index) =>
      cell && cell.cellX === expected[index].cellX && cell.cellY === expected[index].cellY);
}

/**
 * Turn validated 4x4 diagnostics from a 64x64 grayscale preview into at most
 * eight evidence hotspots. Coordinates are normalized image cells, not facade,
 * map, or world coordinates.
 */
function normalizeSpatialHotspots(metrics, label) {
  const pixelSummaryKeys = [
    "spatialCellMaeMedian",
    "spatialCellMaeMaximum",
    "spatialCellMaeMedianGap",
    "highestDifferenceCells",
  ];
  const edgeSummaryKeys = [
    "localEdgeDensityDifferenceMedian",
    "localEdgeDensityDifferenceMaximum",
    "highestEdgeDifferenceCells",
  ];
  const hasPixelSummary = pixelSummaryKeys.some((key) => metrics?.[key] !== undefined);
  const hasEdgeSummary = edgeSummaryKeys.some((key) => metrics?.[key] !== undefined);
  const hasCells = metrics?.spatialCellDiagnostics !== undefined;

  if (!hasPixelSummary && !hasEdgeSummary && !hasCells) return null;
  const fail = () => {
    throw new Error("review-report-similarity-diagnostics-spatial-hotspots-invalid:" + label);
  };
  if ((!hasPixelSummary && !hasEdgeSummary) ||
    !Array.isArray(metrics.spatialCellDiagnostics) ||
    metrics.spatialCellDiagnostics.length !== 16) return fail();

  const cells = metrics.spatialCellDiagnostics.map((cell, index) => {
    const cellX = index % 4;
    const cellY = Math.floor(index / 4);
    if (!cell || typeof cell !== "object" || Array.isArray(cell) ||
      cell.cellX !== cellX || cell.cellY !== cellY ||
      !finiteInRange(cell.meanAbsoluteError, 0, 255) ||
      !finiteInRange(cell.meanSignedLuminanceOffset, -255, 255) ||
      !finiteInRange(cell.localSsim16x16, -1, 1)) return fail();

    const normalized = {
      cellX,
      cellY,
      meanAbsoluteError: cell.meanAbsoluteError,
      meanSignedLuminanceOffset: cell.meanSignedLuminanceOffset,
      localSsim16x16: cell.localSsim16x16,
    };

    if (hasEdgeSummary) {
      const expectedSampleCount = (cellX === 0 || cellX === 3 ? 15 : 16) *
        (cellY === 0 || cellY === 3 ? 15 : 16);
      if (cell.edgeSampleCount !== expectedSampleCount ||
        !Number.isSafeInteger(cell.referenceEdgePixelCount) ||
        cell.referenceEdgePixelCount < 0 || cell.referenceEdgePixelCount > expectedSampleCount ||
        !Number.isSafeInteger(cell.candidateEdgePixelCount) ||
        cell.candidateEdgePixelCount < 0 || cell.candidateEdgePixelCount > expectedSampleCount ||
        !finiteInRange(cell.referenceEdgeDensity, 0, 1) ||
        !finiteInRange(cell.candidateEdgeDensity, 0, 1) ||
        !finiteInRange(cell.edgeDensityAbsoluteDifference, 0, 1)) return fail();
      const referenceDensity = cell.referenceEdgePixelCount / expectedSampleCount;
      const candidateDensity = cell.candidateEdgePixelCount / expectedSampleCount;
      const densityDifference = Math.abs(cell.referenceEdgePixelCount - cell.candidateEdgePixelCount) /
        expectedSampleCount;
      if (Math.abs(cell.referenceEdgeDensity - referenceDensity) > 0.001 ||
        Math.abs(cell.candidateEdgeDensity - candidateDensity) > 0.001 ||
        Math.abs(cell.edgeDensityAbsoluteDifference - densityDifference) > 0.001) return fail();
      Object.assign(normalized, {
        edgeSampleCount: expectedSampleCount,
        referenceEdgePixelCount: cell.referenceEdgePixelCount,
        candidateEdgePixelCount: cell.candidateEdgePixelCount,
        referenceEdgeDensity: cell.referenceEdgeDensity,
        candidateEdgeDensity: cell.candidateEdgeDensity,
        edgeDensityAbsoluteDifference: cell.edgeDensityAbsoluteDifference,
      });
    }
    return normalized;
  });

  const spatialHotspots = {
    coordinateSpace: "normalized-64x64-grayscale-preview-4x4-grid",
    gridSize: 4,
    note: "Image-space screening context only; cells are not mapped facade coordinates and do not identify a confirmed defect.",
    pixelDifference: null,
    edgeStructure: null,
  };

  if (hasPixelSummary) {
    const maeValues = cells.map((cell) => cell.meanAbsoluteError);
    const expectedMedian = median(maeValues);
    const expectedMaximum = Math.max(...maeValues);
    const expectedGap = expectedMaximum - expectedMedian;
    const expectedRanking = [...cells]
      .sort((left, right) => right.meanAbsoluteError - left.meanAbsoluteError ||
        left.cellY - right.cellY || left.cellX - right.cellX)
      .slice(0, 4);
    if (!finiteInRange(metrics.spatialCellMaeMedian, 0, 255) ||
      !finiteInRange(metrics.spatialCellMaeMaximum, 0, 255) ||
      !finiteInRange(metrics.spatialCellMaeMedianGap, 0, 255) ||
      Math.abs(metrics.spatialCellMaeMedian - expectedMedian) > 0.02 ||
      Math.abs(metrics.spatialCellMaeMaximum - expectedMaximum) > 0.02 ||
      Math.abs(metrics.spatialCellMaeMedianGap - expectedGap) > 0.03 ||
      !sameCellRanking(metrics.highestDifferenceCells, expectedRanking)) return fail();

    spatialHotspots.pixelDifference = {
      medianMeanAbsoluteError: metrics.spatialCellMaeMedian,
      maximumMeanAbsoluteError: metrics.spatialCellMaeMaximum,
      maximumAboveMedian: metrics.spatialCellMaeMedianGap,
      highestDifferenceCells: expectedRanking.map((cell) => ({
        cellX: cell.cellX,
        cellY: cell.cellY,
        meanAbsoluteError: cell.meanAbsoluteError,
        meanSignedLuminanceOffset: cell.meanSignedLuminanceOffset,
        localSsim16x16: cell.localSsim16x16,
      })),
    };
  }

  if (hasEdgeSummary) {
    const edgeDifferences = cells.map((cell) => cell.edgeDensityAbsoluteDifference);
    const expectedMedian = median(edgeDifferences);
    const expectedMaximum = Math.max(...edgeDifferences);
    const expectedRanking = [...cells]
      .sort((left, right) => right.edgeDensityAbsoluteDifference - left.edgeDensityAbsoluteDifference ||
        left.cellY - right.cellY || left.cellX - right.cellX)
      .slice(0, 4);
    if (!finiteInRange(metrics.localEdgeDensityDifferenceMedian, 0, 1) ||
      !finiteInRange(metrics.localEdgeDensityDifferenceMaximum, 0, 1) ||
      Math.abs(metrics.localEdgeDensityDifferenceMedian - expectedMedian) > 0.001 ||
      Math.abs(metrics.localEdgeDensityDifferenceMaximum - expectedMaximum) > 0.001 ||
      !sameCellRanking(metrics.highestEdgeDifferenceCells, expectedRanking)) return fail();

    spatialHotspots.edgeStructure = {
      medianAbsoluteEdgeDensityDifference: metrics.localEdgeDensityDifferenceMedian,
      maximumAbsoluteEdgeDensityDifference: metrics.localEdgeDensityDifferenceMaximum,
      highestEdgeDifferenceCells: expectedRanking.map((cell) => ({
        cellX: cell.cellX,
        cellY: cell.cellY,
        edgeDensityAbsoluteDifference: cell.edgeDensityAbsoluteDifference,
        referenceEdgeDensity: cell.referenceEdgeDensity,
        candidateEdgeDensity: cell.candidateEdgeDensity,
        referenceEdgePixelCount: cell.referenceEdgePixelCount,
        candidateEdgePixelCount: cell.candidateEdgePixelCount,
      })),
    };
  }

  return spatialHotspots;
}

function normalizeOptionalDiagnosticMetrics(metrics, label) {
  const ranges = {
    medianCandidateMinusReferenceLuminanceOffset: [-255, 255],
    luminanceOffsetNormalizedMeanAbsoluteError: [0, 255],
    luminanceOffsetNormalizedRootMeanSquaredError: [0, 255],
    luminanceOffsetNormalizedSsim8x8: [-1, 1],
    luminanceOffsetNormalizedMaeReductionPercent: [0, 100.1],
    edgeDensityAbsoluteDifference: [0, 1],
    edgeOrientationHistogramDistance: [0, 1],
    spatialEdgeDistributionDistance: [0, 1],
    activeEdgeCellJaccardDistance: [0, 1],
    referenceSpatialEdgeCoverage: [0, 1],
    candidateSpatialEdgeCoverage: [0, 1],
  };
  const normalized = {};
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (metrics?.[key] === undefined) continue;
    if (!finiteInRange(metrics[key], min, max)) {
      throw new Error("review-report-similarity-diagnostics-invalid:" + label);
    }
    normalized[key] = metrics[key];
  }
  if (metrics?.candidateToReferenceSharpnessRatio !== undefined) {
    const ratio = metrics.candidateToReferenceSharpnessRatio;
    if (ratio !== null && !finiteInRange(ratio, 0, 1e15)) {
      throw new Error("review-report-similarity-diagnostics-invalid:" + label);
    }
    normalized.candidateToReferenceSharpnessRatio = ratio;
  }
  return normalized;
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

  const normalizedSpatialHotspots = normalizeSpatialHotspots(metrics, label);
  const optionalMetrics = normalizeOptionalDiagnosticMetrics(metrics, label);
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
      ...optionalMetrics,
    },
    comparability: {
      aspectRatioDifferencePercent: comparability.aspectRatioDifferencePercent,
      aspectRatioWithinScreeningThreshold: comparability.aspectRatioWithinScreeningThreshold,
      sameFacadeConfirmedByTool: false,
      cameraPoseAlignmentVerifiedByTool: false,
    },
    spatialHotspots: normalizedSpatialHotspots,
    warnings: [...value.warnings],
    automaticMatch: false,
  };
}

function hasHumanConfirmedOutcome(comparison) {
  if (!comparison || (comparison.outcome !== "mismatch" && comparison.outcome !== "partial")) return false;
  return nonEmptyString(comparison.reviewer) &&
    nonEmptyString(comparison.notes) &&
    nonEmptyString(comparison.reviewedAt) &&
    /^\d{4}-\d{2}-\d{2}T/.test(comparison.reviewedAt) &&
    Number.isFinite(Date.parse(comparison.reviewedAt));
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
    const similarityDiagnostics = normalizeSimilarityDiagnostics(comparison?.similarityDiagnostics, comparison);
    const humanReviewConfirmed = hasHumanConfirmedOutcome(comparison);
    tasks.push({
      id,
      buildingId: reviewReport.buildingId,
      kind,
      priority,
      status: "open",
      title,
      action,
      correctionRequest,
      humanReviewConfirmed,
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
        similarityDiagnostics,
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

    if ((comparison.outcome === "mismatch" || comparison.outcome === "partial") &&
      !hasHumanConfirmedOutcome(comparison)) {
      throw new Error("review-report-human-confirmation-missing:" + comparison.viewId);
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
    // "match" is recorded evidence only; diagnostics never create tasks or alter outcomes.
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
      withSpatialHotspots: tasks.filter((task) =>
        task.evidence.similarityDiagnostics?.spatialHotspots !== null &&
        task.evidence.similarityDiagnostics?.spatialHotspots !== undefined).length,
      humanConfirmedCorrectionTasks: tasks.filter((task) =>
        task.kind === "model-correction-review" && task.humanReviewConfirmed).length,
      diagnosticsCreateTasks: false,
      automaticPriorityChanges: false,
    },
    tasks,
    automationPolicy: {
      geometryOrTextureEditsApplied: false,
      reviewerJudgementReinterpreted: false,
      diagnosticsCreateTasks: false,
      humanConfirmationRequiredForCorrectionTasks: true,
      publicationEligible: false,
      note: "Tasks are traceable follow-ups, not automatic repairs. Only human-confirmed mismatch/partial outcomes create correction-review tasks; diagnostics provide bounded image-space context and never create tasks, reinterpret reviewer outcomes, or certify publication eligibility.",
    },
  };
}
