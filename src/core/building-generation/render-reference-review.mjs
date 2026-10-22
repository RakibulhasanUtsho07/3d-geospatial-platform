const sha256Pattern = /^[a-f0-9]{64}$/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const validOutcomes = new Set(["pending", "match", "partial", "mismatch", "not-comparable"]);
const validBases = new Set(["same-facade-known", "pose-estimated", "context-only", "not-comparable"]);
const validRightsStatuses = new Set(["verified", "pending", "unknown"]);

function validIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

/**
 * Assemble a traceable, reviewer-authored comparison between fixed renders and
 * independently supplied reference images. It deliberately creates no similarity
 * score and never promotes this evidence to publication eligibility.
 */
export function buildRenderReferenceReview({ renderManifest, renderManifestSha256, reviewInput, renderFiles, referenceFiles, similarityDiagnostics = [] }) {
  const errors = [], warnings = [];
  if (!renderManifest || renderManifest.schemaVersion !== "1.0.0" ||
    renderManifest.engine !== "building-render-review-manifest-v1" || !Array.isArray(renderManifest.views)) {
    throw new TypeError("renderManifest must be a version 1.0.0 building render review manifest");
  }
  if (!sha256Pattern.test(renderManifestSha256 ?? "")) throw new TypeError("renderManifestSha256 must be a 64-character SHA-256 hash");
  if (!sha256Pattern.test(renderManifest.modelSha256 ?? "")) throw new TypeError("render manifest has no valid source model SHA-256");
  if (!reviewInput || reviewInput.schemaVersion !== "1.0.0" ||
    typeof reviewInput.buildingId !== "string" || !reviewInput.buildingId.trim() ||
    !Array.isArray(reviewInput.referenceImages) || !Array.isArray(reviewInput.comparisons)) {
    throw new TypeError("reviewInput must be schemaVersion 1.0.0 with buildingId, referenceImages and comparisons");
  }
  if (!Array.isArray(renderFiles) || !Array.isArray(referenceFiles)) {
    throw new TypeError("renderFiles and referenceFiles must be arrays of disk-verified image metadata");
  }
  if (!Array.isArray(similarityDiagnostics)) {
    throw new TypeError("similarityDiagnostics must be an array of diagnostic reports");
  }

  const actualRenderFiles = new Map(renderFiles.map((file) => [file.filename, file]));
  const actualReferences = new Map(referenceFiles.map((file) => [file.id, file]));
  const knownViews = new Map();
  for (const view of renderManifest.views) {
    if (!view || typeof view.id !== "string" || !view.id || knownViews.has(view.id)) {
      errors.push("render-manifest-view-ids-invalid-or-duplicated");
      continue;
    }
    knownViews.set(view.id, view);
    const actual = actualRenderFiles.get(view.filename);
    if (!actual) {
      errors.push("render-image-missing:" + view.id);
      continue;
    }
    if (actual.sha256 !== view.sha256) errors.push("render-image-sha256-mismatch:" + view.id);
    if (actual.width !== view.width || actual.height !== view.height) errors.push("render-image-dimensions-mismatch:" + view.id);
  }

  if (renderManifest.status === "failed" || renderManifest.valid !== true) {
    warnings.push("render-manifest-not-clean");
  }
  if (renderManifest.publicationEligible !== false) warnings.push("render-manifest-eligibility-flag-unexpected");
  const seenReferenceIds = new Set();
  const references = [];
  const referenceById = new Map();
  for (const reference of reviewInput.referenceImages) {
    if (!reference || typeof reference.id !== "string" || !reference.id) {
      errors.push("reference-image-id-invalid");
      continue;
    }
    if (seenReferenceIds.has(reference.id)) {
      errors.push("duplicate-reference-image-id:" + reference.id);
      continue;
    }
    seenReferenceIds.add(reference.id);
    referenceById.set(reference.id, reference);
    if (typeof reference.path !== "string" || !reference.path.trim()) errors.push("reference-path-missing:" + reference.id);
    if (!sha256Pattern.test(reference.sha256 ?? "")) errors.push("reference-sha256-invalid:" + reference.id);
    if (!Number.isSafeInteger(reference.width) || reference.width < 1 ||
      !Number.isSafeInteger(reference.height) || reference.height < 1) {
      errors.push("reference-dimensions-invalid:" + reference.id);
    }
    if (typeof reference.sourceDescription !== "string" || !reference.sourceDescription.trim()) {
      warnings.push("reference-source-description-missing:" + reference.id);
    }
    if (!validRightsStatuses.has(reference.rightsStatus)) {
      errors.push("reference-rights-status-invalid:" + reference.id);
    } else if (reference.rightsStatus !== "verified") {
      warnings.push("reference-rights-review-pending:" + reference.id);
    }
    if (reference.captureHeadingDegrees !== undefined && reference.captureHeadingDegrees !== null &&
      (!finite(reference.captureHeadingDegrees) || reference.captureHeadingDegrees < 0 || reference.captureHeadingDegrees >= 360)) {
      errors.push("reference-heading-invalid:" + reference.id);
    }
    const actual = actualReferences.get(reference.id);
    if (!actual) {
      errors.push("reference-file-not-found:" + reference.id);
      continue;
    }
    if (!sha256Pattern.test(actual.sha256 ?? "") || actual.sha256 !== reference.sha256?.toLowerCase()) {
      errors.push("reference-file-sha256-mismatch:" + reference.id);
    }
    if (actual.width !== reference.width || actual.height !== reference.height) {
      errors.push("reference-file-dimensions-mismatch:" + reference.id);
    }
    if (!Number.isSafeInteger(actual.bytes) || actual.bytes < 1) errors.push("reference-file-size-invalid:" + reference.id);
    references.push({
      id: reference.id,
      filename: typeof actual.filename === "string" ? actual.filename : null,
      sha256: actual.sha256 ?? null,
      width: actual.width ?? null,
      height: actual.height ?? null,
      bytes: actual.bytes ?? null,
      sourceDescription: typeof reference.sourceDescription === "string" ? reference.sourceDescription.trim() : "",
      sourceUrl: typeof reference.sourceUrl === "string" && reference.sourceUrl.trim() ? reference.sourceUrl.trim() : null,
      attribution: typeof reference.attribution === "string" && reference.attribution.trim() ? reference.attribution.trim() : null,
      rightsStatus: validRightsStatuses.has(reference.rightsStatus) ? reference.rightsStatus : "unknown",
      facadeLabel: typeof reference.facadeLabel === "string" && reference.facadeLabel.trim() ? reference.facadeLabel.trim() : "unknown",
      captureHeadingDegrees: reference.captureHeadingDegrees ?? null,
      captureHeadingBasis: reference.captureHeadingBasis ?? "unknown",
    });
    if (!reference.facadeLabel || reference.facadeLabel === "unknown") warnings.push("reference-facade-not-identified:" + reference.id);
    if (reference.captureHeadingDegrees === undefined || reference.captureHeadingDegrees === null ||
      reference.captureHeadingBasis !== "measured" && reference.captureHeadingBasis !== "estimated") {
      warnings.push("reference-camera-heading-unverified:" + reference.id);
    }
    if (reference.sourceUrl && !/^https?:\/\//i.test(reference.sourceUrl)) errors.push("reference-source-url-invalid:" + reference.id);
  }
  if (reviewInput.referenceImages.length === 0) warnings.push("no-reference-images-supplied");

  // Optional pixel diagnostics are attached only when they identify the exact
  // render/reference bytes already verified by this review package.
  const diagnosticsByPair = new Map();
  const seenDiagnosticPairs = new Set();
  for (let index = 0; index < similarityDiagnostics.length; index++) {
    const entry = similarityDiagnostics[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.viewId !== "string" || !entry.viewId ||
      typeof entry.referenceImageId !== "string" || !entry.referenceImageId) {
      errors.push("similarity-diagnostic-entry-invalid:" + index);
      continue;
    }
    const viewId = entry.viewId;
    const referenceImageId = entry.referenceImageId;
    const pairKey = viewId + "\u0000" + referenceImageId;
    if (seenDiagnosticPairs.has(pairKey)) {
      errors.push("duplicate-similarity-diagnostic:" + viewId + ":" + referenceImageId);
      continue;
    }
    seenDiagnosticPairs.add(pairKey);
    if (!knownViews.has(viewId)) {
      errors.push("similarity-diagnostic-unknown-render-view:" + viewId);
      continue;
    }
    if (!referenceById.has(referenceImageId)) {
      errors.push("similarity-diagnostic-unknown-reference-image:" + referenceImageId);
      continue;
    }
    const report = entry.report;
    if (!report || report.schemaVersion !== "1.0.0" ||
      report.engine !== "render-image-similarity-diagnostics-v1" ||
      report.status !== "diagnostics-computed" ||
      !report.pair || !report.pair.reference || !report.pair.candidateRender ||
      !report.metrics || !Array.isArray(report.warnings)) {
      errors.push("similarity-diagnostic-report-invalid:" + viewId + ":" + referenceImageId);
      continue;
    }
    if (!sha256Pattern.test(entry.reportSha256 ?? "")) {
      errors.push("similarity-diagnostic-report-sha256-invalid:" + viewId + ":" + referenceImageId);
      continue;
    }
    const view = knownViews.get(viewId);
    const reference = referenceById.get(referenceImageId);
    const actualRender = actualRenderFiles.get(view.filename);
    const actualReference = actualReferences.get(referenceImageId);
    const pair = report.pair;
    const candidate = pair.candidateRender;
    const referencePair = pair.reference;
    const metrics = report.metrics;
    const candidateMatches =
      actualRender &&
      sha256Pattern.test(candidate.sha256 ?? "") &&
      candidate.sha256.toLowerCase() === view.sha256?.toLowerCase() &&
      candidate.sha256.toLowerCase() === actualRender.sha256?.toLowerCase() &&
      candidate.width === view.width && candidate.height === view.height &&
      candidate.width === actualRender.width && candidate.height === actualRender.height &&
      candidate.bytes === actualRender.bytes;
    const referenceMatches =
      actualReference &&
      sha256Pattern.test(referencePair.sha256 ?? "") &&
      referencePair.sha256.toLowerCase() === reference.sha256?.toLowerCase() &&
      referencePair.sha256.toLowerCase() === actualReference.sha256?.toLowerCase() &&
      referencePair.width === reference.width && referencePair.height === reference.height &&
      referencePair.width === actualReference.width && referencePair.height === actualReference.height &&
      referencePair.bytes === actualReference.bytes;
    if (!candidateMatches) errors.push("similarity-diagnostic-render-bytes-mismatch:" + viewId);
    if (!referenceMatches) errors.push("similarity-diagnostic-reference-bytes-mismatch:" + referenceImageId);
    const structureMetricKeys = [
      "referenceEdgePixelCount", "candidateEdgePixelCount",
      "referenceEdgeDensity", "candidateEdgeDensity", "edgeDensityAbsoluteDifference",
      "referenceMeanGradientMagnitude", "candidateMeanGradientMagnitude",
      "referenceLaplacianVariance", "candidateLaplacianVariance",
      "candidateToReferenceSharpnessRatio", "referenceEdgeOrientationHistogram",
      "candidateEdgeOrientationHistogram", "edgeOrientationHistogramDistance",
    ];
    const structureMetricsPresent = structureMetricKeys.some((key) => Object.hasOwn(metrics, key));
    const validHistogram = (histogram) => {
      if (!Array.isArray(histogram) || histogram.length !== 8 ||
        !histogram.every((value) => finite(value) && value >= 0 && value <= 1)) return false;
      const total = histogram.reduce((sum, value) => sum + value, 0);
      return total <= 1e-9 || Math.abs(total - 1) <= 0.01;
    };
    const structureMetricsValid = !structureMetricsPresent || (
      Number.isSafeInteger(metrics.referenceEdgePixelCount) &&
      metrics.referenceEdgePixelCount >= 0 && metrics.referenceEdgePixelCount <= 3844 &&
      Number.isSafeInteger(metrics.candidateEdgePixelCount) &&
      metrics.candidateEdgePixelCount >= 0 && metrics.candidateEdgePixelCount <= 3844 &&
      finite(metrics.referenceEdgeDensity) && metrics.referenceEdgeDensity >= 0 && metrics.referenceEdgeDensity <= 1 &&
      finite(metrics.candidateEdgeDensity) && metrics.candidateEdgeDensity >= 0 && metrics.candidateEdgeDensity <= 1 &&
      finite(metrics.edgeDensityAbsoluteDifference) && metrics.edgeDensityAbsoluteDifference >= 0 && metrics.edgeDensityAbsoluteDifference <= 1 &&
      finite(metrics.referenceMeanGradientMagnitude) && metrics.referenceMeanGradientMagnitude >= 0 && metrics.referenceMeanGradientMagnitude <= 255 &&
      finite(metrics.candidateMeanGradientMagnitude) && metrics.candidateMeanGradientMagnitude >= 0 && metrics.candidateMeanGradientMagnitude <= 255 &&
      finite(metrics.referenceLaplacianVariance) && metrics.referenceLaplacianVariance >= 0 && metrics.referenceLaplacianVariance <= 1000000 &&
      finite(metrics.candidateLaplacianVariance) && metrics.candidateLaplacianVariance >= 0 && metrics.candidateLaplacianVariance <= 1000000 &&
      (metrics.candidateToReferenceSharpnessRatio === null ||
        finite(metrics.candidateToReferenceSharpnessRatio) && metrics.candidateToReferenceSharpnessRatio >= 0) &&
      validHistogram(metrics.referenceEdgeOrientationHistogram) &&
      validHistogram(metrics.candidateEdgeOrientationHistogram) &&
      finite(metrics.edgeOrientationHistogramDistance) &&
      metrics.edgeOrientationHistogramDistance >= 0 && metrics.edgeOrientationHistogramDistance <= 1
    );
    const metricsValid =
      finite(metrics.meanAbsoluteError) && metrics.meanAbsoluteError >= 0 && metrics.meanAbsoluteError <= 255 &&
      finite(metrics.rootMeanSquaredError) && metrics.rootMeanSquaredError >= 0 && metrics.rootMeanSquaredError <= 255 &&
      (metrics.psnrDb === null || finite(metrics.psnrDb) && metrics.psnrDb >= 0) &&
      finite(metrics.localSsim8x8) && metrics.localSsim8x8 >= -1 && metrics.localSsim8x8 <= 1 &&
      Number.isSafeInteger(metrics.differenceHashHammingDistance) &&
      metrics.differenceHashHammingDistance >= 0 && metrics.differenceHashHammingDistance <= 64 &&
      finite(report.comparability?.aspectRatioDifferencePercent) &&
      report.comparability.aspectRatioDifferencePercent >= 0 &&
      structureMetricsValid &&
      report.warnings.every((warning) => typeof warning === "string");
    if (!metricsValid) errors.push("similarity-diagnostic-metrics-invalid:" + viewId + ":" + referenceImageId);
    if (!candidateMatches || !referenceMatches || !metricsValid) continue;
    const normalized = {
      reportSha256: entry.reportSha256.toLowerCase(),
      engine: report.engine,
      status: report.status,
      interpretation: typeof report.interpretation === "string" ? report.interpretation : "review-recommended",
      renderSha256: candidate.sha256.toLowerCase(),
      referenceSha256: referencePair.sha256.toLowerCase(),
      metrics: {
        meanAbsoluteError: metrics.meanAbsoluteError,
        rootMeanSquaredError: metrics.rootMeanSquaredError,
        psnrDb: metrics.psnrDb,
        localSsim8x8: metrics.localSsim8x8,
        differenceHashHammingDistance: metrics.differenceHashHammingDistance,
        ...(structureMetricsPresent ? {
          referenceEdgePixelCount: metrics.referenceEdgePixelCount,
          candidateEdgePixelCount: metrics.candidateEdgePixelCount,
          referenceEdgeDensity: metrics.referenceEdgeDensity,
          candidateEdgeDensity: metrics.candidateEdgeDensity,
          edgeDensityAbsoluteDifference: metrics.edgeDensityAbsoluteDifference,
          referenceMeanGradientMagnitude: metrics.referenceMeanGradientMagnitude,
          candidateMeanGradientMagnitude: metrics.candidateMeanGradientMagnitude,
          referenceLaplacianVariance: metrics.referenceLaplacianVariance,
          candidateLaplacianVariance: metrics.candidateLaplacianVariance,
          candidateToReferenceSharpnessRatio: metrics.candidateToReferenceSharpnessRatio,
          referenceEdgeOrientationHistogram: [...metrics.referenceEdgeOrientationHistogram],
          candidateEdgeOrientationHistogram: [...metrics.candidateEdgeOrientationHistogram],
          edgeOrientationHistogramDistance: metrics.edgeOrientationHistogramDistance,
        } : {}),
      },
      comparability: {
        aspectRatioDifferencePercent: report.comparability.aspectRatioDifferencePercent,
        aspectRatioWithinScreeningThreshold: report.comparability.aspectRatioWithinScreeningThreshold === true,
        sameFacadeConfirmedByTool: false,
        cameraPoseAlignmentVerifiedByTool: false,
      },
      warnings: [...report.warnings],
      automaticMatch: false,
    };
    diagnosticsByPair.set(pairKey, normalized);
    if (report.warnings.length) warnings.push("image-similarity-screening-warnings:" + viewId + ":" + referenceImageId);
  }

  const seenPairs = new Set();
  const comparisons = [];
  for (let index = 0; index < reviewInput.comparisons.length; index++) {
    const comparison = reviewInput.comparisons[index];
    if (!comparison || typeof comparison.viewId !== "string" || !comparison.viewId) {
      errors.push("comparison-view-id-invalid:" + index);
      continue;
    }
    if (!knownViews.has(comparison.viewId)) {
      errors.push("comparison-unknown-render-view:" + comparison.viewId);
      continue;
    }
    if (typeof comparison.referenceImageId !== "string" || !referenceById.has(comparison.referenceImageId)) {
      errors.push("comparison-unknown-reference-image:" + index);
      continue;
    }
    const pairKey = comparison.viewId + "\u0000" + comparison.referenceImageId;
    if (seenPairs.has(pairKey)) {
      errors.push("duplicate-view-reference-comparison:" + comparison.viewId + ":" + comparison.referenceImageId);
      continue;
    }
    seenPairs.add(pairKey);
    if (!validBases.has(comparison.comparisonBasis)) errors.push("comparison-basis-invalid:" + comparison.viewId);
    if (!validOutcomes.has(comparison.outcome)) errors.push("comparison-outcome-invalid:" + comparison.viewId);
    const basis = validBases.has(comparison.comparisonBasis) ? comparison.comparisonBasis : "not-comparable";
    const outcome = validOutcomes.has(comparison.outcome) ? comparison.outcome : "pending";
    if (outcome === "match" && basis !== "same-facade-known" && basis !== "pose-estimated") {
      errors.push("comparison-match-needs-facade-or-pose-basis:" + comparison.viewId);
    }
    if (outcome === "not-comparable" && basis !== "not-comparable" && basis !== "context-only") {
      errors.push("comparison-not-comparable-basis-mismatch:" + comparison.viewId);
    }
    if (outcome !== "pending") {
      if (typeof comparison.reviewer !== "string" || !comparison.reviewer.trim()) errors.push("comparison-reviewer-missing:" + comparison.viewId);
      if (!validIsoDate(comparison.reviewedAt)) errors.push("comparison-reviewedAt-invalid:" + comparison.viewId);
      if (typeof comparison.notes !== "string" || !comparison.notes.trim()) errors.push("comparison-notes-required:" + comparison.viewId);
    }
    if (outcome === "pending") warnings.push("comparison-pending:" + comparison.viewId + ":" + comparison.referenceImageId);
    if (outcome === "partial") warnings.push("partial-match-needs-revision:" + comparison.viewId);
    if (outcome === "mismatch") warnings.push("reference-mismatch-needs-correction:" + comparison.viewId);
    if (basis === "context-only" || basis === "not-comparable") warnings.push("comparison-is-not-direct-facade-validation:" + comparison.viewId);
    comparisons.push({
      viewId: comparison.viewId,
      renderFilename: knownViews.get(comparison.viewId).filename,
      renderSha256: knownViews.get(comparison.viewId).sha256,
      referenceImageId: comparison.referenceImageId,
      referenceSha256: typeof referenceById.get(comparison.referenceImageId).sha256 === "string" ? referenceById.get(comparison.referenceImageId).sha256.toLowerCase() : null,
      comparisonBasis: basis,
      outcome,
      reviewer: typeof comparison.reviewer === "string" ? comparison.reviewer.trim() : "",
      reviewedAt: validIsoDate(comparison.reviewedAt) ? comparison.reviewedAt : null,
      notes: typeof comparison.notes === "string" ? comparison.notes.trim() : "",
      correctionRequest: typeof comparison.correctionRequest === "string" && comparison.correctionRequest.trim()
        ? comparison.correctionRequest.trim() : null,
      similarityDiagnostics: diagnosticsByPair.get(pairKey) ?? null,
    });
  }
  if (reviewInput.comparisons.length === 0) warnings.push("no-render-reference-comparisons-supplied");

  const outcomeCounts = { match:0, partial:0, mismatch:0, notComparable:0, pending:0 };
  for (const comparison of comparisons) {
    if (comparison.outcome === "not-comparable") outcomeCounts.notComparable++;
    else outcomeCounts[comparison.outcome]++;
  }
  const coveredViews = new Set(comparisons.map((comparison) => comparison.viewId));
  const missingViewComparisons = [...knownViews.keys()].filter((viewId) => !coveredViews.has(viewId));
  for (const viewId of missingViewComparisons) warnings.push("no-reference-comparison-for-view:" + viewId);
  const reviewStatus = errors.length ? "invalid-review-package" :
    outcomeCounts.mismatch || outcomeCounts.partial ? "needs-model-or-reference-correction" :
    outcomeCounts.pending || missingViewComparisons.length || comparisons.length === 0 ? "pending-human-review" :
    outcomeCounts.notComparable ? "review-complete-with-unresolved-comparisons" :
    "reviewer-reported-matches";

  return {
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: reviewInput.buildingId.trim(),
    reviewStatus,
    valid: errors.length === 0,
    publicationEligible: false,
    provenance: {
      renderManifestSha256: renderManifestSha256.toLowerCase(),
      sourceModelSha256: renderManifest.modelSha256.toLowerCase(),
      renderManifestStatus: renderManifest.status ?? "unknown",
      referenceImageCount: references.length,
    },
    counts: {
      renderViewCount: knownViews.size,
      referenceImageCount: references.length,
      comparisonCount: comparisons.length,
      ...outcomeCounts,
      viewsWithoutComparisons: missingViewComparisons.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    referenceImages: references,
    comparisons,
    similarityDiagnosticsSummary: {
      supplied: similarityDiagnostics.length > 0,
      count: diagnosticsByPair.size,
      withWarnings: [...diagnosticsByPair.values()].filter((item) => item.warnings.length > 0).length,
      automaticMatch: false,
    },
    viewsWithoutComparisons: missingViewComparisons,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    limitations: [
      "Outcomes are manually entered reviewer judgements; this workflow does not compute image similarity or autonomously determine facade correctness.",
      "A 'match' records a human report for a named comparison basis. It does not independently verify camera pose or model accuracy.",
      "Only JPEG/PNG image headers are supported for dimension verification. Inspect the images visually and confirm their metadata separately.",
      "Rights status and attribution are user-supplied declarations, not legal verification.",
      "Publication eligibility remains false until independent geometry, scale, georeference, rights, and visual checks pass.",
    ],
  };
}
