import { registerModelToWgs84 } from "./ground-control-registration.mjs";
import { validateReferenceDimensions } from "./reference-dimension-validation.mjs";

const SHA256 = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const dimensionEvidenceBases = new Set(["surveyed", "published-measurement"]);
const controlEvidenceBases = new Set(["surveyed", "official-control"]);
const comparableReviewBases = new Set(["same-facade-known", "pose-estimated"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHash(value) {
  return typeof value === "string" && SHA256.test(value);
}

function positiveDimension(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(label + " must be a finite number greater than zero");
  }
  return value;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Combine objective GLB/dimension/GCP checks with an existing human-authored
 * render-reference review. This creates an accuracy evidence report, not a
 * model-generation algorithm and not a publication approval.
 */
export function buildBuildingAccuracyBenchmark(input = {}) {
  if (!object(input)) throw new TypeError("benchmark input must be an object");
  const {
    buildingId,
    candidateGlbSha256,
    geometryQa,
    dimensionReference,
    groundControl,
    renderReferenceReview,
    generatedAt = new Date().toISOString(),
  } = input;

  if (typeof buildingId !== "string" || !ID.test(buildingId)) {
    throw new TypeError("buildingId is invalid");
  }
  if (!isHash(candidateGlbSha256)) throw new TypeError("candidateGlbSha256 must be a SHA-256 hash");
  if (!validTimestamp(generatedAt)) throw new TypeError("generatedAt must be a valid timestamp");
  if (!object(geometryQa) || geometryQa.schemaVersion !== "1.0.0" ||
    geometryQa.engine !== "glb-geometry-qa-v2" || !object(geometryQa.bounds) ||
    !Array.isArray(geometryQa.bounds.dimensions) || geometryQa.bounds.dimensions.length !== 3) {
    throw new TypeError("geometryQa must be glb-geometry-qa-v2 output with three bound dimensions");
  }

  const measuredModelDimensions = {
    x: positiveDimension(geometryQa.bounds.dimensions[0], "geometryQa.bounds.dimensions[0]"),
    y: positiveDimension(geometryQa.bounds.dimensions[1], "geometryQa.bounds.dimensions[1]"),
    z: positiveDimension(geometryQa.bounds.dimensions[2], "geometryQa.bounds.dimensions[2]"),
  };
  if (!object(dimensionReference)) throw new TypeError("dimensionReference is required");
  if (!object(dimensionReference.evidence)) throw new TypeError("dimensionReference.evidence is required");

  const referenceEvidence = dimensionReference.evidence;
  const dimensionReport = validateReferenceDimensions({
    measuredModelDimensions,
    referenceDimensionsM: dimensionReference.referenceDimensionsM,
    metresPerModelUnit: dimensionReference.metresPerModelUnit,
    tolerancePercent: dimensionReference.tolerancePercent,
    axisMapping: dimensionReference.axisMapping,
  });

  const checks = [];
  const failures = [];
  const warnings = [];
  function record(id, passed, detail, severity = "failure") {
    const status = passed ? "passed" : severity === "warning" ? "warning" : "failed";
    const check = { id, status, detail };
    checks.push(check);
    if (!passed && severity === "warning") warnings.push(check);
    if (!passed && severity === "failure") failures.push(check);
  }

  const geometryValid = geometryQa.valid === true;
  record("glb-geometry-valid", geometryValid,
    geometryValid ? "The candidate passed the structural GLB geometry QA." :
      "The candidate failed GLB structural/geometry QA.");
  if (Array.isArray(geometryQa.warnings) && geometryQa.warnings.length > 0) {
    record("glb-geometry-warnings", false,
      "Geometry QA has warnings requiring visual review: " + geometryQa.warnings.join(", "), "warning");
  }

  const dimensionEvidenceValid =
    dimensionEvidenceBases.has(referenceEvidence.basis) &&
    nonEmptyString(referenceEvidence.referenceId) &&
    nonEmptyString(referenceEvidence.sourceDescription);
  record("dimension-reference-provenance", dimensionEvidenceValid,
    dimensionEvidenceValid ?
      "Dimension reference is identified as surveyed or published-measurement evidence; source provenance is operator-attested, not independently authenticated." :
      "A surveyed/published-measurement basis, referenceId and sourceDescription are required; estimates cannot establish benchmark ground truth.");
  record("reference-dimensions-within-tolerance",
    dimensionReport.status === "dimension-check-passed-review-required",
    "Maximum axis-aligned relative dimension error is " + dimensionReport.maxRelativeErrorPercent +
      "% (tolerance " + dimensionReport.tolerancePercent + "%).");

  let groundControlReport = null;
  let groundControlSummary = { supplied: false, status: "missing" };
  if (!object(groundControl)) {
    record("ground-control-evidence", false,
      "Ground-control coordinates are missing; geospatial accuracy has not been measured.", "warning");
  } else {
    const sourceHashMatches = isHash(groundControl.modelCoordinatesGlbSha256) &&
      groundControl.modelCoordinatesGlbSha256.toLowerCase() === candidateGlbSha256.toLowerCase();
    const evidenceValid = controlEvidenceBases.has(groundControl.coordinateEvidenceBasis) &&
      nonEmptyString(groundControl.sourceDescription);
    record("ground-control-model-binding", sourceHashMatches,
      sourceHashMatches ?
        "Ground-control model coordinates declare the exact candidate GLB SHA-256." :
        "Ground-control model coordinates are not bound to the exact candidate GLB SHA-256.");
    record("ground-control-provenance", evidenceValid,
      evidenceValid ?
        "Control-coordinate provenance is operator-attested as surveyed/official control; it is not independently authenticated." :
        "Ground-control needs a surveyed/official-control basis and a source description.");

    try {
      groundControlReport = registerModelToWgs84({
        controlPoints: groundControl.controlPoints,
        maxRmsErrorM: groundControl.maxRmsErrorM,
        maxResidualM: groundControl.maxResidualM,
      });
      const controls = groundControlReport.controls ?? {};
      const registrationPasses = groundControlReport.status === "calibrated-needs-human-review" &&
        controls.thresholdPass === true;
      record("ground-control-residuals-within-tolerance", registrationPasses,
        registrationPasses ?
          "Horizontal ground-control RMS/max residuals pass configured thresholds; vertical datum remains unsolved." :
          "Ground-control registration failed or residuals exceed configured thresholds.");
      groundControlSummary = {
        supplied: true,
        status: groundControlReport.status,
        modelCoordinatesGlbSha256: groundControl.modelCoordinatesGlbSha256 ?? null,
        sourceDescription: groundControl.sourceDescription ?? null,
        coordinateEvidenceBasis: groundControl.coordinateEvidenceBasis ?? "unknown",
        thresholdPass: controls.thresholdPass === true,
        rmsErrorM: Number.isFinite(controls.rmsErrorM) ? controls.rmsErrorM : null,
        maxResidualM: Number.isFinite(controls.maxResidualM) ? controls.maxResidualM : null,
        controlPointCount: Array.isArray(groundControl.controlPoints) ? groundControl.controlPoints.length : 0,
      };
    } catch (error) {
      record("ground-control-registration", false,
        "Ground-control registration could not be calculated: " +
          (error instanceof Error ? error.message : String(error)));
      groundControlSummary = {
        supplied: true,
        status: "calculation-failed",
        modelCoordinatesGlbSha256: groundControl.modelCoordinatesGlbSha256 ?? null,
        sourceDescription: groundControl.sourceDescription ?? null,
      };
    }
  }

  let visualSummary = { supplied: false, status: "missing", comparisonCount: 0, matchCount: 0, partialCount: 0, mismatchCount: 0, pendingCount: 0, notComparableCount: 0 };
  if (!object(renderReferenceReview)) {
    record("render-reference-review", false,
      "A human-authored render/reference review report is missing.", "warning");
  } else {
    const reviewValid = renderReferenceReview.schemaVersion === "1.0.0" &&
      renderReferenceReview.engine === "render-reference-review-v1" &&
      renderReferenceReview.valid === true &&
      renderReferenceReview.buildingId === buildingId &&
      Array.isArray(renderReferenceReview.comparisons);
    record("render-reference-report-valid", reviewValid,
      reviewValid ? "The render/reference review report is structurally valid for this building." :
        "The render/reference review report is invalid or belongs to a different building.");
    const reviewHashMatches = isHash(renderReferenceReview.provenance?.sourceModelSha256) &&
      renderReferenceReview.provenance.sourceModelSha256.toLowerCase() === candidateGlbSha256.toLowerCase();
    record("render-reference-candidate-binding", reviewHashMatches,
      reviewHashMatches ? "Reference review identifies this exact candidate GLB." :
        "Reference review is stale or does not identify the exact candidate GLB.");

    const comparisons = Array.isArray(renderReferenceReview.comparisons) ? renderReferenceReview.comparisons : [];
    const counts = { match: 0, partial: 0, mismatch: 0, pending: 0, notComparable: 0 };
    for (const comparison of comparisons) {
      if (comparison?.outcome === "match") counts.match++;
      else if (comparison?.outcome === "partial") counts.partial++;
      else if (comparison?.outcome === "mismatch") counts.mismatch++;
      else if (comparison?.outcome === "not-comparable") counts.notComparable++;
      else counts.pending++;
    }
    const allDirectMatches = comparisons.length > 0 && comparisons.every((comparison) =>
      comparison?.outcome === "match" &&
      comparableReviewBases.has(comparison.comparisonBasis) &&
      nonEmptyString(comparison.reviewer) &&
      validTimestamp(comparison.reviewedAt) &&
      nonEmptyString(comparison.notes));
    const unresolved = counts.pending > 0 || counts.notComparable > 0 ||
      (Number.isSafeInteger(renderReferenceReview.counts?.viewsWithoutComparisons) &&
       renderReferenceReview.counts.viewsWithoutComparisons > 0);
    const visualResultPasses = reviewValid && reviewHashMatches &&
      renderReferenceReview.reviewStatus === "reviewer-reported-matches" && allDirectMatches && !unresolved;
    if (counts.mismatch > 0 || counts.partial > 0) {
      record("render-reference-outcomes", false,
        "Human review records " + counts.mismatch + " mismatch(es) and " + counts.partial + " partial match(es).");
    } else if (!visualResultPasses) {
      record("render-reference-outcomes", false,
        "Visual reference evidence is pending, incomplete, not directly comparable, or lacks reviewer metadata.", "warning");
    } else {
      record("render-reference-outcomes", true,
        "Every supplied comparison is reviewer-reported as a direct facade/pose match; this remains a human judgement.");
    }
    visualSummary = {
      supplied: true,
      status: renderReferenceReview.reviewStatus ?? "unknown",
      comparisonCount: comparisons.length,
      ...counts,
      viewsWithoutComparisons: renderReferenceReview.counts?.viewsWithoutComparisons ?? null,
      sourceModelSha256: renderReferenceReview.provenance?.sourceModelSha256 ?? null,
    };
  }

  const status = failures.length > 0 ? "benchmark-failed" :
    warnings.length > 0 ? "benchmark-incomplete" : "benchmark-passed-review-required";

  return {
    schemaVersion: "1.0.0",
    engine: "building-accuracy-benchmark-v1",
    buildingId,
    generatedAt,
    candidateGlbSha256: candidateGlbSha256.toLowerCase(),
    status,
    checks,
    counts: { passed: checks.filter((item) => item.status === "passed").length, warnings: warnings.length, failures: failures.length },
    metrics: {
      geometry: {
        valid: geometryValid,
        vertices: geometryQa.counts?.vertexCount ?? null,
        triangles: geometryQa.counts?.triangleCount ?? null,
        dimensionsModelUnits: measuredModelDimensions,
        warningCount: Array.isArray(geometryQa.warnings) ? geometryQa.warnings.length : null,
      },
      dimensions: {
        status: dimensionReport.status,
        referenceEvidenceBasis: referenceEvidence.basis ?? "unknown",
        referenceId: referenceEvidence.referenceId ?? null,
        tolerancePercent: dimensionReport.tolerancePercent,
        maxRelativeErrorPercent: dimensionReport.maxRelativeErrorPercent,
        rmsRelativeErrorPercent: dimensionReport.rmsRelativeErrorPercent,
        axes: dimensionReport.axes,
      },
      georeference: groundControlSummary,
      visualReference: visualSummary,
    },
    evidence: {
      dimensionReference: {
        basis: referenceEvidence.basis ?? "unknown",
        referenceId: referenceEvidence.referenceId ?? null,
        sourceDescription: referenceEvidence.sourceDescription ?? null,
        sourceUrl: referenceEvidence.sourceUrl ?? null,
        independentlyAuthenticated: false,
      },
      groundControl: groundControlSummary,
      visualReference: visualSummary,
    },
    policy: {
      mapReady: false,
      publicationEligible: false,
      automaticApproval: false,
      note: "No single overall accuracy percentage is calculated. Dimensional, horizontal georeference and human visual-review evidence remain separate metrics.",
    },
    limitations: [
      "Axis-aligned GLB bounds are a dimensional sanity check, not a surface-to-surface or full-shape accuracy metric.",
      "Control-point registration is horizontal only; vertical datum, camera calibration and control-point identity need separate review.",
      "Visual comparison outcomes are reviewer-authored judgements, not an automated image-similarity score.",
      "Reference and survey provenance are operator-attested inputs and are not independently authenticated by this benchmark.",
      "A passing benchmark does not establish heritage accuracy, flat-level details, legal rights, map readiness or publication approval.",
    ],
  };
}
