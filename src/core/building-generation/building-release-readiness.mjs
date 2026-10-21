import { createHash } from "node:crypto";
import { REQUIRED_REVIEW_VIEWS } from "./render-review-manifest.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/i;
const directlyComparableBases = new Set(["same-facade-known", "pose-estimated"]);
const correctionTaskKinds = new Map([
  ["model-correction-review", "verified"],
  ["complete-reference-review", "completed"],
  ["add-reference-comparison", "completed"],
  ["resolve-reference-comparability", "resolved"],
]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHash(value) {
  return typeof value === "string" && sha256Pattern.test(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Build an evidence-linked release-readiness decision from fresh QA outputs and
 * the current render/reference/correction workflow. This gate never publishes
 * an asset and never promotes a model to publication eligibility.
 */
export function buildBuildingReleaseReadiness(input) {
  if (!isObject(input)) throw new TypeError("input must be an object");

  const {
    buildingId,
    candidateGlbSha256,
    renderManifest,
    renderManifestSha256,
    geometryQa,
    textureQa,
    renderReferenceReview,
    correctionTaskBacklog,
    correctionVerification,
  } = input;

  if (!nonEmptyString(buildingId)) throw new TypeError("buildingId is required");

  const blockers = [];
  const warnings = [];
  const checks = [];

  function check(id, passed, message, severity = "blocker") {
    const status = passed ? "passed" : severity === "warning" ? "warning" : "blocked";
    checks.push({ id, status, message });
    if (!passed && severity === "warning") warnings.push({ id, message });
    else if (!passed) blockers.push({ id, message });
  }

  check("candidate-glb-sha256", isHash(candidateGlbSha256), "Candidate GLB must have a valid SHA-256 hash.");
  check("render-manifest-sha256", isHash(renderManifestSha256), "Render manifest file bytes must have a valid SHA-256 hash.");

  check("geometry-qa-engine", geometryQa?.schemaVersion === "1.0.0" && geometryQa?.engine === "glb-geometry-qa-v2",
    "Geometry QA must be freshly computed by glb-geometry-qa-v2.");
  check("geometry-qa-valid", geometryQa?.valid === true,
    "Geometry QA must accept the exact candidate GLB.");
  if (Array.isArray(geometryQa?.warnings) && geometryQa.warnings.length) {
    check("geometry-qa-warnings", false,
      "Geometry QA reported warnings that require human review: " + geometryQa.warnings.join(", "), "warning");
  }

  check("texture-qa-engine", textureQa?.schemaVersion === "1.0.0" && textureQa?.engine === "glb-texture-binding-qa-v1",
    "Texture QA must be freshly computed by glb-texture-binding-qa-v1.");
  check("texture-qa-valid", textureQa?.valid === true && Array.isArray(textureQa?.errors) && textureQa.errors.length === 0,
    "GLB texture and UV binding QA must be valid and have no errors.");
  if (Array.isArray(textureQa?.warnings) && textureQa.warnings.length) {
    check("texture-qa-warnings", false,
      "Texture QA reported warnings that require human review: " + textureQa.warnings.join(", "), "warning");
  }
  if (Number.isSafeInteger(textureQa?.counts?.textureContentRiskCount) && textureQa.counts.textureContentRiskCount > 0) {
    check("texture-content-risk", false,
      "Texture image content review reported " + textureQa.counts.textureContentRiskCount + " image-content risk(s).", "warning");
  }
  if (Number.isSafeInteger(textureQa?.counts?.uvSeamCandidateCount) && textureQa.counts.uvSeamCandidateCount > 0) {
    check("uv-seam-candidates", false,
      "Texture QA reported " + textureQa.counts.uvSeamCandidateCount + " UV seam candidate(s) requiring visual review.", "warning");
  }

  const manifestValid = isObject(renderManifest) &&
    renderManifest.schemaVersion === "1.0.0" &&
    renderManifest.engine === "building-render-review-manifest-v1" &&
    renderManifest.valid === true &&
    renderManifest.status !== "failed" &&
    Array.isArray(renderManifest.views);
  check("render-manifest-valid", manifestValid, "A valid, complete render review manifest is required.");
  check("rendered-candidate-hash", isHash(candidateGlbSha256) &&
    renderManifest?.modelSha256?.toLowerCase?.() === candidateGlbSha256.toLowerCase(),
  "The Blender render manifest must reference the exact candidate GLB hash.");

  const manifestViews = new Map();
  if (Array.isArray(renderManifest?.views)) {
    for (const view of renderManifest.views) {
      if (!isObject(view) || !nonEmptyString(view.id) || manifestViews.has(view.id)) {
        blockers.push({ id: "render-manifest-view-ids", message: "Render view IDs must be present and unique." });
        continue;
      }
      manifestViews.set(view.id, view);
      check("render-view-hash:" + view.id, isHash(view.sha256),
        "Render view " + view.id + " must have a valid image SHA-256 hash.");
    }
  }
  for (const requiredView of REQUIRED_REVIEW_VIEWS) {
    check("required-render-view:" + requiredView, manifestViews.has(requiredView),
      "Required render view is missing: " + requiredView + ".");
  }
  if (renderManifest?.status === "review-required" ||
    (Array.isArray(renderManifest?.warnings) && renderManifest.warnings.length)) {
    check("render-manifest-warnings", false,
      "The render manifest contains warnings; final human review must resolve or accept them.", "warning");
  }

  const review = renderReferenceReview;
  const reviewValid = isObject(review) &&
    review.schemaVersion === "1.0.0" &&
    review.engine === "render-reference-review-v1" &&
    review.valid === true &&
    review.buildingId === buildingId &&
    Array.isArray(review.comparisons) &&
    Array.isArray(review.referenceImages);
  check("reference-review-valid", reviewValid,
    "A valid render/reference review for the same building is required.");
  check("reference-review-candidate-hash", isHash(candidateGlbSha256) &&
    review?.provenance?.sourceModelSha256?.toLowerCase?.() === candidateGlbSha256.toLowerCase(),
  "The reference-review report must refer to the exact candidate GLB hash.");
  check("reference-review-manifest-hash", isHash(renderManifestSha256) &&
    review?.provenance?.renderManifestSha256?.toLowerCase?.() === renderManifestSha256.toLowerCase(),
  "The reference-review report must refer to the exact render manifest file hash.");
  check("reference-review-publication-flag", review?.publicationEligible === false,
    "The review report must not claim publication eligibility.");

  const references = new Map();
  if (Array.isArray(review?.referenceImages)) {
    for (const reference of review.referenceImages) {
      if (!isObject(reference) || !nonEmptyString(reference.id) || references.has(reference.id)) {
        blockers.push({ id: "reference-image-ids", message: "Reference image IDs must be present and unique." });
        continue;
      }
      references.set(reference.id, reference);
      check("reference-rights:" + reference.id, reference.rightsStatus === "verified",
        "Reference image rights must be verified before release review: " + reference.id + ".");
      check("reference-image-hash:" + reference.id, isHash(reference.sha256),
        "Reference image must include a SHA-256 hash: " + reference.id + ".");
    }
  }

  const reviewedViews = new Set();
  const comparedPairs = new Set();
  if (Array.isArray(review?.comparisons)) {
    for (const comparison of review.comparisons) {
      if (!isObject(comparison) || !nonEmptyString(comparison.viewId) || !nonEmptyString(comparison.referenceImageId)) {
        check("comparison-shape", false, "Every reference comparison must include a view ID and reference image ID.");
        continue;
      }
      const pairKey = comparison.viewId + "\u0000" + comparison.referenceImageId;
      check("comparison-pair-unique:" + comparison.viewId + ":" + comparison.referenceImageId,
        !comparedPairs.has(pairKey), "Duplicate view/reference comparison pair detected.");
      comparedPairs.add(pairKey);

      const view = manifestViews.get(comparison.viewId);
      const reference = references.get(comparison.referenceImageId);
      check("comparison-render-hash:" + comparison.viewId, Boolean(view && isHash(comparison.renderSha256) &&
        comparison.renderSha256.toLowerCase() === view.sha256?.toLowerCase?.()),
      "Reference comparison must cite the exact render image for view " + comparison.viewId + ".");
      check("comparison-reference-hash:" + comparison.referenceImageId,
        Boolean(reference && isHash(comparison.referenceSha256) &&
          comparison.referenceSha256.toLowerCase() === reference.sha256?.toLowerCase?.()),
      "Reference comparison must cite the exact reference image hash: " + comparison.referenceImageId + ".");
      check("comparison-direct-basis:" + comparison.viewId,
        directlyComparableBases.has(comparison.comparisonBasis),
      "View " + comparison.viewId + " must be compared on a direct facade/estimated-pose basis.");
      check("comparison-outcome:" + comparison.viewId,
        comparison.outcome === "match",
      "Every release-review comparison must have a human-reported match; current outcome for " +
        comparison.viewId + " is " + String(comparison.outcome) + ".");
      check("comparison-reviewer:" + comparison.viewId, nonEmptyString(comparison.reviewer) &&
        typeof comparison.reviewedAt === "string" && Number.isFinite(Date.parse(comparison.reviewedAt)) &&
        nonEmptyString(comparison.notes),
      "Each comparison must retain reviewer, review timestamp and notes.");
      if (comparison.outcome === "match" && directlyComparableBases.has(comparison.comparisonBasis) && view && reference) {
        reviewedViews.add(comparison.viewId);
      }
    }
  }

  for (const requiredView of REQUIRED_REVIEW_VIEWS) {
    check("review-coverage:" + requiredView, reviewedViews.has(requiredView),
      "No qualifying human match review is present for render view " + requiredView + ".");
  }
  check("reference-review-status", review?.reviewStatus === "reviewer-reported-matches",
    "The overall report must record reviewer-reported matches without unresolved comparisons.");

  const backlog = correctionTaskBacklog;
  const backlogValid = isObject(backlog) &&
    backlog.schemaVersion === "1.0.0" &&
    backlog.engine === "render-review-correction-tasks-v1" &&
    backlog.buildingId === buildingId &&
    Array.isArray(backlog.tasks) &&
    isHash(backlog.createdFromReviewReportSha256);
  check("correction-backlog-valid", backlogValid,
    "A valid correction task backlog for the same building is required.");

  const reviewDigest = isObject(review) ? digest(JSON.stringify(review)) : null;
  const backlogDigest = isObject(backlog) ? digest(JSON.stringify(backlog)) : null;
  const verification = correctionVerification;
  check("verification-engine", verification?.schemaVersion === "1.0.0" &&
    verification?.engine === "render-correction-verification-v1" &&
    verification?.buildingId === buildingId && Array.isArray(verification?.tasks),
  "A valid correction verification report for this building is required.");
  check("verification-current-model", isHash(candidateGlbSha256) &&
    verification?.provenance?.verificationSourceModelSha256?.toLowerCase?.() === candidateGlbSha256.toLowerCase(),
  "Correction verification must refer to the exact candidate GLB hash.");
  check("verification-current-manifest", isHash(renderManifestSha256) &&
    verification?.provenance?.verificationRenderManifestSha256?.toLowerCase?.() === renderManifestSha256.toLowerCase(),
  "Correction verification must refer to the exact render manifest.");
  check("verification-review-digest", Boolean(reviewDigest &&
    verification?.verificationReviewReportSha256 === reviewDigest),
  "Correction verification must cite the exact current render/reference review report.");
  check("verification-backlog-digest", Boolean(backlogDigest &&
    verification?.sourceBacklogSha256 === backlogDigest),
  "Correction verification must cite the exact correction task backlog.");
  check("verification-original-review-digest", Boolean(backlogValid &&
    verification?.sourceBacklogReviewReportSha256 === backlog.createdFromReviewReportSha256),
  "Correction verification must link to the review report from which its backlog was created.");

  const backlogTasks = Array.isArray(backlog?.tasks) ? backlog.tasks : [];
  const verificationTasks = Array.isArray(verification?.tasks) ? verification.tasks : [];
  const taskIds = new Set();
  for (const task of backlogTasks) {
    if (!isObject(task) || !nonEmptyString(task.id) || taskIds.has(task.id)) {
      blockers.push({ id: "correction-task-ids", message: "Correction backlog task IDs must be valid and unique." });
      continue;
    }
    taskIds.add(task.id);
  }
  const verificationById = new Map();
  for (const task of verificationTasks) {
    if (!isObject(task) || !nonEmptyString(task.taskId) || verificationById.has(task.taskId)) {
      blockers.push({ id: "verification-task-ids", message: "Correction verification task IDs must be valid and unique." });
      continue;
    }
    verificationById.set(task.taskId, task);
  }
  check("verification-task-count", verificationTasks.length === backlogTasks.length,
    "Every correction backlog task must have exactly one verification result.");
  for (const task of backlogTasks) {
    const result = verificationById.get(task?.id);
    const expectedStatus = correctionTaskKinds.get(task?.kind);
    check("correction-task-verification:" + String(task?.id),
      Boolean(result && expectedStatus && result.status === expectedStatus &&
        (task.kind !== "model-correction-review" || result.verified === true)),
    "Correction task " + String(task?.id) + " must reach status " + String(expectedStatus) + " before release review.");
  }
  for (const taskId of verificationById.keys()) {
    check("verification-no-orphan-task:" + taskId, taskIds.has(taskId),
      "Verification result references a task absent from the backlog: " + taskId + ".");
  }

  const uniqueBlockers = [...new Map(blockers.map((item) => [item.id + "\u0000" + item.message, item])).values()];
  const uniqueWarnings = [...new Map(warnings.map((item) => [item.id + "\u0000" + item.message, item])).values()];
  const status = uniqueBlockers.length
    ? "blocked"
    : uniqueWarnings.length
      ? "ready-for-final-human-review-with-warnings"
      : "ready-for-final-human-review";

  return {
    schemaVersion: "1.0.0",
    engine: "building-release-readiness-gate-v1",
    buildingId,
    status,
    candidateGlbSha256: isHash(candidateGlbSha256) ? candidateGlbSha256.toLowerCase() : null,
    provenance: {
      renderManifestSha256: isHash(renderManifestSha256) ? renderManifestSha256.toLowerCase() : null,
      renderReferenceReviewSha256: reviewDigest,
      correctionTaskBacklogSha256: backlogDigest,
      correctionVerificationReviewSha256: verification?.verificationReviewReportSha256 ?? null,
    },
    counts: {
      requiredRenderViews: REQUIRED_REVIEW_VIEWS.length,
      qualifyingReviewedViews: reviewedViews.size,
      correctionTasks: backlogTasks.length,
      verifiedCorrectionTasks: verificationTasks.filter((item) => item.status === "verified").length,
      blockers: uniqueBlockers.length,
      warnings: uniqueWarnings.length,
      checks: checks.length,
    },
    checks,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    finalHumanReviewRequired: true,
    publicationEligible: false,
    automationPolicy: {
      candidateMutated: false,
      assetPublished: false,
      humanReviewBypassed: false,
      note: "A clean result only means the supplied candidate passed the automated evidence gates and is ready for final human release review. It is not an automatic publication approval or an independent proof of architectural/heritage accuracy.",
    },
  };
}
