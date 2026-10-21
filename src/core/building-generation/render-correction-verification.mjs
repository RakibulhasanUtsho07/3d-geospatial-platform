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
    } : null;

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
      publicationEligible: false,
      note: "Verification is an evidence-gated snapshot. Only exact-pair reviewer-reported matches on a changed model and changed render manifest can verify a model-correction task; it is not an automated assessment of visual or heritage accuracy.",
    },
  };
}
