import { createHash } from "node:crypto";

const sha256Pattern = /^[a-f0-9]{64}$/i;
const outcomes = new Set(["pending", "match", "partial", "mismatch", "not-comparable"]);
const comparisonBases = new Set(["same-facade-known", "pose-estimated", "context-only", "not-comparable"]);
const taskKinds = new Set([
  "model-correction-review",
  "complete-reference-review",
  "resolve-reference-comparability",
  "add-reference-comparison",
]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validHash(value) {
  return typeof value === "string" && sha256Pattern.test(value);
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

function normalizeDiagnosticHotspots(metrics, label) {
  const pixelKeys = [
    "spatialCellMaeMedian",
    "spatialCellMaeMaximum",
    "spatialCellMaeMedianGap",
    "highestDifferenceCells",
  ];
  const edgeKeys = [
    "localEdgeDensityDifferenceMedian",
    "localEdgeDensityDifferenceMaximum",
    "highestEdgeDifferenceCells",
  ];
  const hasPixel = pixelKeys.some((key) => metrics?.[key] !== undefined);
  const hasEdge = edgeKeys.some((key) => metrics?.[key] !== undefined);
  const hasCells = metrics?.spatialCellDiagnostics !== undefined;
  if (!hasPixel && !hasEdge && !hasCells) return null;

  const fail = () => {
    throw new Error("verification-review-spatial-hotspots-invalid:" + label);
  };
  if ((!hasPixel && !hasEdge) || !Array.isArray(metrics.spatialCellDiagnostics) ||
    metrics.spatialCellDiagnostics.length !== 16) return fail();

  const cells = metrics.spatialCellDiagnostics.map((cell, index) => {
    const cellX = index % 4;
    const cellY = Math.floor(index / 4);
    if (!isObject(cell) || cell.cellX !== cellX || cell.cellY !== cellY ||
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
    if (hasEdge) {
      const edgeSampleCount = (cellX === 0 || cellX === 3 ? 15 : 16) *
        (cellY === 0 || cellY === 3 ? 15 : 16);
      if (cell.edgeSampleCount !== edgeSampleCount ||
        !Number.isSafeInteger(cell.referenceEdgePixelCount) ||
        cell.referenceEdgePixelCount < 0 || cell.referenceEdgePixelCount > edgeSampleCount ||
        !Number.isSafeInteger(cell.candidateEdgePixelCount) ||
        cell.candidateEdgePixelCount < 0 || cell.candidateEdgePixelCount > edgeSampleCount ||
        !finiteInRange(cell.referenceEdgeDensity, 0, 1) ||
        !finiteInRange(cell.candidateEdgeDensity, 0, 1) ||
        !finiteInRange(cell.edgeDensityAbsoluteDifference, 0, 1)) return fail();
      const referenceDensity = cell.referenceEdgePixelCount / edgeSampleCount;
      const candidateDensity = cell.candidateEdgePixelCount / edgeSampleCount;
      const edgeDifference = Math.abs(cell.referenceEdgePixelCount - cell.candidateEdgePixelCount) /
        edgeSampleCount;
      if (Math.abs(cell.referenceEdgeDensity - referenceDensity) > 0.001 ||
        Math.abs(cell.candidateEdgeDensity - candidateDensity) > 0.001 ||
        Math.abs(cell.edgeDensityAbsoluteDifference - edgeDifference) > 0.001) return fail();
      Object.assign(normalized, {
        referenceEdgePixelCount: cell.referenceEdgePixelCount,
        candidateEdgePixelCount: cell.candidateEdgePixelCount,
        referenceEdgeDensity: cell.referenceEdgeDensity,
        candidateEdgeDensity: cell.candidateEdgeDensity,
        edgeDensityAbsoluteDifference: cell.edgeDensityAbsoluteDifference,
      });
    }
    return normalized;
  });

  const result = {
    coordinateSpace: "normalized-64x64-grayscale-preview-4x4-grid",
    gridSize: 4,
    note: "Descriptive image-space context only. Cells are not mapped facade coordinates and do not determine verification status.",
    pixelDifference: null,
    edgeStructure: null,
  };
  if (hasPixel) {
    const values = cells.map((cell) => cell.meanAbsoluteError);
    const calculatedMedian = median(values);
    const calculatedMaximum = Math.max(...values);
    const calculatedGap = calculatedMaximum - calculatedMedian;
    const ranked = [...cells].sort((left, right) =>
      right.meanAbsoluteError - left.meanAbsoluteError ||
      left.cellY - right.cellY || left.cellX - right.cellX).slice(0, 4);
    if (!finiteInRange(metrics.spatialCellMaeMedian, 0, 255) ||
      !finiteInRange(metrics.spatialCellMaeMaximum, 0, 255) ||
      !finiteInRange(metrics.spatialCellMaeMedianGap, 0, 255) ||
      Math.abs(metrics.spatialCellMaeMedian - calculatedMedian) > 0.02 ||
      Math.abs(metrics.spatialCellMaeMaximum - calculatedMaximum) > 0.02 ||
      Math.abs(metrics.spatialCellMaeMedianGap - calculatedGap) > 0.03 ||
      !sameCellRanking(metrics.highestDifferenceCells, ranked)) return fail();
    result.pixelDifference = {
      medianMeanAbsoluteError: metrics.spatialCellMaeMedian,
      maximumMeanAbsoluteError: metrics.spatialCellMaeMaximum,
      maximumAboveMedian: metrics.spatialCellMaeMedianGap,
      highestDifferenceCells: ranked.map((cell) => ({
        cellX: cell.cellX,
        cellY: cell.cellY,
        meanAbsoluteError: cell.meanAbsoluteError,
        meanSignedLuminanceOffset: cell.meanSignedLuminanceOffset,
        localSsim16x16: cell.localSsim16x16,
      })),
    };
  }
  if (hasEdge) {
    const values = cells.map((cell) => cell.edgeDensityAbsoluteDifference);
    const calculatedMedian = median(values);
    const calculatedMaximum = Math.max(...values);
    const ranked = [...cells].sort((left, right) =>
      right.edgeDensityAbsoluteDifference - left.edgeDensityAbsoluteDifference ||
      left.cellY - right.cellY || left.cellX - right.cellX).slice(0, 4);
    if (!finiteInRange(metrics.localEdgeDensityDifferenceMedian, 0, 1) ||
      !finiteInRange(metrics.localEdgeDensityDifferenceMaximum, 0, 1) ||
      Math.abs(metrics.localEdgeDensityDifferenceMedian - calculatedMedian) > 0.001 ||
      Math.abs(metrics.localEdgeDensityDifferenceMaximum - calculatedMaximum) > 0.001 ||
      !sameCellRanking(metrics.highestEdgeDifferenceCells, ranked)) return fail();
    result.edgeStructure = {
      medianAbsoluteEdgeDensityDifference: metrics.localEdgeDensityDifferenceMedian,
      maximumAbsoluteEdgeDensityDifference: metrics.localEdgeDensityDifferenceMaximum,
      highestEdgeDifferenceCells: ranked.map((cell) => ({
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
  return result;
}

function normalizeStoredHotspotList(value, label, kind) {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
  }
  const seen = new Set();
  return value.map((cell) => {
    if (!isObject(cell) || !Number.isSafeInteger(cell.cellX) || cell.cellX < 0 || cell.cellX > 3 ||
      !Number.isSafeInteger(cell.cellY) || cell.cellY < 0 || cell.cellY > 3) {
      throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
    }
    const key = cell.cellX + ":" + cell.cellY;
    if (seen.has(key)) throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
    seen.add(key);
    if (kind === "pixel" &&
      (!finiteInRange(cell.meanAbsoluteError, 0, 255) ||
        !finiteInRange(cell.meanSignedLuminanceOffset, -255, 255) ||
        !finiteInRange(cell.localSsim16x16, -1, 1))) {
      throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
    }
    if (kind === "edge" &&
      (!finiteInRange(cell.edgeDensityAbsoluteDifference, 0, 1) ||
        !finiteInRange(cell.referenceEdgeDensity, 0, 1) ||
        !finiteInRange(cell.candidateEdgeDensity, 0, 1) ||
        !Number.isSafeInteger(cell.referenceEdgePixelCount) ||
        cell.referenceEdgePixelCount < 0 || cell.referenceEdgePixelCount > 256 ||
        !Number.isSafeInteger(cell.candidateEdgePixelCount) ||
        cell.candidateEdgePixelCount < 0 || cell.candidateEdgePixelCount > 256)) {
      throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
    }
    return { ...cell };
  });
}

function normalizeStoredSpatialHotspots(value, label) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) ||
    value.coordinateSpace !== "normalized-64x64-grayscale-preview-4x4-grid" ||
    value.gridSize !== 4 || !nonEmptyString(value.note)) {
    throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
  }
  const result = {
    coordinateSpace: value.coordinateSpace,
    gridSize: 4,
    note: value.note,
    pixelDifference: null,
    edgeStructure: null,
  };
  if (value.pixelDifference !== null && value.pixelDifference !== undefined) {
    const item = value.pixelDifference;
    if (!isObject(item) ||
      !finiteInRange(item.medianMeanAbsoluteError, 0, 255) ||
      !finiteInRange(item.maximumMeanAbsoluteError, 0, 255) ||
      !finiteInRange(item.maximumAboveMedian, 0, 255)) {
      throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
    }
    result.pixelDifference = {
      medianMeanAbsoluteError: item.medianMeanAbsoluteError,
      maximumMeanAbsoluteError: item.maximumMeanAbsoluteError,
      maximumAboveMedian: item.maximumAboveMedian,
      highestDifferenceCells: normalizeStoredHotspotList(item.highestDifferenceCells, label + ":pixel", "pixel"),
    };
  }
  if (value.edgeStructure !== null && value.edgeStructure !== undefined) {
    const item = value.edgeStructure;
    if (!isObject(item) ||
      !finiteInRange(item.medianAbsoluteEdgeDensityDifference, 0, 1) ||
      !finiteInRange(item.maximumAbsoluteEdgeDensityDifference, 0, 1)) {
      throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
    }
    result.edgeStructure = {
      medianAbsoluteEdgeDensityDifference: item.medianAbsoluteEdgeDensityDifference,
      maximumAbsoluteEdgeDensityDifference: item.maximumAbsoluteEdgeDensityDifference,
      highestEdgeDifferenceCells: normalizeStoredHotspotList(item.highestEdgeDifferenceCells, label + ":edge", "edge"),
    };
  }
  if (result.pixelDifference === null && result.edgeStructure === null) {
    throw new Error("verification-backlog-spatial-hotspots-invalid:" + label);
  }
  return result;
}

function summarizeHotspotOverlap(baseline, verification, kind) {
  const section = kind === "pixel" ? "pixelDifference" : "edgeStructure";
  const listKey = kind === "pixel" ? "highestDifferenceCells" : "highestEdgeDifferenceCells";
  const baselineCells = baseline?.[section]?.[listKey] ?? [];
  const verificationCells = verification?.[section]?.[listKey] ?? [];
  if (!baselineCells.length && !verificationCells.length) return null;
  const keyOf = (cell) => cell.cellX + ":" + cell.cellY;
  const baselineKeys = new Set(baselineCells.map(keyOf));
  const verificationKeys = new Set(verificationCells.map(keyOf));
  const cellsOnly = (cells, otherKeys) => cells
    .filter((cell) => !otherKeys.has(keyOf(cell)))
    .map(({ cellX, cellY }) => ({ cellX, cellY }));
  const sharedCellCount = baselineCells.filter((cell) => verificationKeys.has(keyOf(cell))).length;
  return {
    baselineAvailable: baselineCells.length > 0,
    verificationAvailable: verificationCells.length > 0,
    baselineCells: baselineCells.map(({ cellX, cellY }) => ({ cellX, cellY })),
    verificationCells: verificationCells.map(({ cellX, cellY }) => ({ cellX, cellY })),
    sharedCellCount,
    baselineOnlyCells: cellsOnly(baselineCells, verificationKeys),
    verificationOnlyCells: cellsOnly(verificationCells, baselineKeys),
    interpretation: "Descriptive overlap between normalized preview-image cells only; not a defect classifier or verification gate.",
  };
}

function summarizeHotspotComparison(baseline, verification) {
  if (!baseline && !verification) return null;
  return {
    coordinateSpace: "normalized-64x64-grayscale-preview-4x4-grid",
    pixelDifference: summarizeHotspotOverlap(baseline, verification, "pixel"),
    edgeStructure: summarizeHotspotOverlap(baseline, verification, "edge"),
    affectsVerificationStatus: false,
  };
}

function normalizeOptionalDiagnosticMetrics(metrics, label) {
  const ranges = {
    medianCandidateMinusReferenceLuminanceOffset: [-255, 255],
    luminanceOffsetNormalizedMeanAbsoluteError: [0, 255],
    luminanceOffsetNormalizedRootMeanSquaredError: [0, 255],
    luminanceOffsetNormalizedSsim8x8: [-1, 1],
    luminanceOffsetNormalizedMaeReductionPercent: [-0.1, 100.1],
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
      throw new Error("verification-review-similarity-diagnostics-invalid:" + label);
    }
    normalized[key] = metrics[key];
  }
  if (metrics?.candidateToReferenceSharpnessRatio !== undefined) {
    const ratio = metrics.candidateToReferenceSharpnessRatio;
    if (ratio !== null && !finiteInRange(ratio, 0, 1e15)) {
      throw new Error("verification-review-similarity-diagnostics-invalid:" + label);
    }
    normalized.candidateToReferenceSharpnessRatio = ratio;
  }
  return normalized;
}

function normalizeSimilarityDiagnostics(value, comparison) {
  if (value === undefined || value === null) return null;
  const label = comparison.viewId + ":" + comparison.referenceImageId;
  const metrics = value.metrics;
  const comparability = value.comparability;
  const inRange = (number, min, max) =>
    typeof number === "number" && Number.isFinite(number) && number >= min && number <= max;
  const psnrValid = metrics?.psnrDb === null ||
    typeof metrics?.psnrDb === "number" && Number.isFinite(metrics.psnrDb) && metrics.psnrDb >= 0;
  const valid =
    isObject(value) &&
    value.engine === "render-image-similarity-diagnostics-v1" &&
    value.status === "diagnostics-computed" &&
    value.automaticMatch === false &&
    validHash(value.reportSha256) &&
    validHash(value.renderSha256) &&
    validHash(value.referenceSha256) &&
    value.renderSha256.toLowerCase() === comparison.renderSha256.toLowerCase() &&
    value.referenceSha256.toLowerCase() === comparison.referenceSha256.toLowerCase() &&
    nonEmptyString(value.interpretation) &&
    inRange(metrics?.meanAbsoluteError, 0, 255) &&
    inRange(metrics?.rootMeanSquaredError, 0, 255) &&
    psnrValid &&
    inRange(metrics?.localSsim8x8, -1, 1) &&
    Number.isSafeInteger(metrics?.differenceHashHammingDistance) &&
    metrics.differenceHashHammingDistance >= 0 &&
    metrics.differenceHashHammingDistance <= 64 &&
    inRange(comparability?.aspectRatioDifferencePercent, 0, Number.MAX_SAFE_INTEGER) &&
    typeof comparability?.aspectRatioWithinScreeningThreshold === "boolean" &&
    comparability.sameFacadeConfirmedByTool === false &&
    comparability.cameraPoseAlignmentVerifiedByTool === false &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string");
  if (!valid) {
    throw new Error("verification-review-similarity-diagnostics-invalid:" + label);
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
      ...normalizeOptionalDiagnosticMetrics(metrics, label),
    },
    comparability: {
      aspectRatioDifferencePercent: comparability.aspectRatioDifferencePercent,
      aspectRatioWithinScreeningThreshold: comparability.aspectRatioWithinScreeningThreshold,
      sameFacadeConfirmedByTool: false,
      cameraPoseAlignmentVerifiedByTool: false,
    },
    spatialHotspots: normalizeDiagnosticHotspots(metrics, label),
    warnings: [...value.warnings],
    automaticMatch: false,
  };
}

function validateReviewReport(report) {
  if (!isObject(report) || report.engine !== "render-reference-review-v1" || report.schemaVersion !== "1.0.0") {
    throw new Error("unsupported-render-reference-review-report");
  }
  if (report.valid !== true || report.reviewStatus === "invalid-review-package") {
    throw new Error("cannot-verify-against-invalid-review-report");
  }
  if (!nonEmptyString(report.buildingId)) throw new Error("review-report-building-id-missing");
  if (!validHash(report.provenance?.sourceModelSha256)) throw new Error("review-report-source-model-sha256-invalid");
  if (!validHash(report.provenance?.renderManifestSha256)) throw new Error("review-report-render-manifest-sha256-invalid");
  if (!Array.isArray(report.comparisons)) throw new Error("review-report-comparisons-missing");

  const pairKeys = new Set();
  for (const comparison of report.comparisons) {
    if (!isObject(comparison) || !nonEmptyString(comparison.viewId) ||
      !nonEmptyString(comparison.referenceImageId) || !outcomes.has(comparison.outcome) ||
      !comparisonBases.has(comparison.comparisonBasis)) {
      throw new Error("verification-review-comparison-invalid");
    }
    if (!validHash(comparison.renderSha256) || !validHash(comparison.referenceSha256)) {
      throw new Error("verification-review-comparison-hash-invalid:" + comparison.viewId);
    }
    normalizeSimilarityDiagnostics(comparison.similarityDiagnostics, comparison);
    const pairKey = comparison.viewId + "\u0000" + comparison.referenceImageId;
    if (pairKeys.has(pairKey)) throw new Error("duplicate-verification-comparison:" + comparison.viewId + ":" + comparison.referenceImageId);
    pairKeys.add(pairKey);
  }
}

function validateBacklog(backlog) {
  if (!isObject(backlog) || backlog.engine !== "render-review-correction-tasks-v1" || backlog.schemaVersion !== "1.0.0") {
    throw new Error("unsupported-render-correction-task-backlog");
  }
  if (!nonEmptyString(backlog.buildingId) || !Array.isArray(backlog.tasks)) throw new Error("correction-task-backlog-invalid");
  if (!validHash(backlog.createdFromReviewReportSha256)) throw new Error("backlog-source-review-hash-invalid");
  if (!validHash(backlog.provenance?.sourceModelSha256) || !validHash(backlog.provenance?.renderManifestSha256)) {
    throw new Error("backlog-source-provenance-invalid");
  }

  const ids = new Set();
  for (const task of backlog.tasks) {
    if (!isObject(task) || !nonEmptyString(task.id) || ids.has(task.id) ||
      !taskKinds.has(task.kind) || !isObject(task.evidence) ||
      task.buildingId !== backlog.buildingId || !nonEmptyString(task.evidence.viewId)) {
      throw new Error("correction-task-invalid-or-duplicated");
    }
    ids.add(task.id);
    if (task.evidence.reviewReportSha256 !== backlog.createdFromReviewReportSha256 ||
      task.evidence.sourceModelSha256 !== backlog.provenance.sourceModelSha256 ||
      task.evidence.renderManifestSha256 !== backlog.provenance.renderManifestSha256) {
      throw new Error("correction-task-provenance-does-not-match-backlog:" + task.id);
    }
    if (task.evidence.referenceImageId !== null && task.evidence.referenceImageId !== undefined &&
      !nonEmptyString(task.evidence.referenceImageId)) {
      throw new Error("correction-task-reference-id-invalid:" + task.id);
    }
    if (task.kind === "model-correction-review" &&
      (!nonEmptyString(task.evidence.referenceImageId) ||
        !validHash(task.evidence.referenceSha256) || !validHash(task.evidence.renderSha256))) {
      throw new Error("model-correction-task-image-evidence-invalid:" + task.id);
    }
    const storedDiagnostics = task.evidence.similarityDiagnostics;
    if (storedDiagnostics !== undefined && storedDiagnostics !== null) {
      if (!isObject(storedDiagnostics) ||
        storedDiagnostics.automaticMatch !== false ||
        !validHash(storedDiagnostics.reportSha256) ||
        !validHash(storedDiagnostics.renderSha256) ||
        !validHash(storedDiagnostics.referenceSha256) ||
        storedDiagnostics.renderSha256.toLowerCase() !== String(task.evidence.renderSha256 ?? "").toLowerCase() ||
        storedDiagnostics.referenceSha256.toLowerCase() !== String(task.evidence.referenceSha256 ?? "").toLowerCase() ||
        !Array.isArray(storedDiagnostics.warnings) ||
        !storedDiagnostics.warnings.every((warning) => typeof warning === "string")) {
        throw new Error("verification-backlog-similarity-diagnostics-invalid:" + task.id);
      }
      normalizeStoredSpatialHotspots(storedDiagnostics.spatialHotspots, task.id);
    }
  }
}

/**
 * Evaluate correction tasks against a separate, valid report from the next review cycle.
 * The function produces an immutable verification snapshot; it never edits the backlog,
 * source model, mesh, GLB, textures or UVs.
 */
export function verifyRenderCorrectionTasks(backlog, verificationReviewReport) {
  validateBacklog(backlog);
  validateReviewReport(verificationReviewReport);

  if (verificationReviewReport.buildingId !== backlog.buildingId) {
    throw new Error("verification-building-id-does-not-match-backlog");
  }

  const verificationReviewReportSha256 = digest(JSON.stringify(verificationReviewReport));
  if (verificationReviewReportSha256 === backlog.createdFromReviewReportSha256) {
    throw new Error("verification-report-must-be-new-review-evidence");
  }

  const sourceModelSha256 = verificationReviewReport.provenance.sourceModelSha256.toLowerCase();
  const renderManifestSha256 = verificationReviewReport.provenance.renderManifestSha256.toLowerCase();
  const sourceModelChanged = sourceModelSha256 !== backlog.provenance.sourceModelSha256.toLowerCase();
  const renderManifestChanged = renderManifestSha256 !== backlog.provenance.renderManifestSha256.toLowerCase();
  const backlogSha256 = digest(JSON.stringify(backlog));
  const diagnostics = verificationReviewReport.comparisons
    .map((comparison) => normalizeSimilarityDiagnostics(comparison.similarityDiagnostics, comparison))
    .filter(Boolean);

  const taskResults = backlog.tasks.map((task) => {
    const exactComparison = task.evidence.referenceImageId
      ? verificationReviewReport.comparisons.find((item) =>
        item.viewId === task.evidence.viewId && item.referenceImageId === task.evidence.referenceImageId)
      : null;
    const viewComparisons = verificationReviewReport.comparisons.filter((item) => item.viewId === task.evidence.viewId);
    const comparison = exactComparison ?? (task.kind === "add-reference-comparison"
      ? viewComparisons.find((item) => item.outcome !== "pending") ?? viewComparisons[0]
      : undefined);
    const referenceImageHashUnchanged = Boolean(
      comparison && validHash(task.evidence.referenceSha256) &&
      comparison.referenceSha256.toLowerCase() === task.evidence.referenceSha256.toLowerCase()
    );
    const matchedEvidence = comparison ? {
      viewId: comparison.viewId,
      referenceImageId: comparison.referenceImageId,
      comparisonBasis: comparison.comparisonBasis,
      outcome: comparison.outcome,
      renderSha256: comparison.renderSha256.toLowerCase(),
      referenceSha256: comparison.referenceSha256.toLowerCase(),
      reviewer: comparison.reviewer ?? null,
      reviewedAt: comparison.reviewedAt ?? null,
      notes: comparison.notes ?? null,
      similarityDiagnostics: normalizeSimilarityDiagnostics(comparison.similarityDiagnostics, comparison),
    } : null;

    const baselineHotspots = normalizeStoredSpatialHotspots(
      task.evidence.similarityDiagnostics?.spatialHotspots,
      task.id,
    );
    const verificationHotspots = matchedEvidence?.similarityDiagnostics?.spatialHotspots ?? null;
    const diagnosticHotspotComparison = summarizeHotspotComparison(baselineHotspots, verificationHotspots);

    let status;
    let reason;

    if (!comparison) {
      status = "missing-evidence";
      reason = "The new report has no comparison for the required view/reference pair.";
    } else if (task.kind === "model-correction-review") {
      if (comparison.outcome === "pending") {
        status = "awaiting-review";
        reason = "The comparison is still pending and cannot verify a correction.";
      } else if (comparison.outcome === "not-comparable") {
        status = "blocked";
        reason = "The current render/reference pair is not comparable; geometry correctness remains unverified.";
      } else if (comparison.outcome === "match") {
        if (sourceModelChanged && renderManifestChanged && referenceImageHashUnchanged) {
          status = "verified";
          reason = "A human reported a match for the exact view/reference pair on a changed model and render manifest, using the unchanged reference image hash.";
        } else {
          status = "stale-evidence";
          reason = "A match was recorded, but verification requires changed model and render-manifest hashes plus the same reference image SHA-256 as the original task.";
        }
      } else {
        status = "needs-more-work";
        reason = "The latest human comparison remains partial or mismatched; keep the correction task open.";
      }
    } else if (task.kind === "complete-reference-review") {
      if (comparison.outcome === "pending") {
        status = "awaiting-review";
        reason = "The view/reference comparison has not received a final human outcome.";
      } else {
        status = "completed";
        reason = "A non-pending outcome is now recorded. If that outcome is a mismatch or not-comparable, create follow-up tasks from the new report.";
      }
    } else if (task.kind === "resolve-reference-comparability") {
      if (comparison.outcome !== "not-comparable" &&
        comparison.comparisonBasis !== "not-comparable" &&
        comparison.comparisonBasis !== "context-only") {
        status = "resolved";
        reason = "The new report records a comparable basis and a final reviewer outcome for this pair.";
      } else {
        status = "blocked";
        reason = "The latest evidence still does not establish a direct, comparable facade view.";
      }
    } else if (task.kind === "add-reference-comparison") {
      if (comparison.outcome === "pending") {
        status = "awaiting-review";
        reason = "A comparison exists now, but its human review is still pending.";
      } else {
        status = "completed";
        reason = "A comparison is now recorded for the previously uncovered render view. Inspect the new report for any separate correction tasks.";
      }
    }

    return {
      taskId: task.id,
      kind: task.kind,
      title: task.title,
      originalTaskStatus: task.status,
      status,
      observedOutcome: comparison?.outcome ?? null,
      matchedEvidence,
      diagnosticHotspotComparison,
      gates: {
        freshReviewReport: true,
        exactViewReferencePairMatched: Boolean(comparison),
        referenceImageHashUnchanged,
        sourceModelChanged,
        renderManifestChanged,
        modelCorrectionRequiresNewModelAndManifest: task.kind === "model-correction-review",
      },
      reason,
      verified: status === "verified",
      autoApplied: false,
      publicationEligible: false,
    };
  });

  const statusCounts = {};
  for (const result of taskResults) statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
  const tasksWithHotspotComparison = taskResults.filter((result) =>
    result.diagnosticHotspotComparison !== null).length;

  return {
    schemaVersion: "1.0.0",
    engine: "render-correction-verification-v1",
    buildingId: backlog.buildingId,
    sourceBacklogSha256: backlogSha256,
    sourceBacklogReviewReportSha256: backlog.createdFromReviewReportSha256,
    verificationReviewReportSha256,
    provenance: {
      originalSourceModelSha256: backlog.provenance.sourceModelSha256,
      originalRenderManifestSha256: backlog.provenance.renderManifestSha256,
      verificationSourceModelSha256: sourceModelSha256,
      verificationRenderManifestSha256: renderManifestSha256,
      sourceModelChanged,
      renderManifestChanged,
    },
    similarityDiagnosticsSummary: {
      comparisonsWithDiagnostics: diagnostics.length,
      comparisonsWithWarnings: diagnostics.filter((item) => item.warnings.length > 0).length,
      comparisonsWithSpatialHotspots: diagnostics.filter((item) => item.spatialHotspots !== null).length,
      tasksWithHotspotComparison,
      screeningWarnings: [...new Set(diagnostics.flatMap((item) => item.warnings))],
      affectVerificationStatus: false,
      automaticMatch: false,
    },
    counts: {
      total: taskResults.length,
      verified: taskResults.filter((item) => item.status === "verified").length,
      needsMoreWork: taskResults.filter((item) => item.status === "needs-more-work").length,
      awaitingReview: taskResults.filter((item) => item.status === "awaiting-review").length,
      blocked: taskResults.filter((item) => item.status === "blocked").length,
      missingEvidence: taskResults.filter((item) => item.status === "missing-evidence").length,
      staleEvidence: taskResults.filter((item) => item.status === "stale-evidence").length,
      completed: taskResults.filter((item) => item.status === "completed").length,
      resolved: taskResults.filter((item) => item.status === "resolved").length,
      byStatus: statusCounts,
    },
    tasks: taskResults,
    automationPolicy: {
      backlogMutated: false,
      geometryOrTextureEditsApplied: false,
      similarityDiagnosticsAffectVerificationStatus: false,
      hotspotOverlapAffectsVerificationStatus: false,
      publicationEligible: false,
      note: "Verification is an evidence-gated snapshot. Only exact-pair reviewer-reported matches on a changed model and changed render manifest can verify a model-correction task; diagnostic metrics and descriptive normalized-image hotspot overlap are carried for audit and never determine verification status. It is not an automated assessment of visual or heritage accuracy.",
    },
  };
}
