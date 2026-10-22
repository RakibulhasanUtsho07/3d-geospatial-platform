import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { verifyRenderCorrectionTasks } from "../src/core/building-generation/render-correction-verification.mjs";

const modelSha = "a".repeat(64);
const manifestSha = "b".repeat(64);
const renderSha256 = "c".repeat(64);
const referenceSha256 = "d".repeat(64);
const changedModelSha = "e".repeat(64);
const changedManifestSha = "f".repeat(64);
const geometryQaSha = "7".repeat(64);
const textureQaSha = "8".repeat(64);

function verifyWithArtifactEvidence(backlogValue, reportValue, evidenceOverride) {
  const artifactEvidence = evidenceOverride ?? {
    validated: true,
    candidateGlbSha256: reportValue.provenance.sourceModelSha256,
    renderManifestSha256: reportValue.provenance.renderManifestSha256,
    geometryQaReportSha256: geometryQaSha,
    textureQaReportSha256: textureQaSha,
    qaReportsRecomputedFromCandidateModel: true,
  };
  return verifyRenderCorrectionTasks(backlogValue, reportValue, artifactEvidence);
}

function reviewReport(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    engine: "render-reference-review-v1",
    buildingId: "test-building",
    reviewStatus: "reviewer-reported-matches",
    valid: true,
    publicationEligible: false,
    provenance: { sourceModelSha256: changedModelSha, renderManifestSha256: changedManifestSha },
    comparisons: [{
      viewId: "front",
      renderFilename: "front.png",
      renderSha256: "1".repeat(64),
      referenceImageId: "reference-front",
      referenceSha256,
      comparisonBasis: "same-facade-known",
      outcome: "match",
      reviewer: "reviewer-01",
      reviewedAt: "2026-10-21T12:00:00Z",
      notes: "Visible opening rhythm is consistent in this view.",
      ...{},
    }],
    viewsWithoutComparisons: [],
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: "rrt-0123456789abcdefabcd",
    buildingId: "test-building",
    kind: "model-correction-review",
    priority: "high",
    status: "open",
    evidence: {
      reviewReportSha256: "9".repeat(64),
      sourceModelSha256: modelSha,
      renderManifestSha256: manifestSha,
      viewId: "front",
      renderFilename: "front.png",
      renderSha256,
      referenceImageId: "reference-front",
      referenceSha256,
      comparisonBasis: "same-facade-known",
      outcome: "mismatch",
      reviewer: "reviewer-01",
      reviewedAt: "2026-10-21T10:00:00Z",
      notes: "Facade openings differ.",
    },
    reviewChecklist: {
      schemaVersion: "1.0.0",
      correctionProposal: {
        status: "approved",
        proposalText: "Adjust front facade opening proportions to match the approved reference.",
        proposedBy: "modeler-01",
        proposedAt: "2026-10-21T12:15:00Z",
        approval: {
          status: "approved",
          approvedBy: "reviewer-02",
          approvedAt: "2026-10-21T12:30:00Z",
          rationale: "Proposal reviewed against the exact source and reference images.",
        },
      },
      implementationEvidence: {
        status: "qa-complete",
        changeSummary: "Adjusted opening proportions using the approved proposal.",
        implementedAt: "2026-10-21T12:45:00Z",
        outputModelSha256: changedModelSha,
        geometryQaReportSha256: "7".repeat(64),
        textureChangeApplicable: false,
        textureQaReportSha256: null,
        generatedRenderManifestSha256: changedManifestSha,
      },
    },
    title: "Review front facade correction",
    ...overrides,
  };
}

function backlog(overrides = {}) {
  const originalTask = task();
  return {
    schemaVersion: "1.0.0",
    engine: "render-review-correction-tasks-v1",
    buildingId: "test-building",
    sourceReviewStatus: "needs-model-or-reference-correction",
    createdFromReviewReportSha256: "9".repeat(64),
    provenance: { sourceModelSha256: modelSha, renderManifestSha256: manifestSha },
    counts: { total: 1, open: 1, highPriority: 1, mediumPriority: 0, byKind: { "model-correction-review": 1 } },
    tasks: [originalTask],
    ...overrides,
  };
}

test("does not verify from JSON hashes alone when the caller supplies no file-backed artifact context", () => {
  const result = verifyRenderCorrectionTasks(backlog(), reviewReport());
  assert.equal(result.tasks[0].status, "incomplete-implementation-evidence");
  assert.equal(result.tasks[0].verified, false);
  assert.equal(result.tasks[0].gates.artifactEvidenceValidated, false);
  assert.equal(result.artifactIntegrity.status, "required-files-not-validated");
});

test("requires actual QA report hashes to match the checklist values", () => {
  const evidence = {
    validated: true,
    candidateGlbSha256: changedModelSha,
    renderManifestSha256: changedManifestSha,
    geometryQaReportSha256: "0".repeat(64),
    textureQaReportSha256: textureQaSha,
    qaReportsRecomputedFromCandidateModel: true,
  };
  const result = verifyWithArtifactEvidence(backlog(), reviewReport(), evidence);
  assert.equal(result.tasks[0].status, "incomplete-implementation-evidence");
  assert.equal(result.tasks[0].gates.geometryQaArtifactMatchesChecklist, false);
  assert.equal(result.artifactIntegrity.status, "candidate-and-qa-files-validated");
});

test("verifies a correction only with a fresh match for the exact pair and changed model plus render manifest", () => {
  const result = verifyWithArtifactEvidence(backlog(), reviewReport());
  assert.equal(result.engine, "render-correction-verification-v1");
  assert.equal(result.counts.verified, 1);
  assert.equal(result.tasks[0].status, "verified");
  assert.equal(result.tasks[0].verified, true);
  assert.equal(result.tasks[0].matchedEvidence.referenceImageId, "reference-front");
  assert.equal(result.tasks[0].gates.sourceModelChanged, true);
  assert.equal(result.tasks[0].gates.renderManifestChanged, true);
  assert.equal(result.automationPolicy.backlogMutated, false);
  assert.equal(result.automationPolicy.publicationEligible, false);
});


function similarityDiagnostics(overrides = {}) {
  return {
    reportSha256: "0".repeat(64),
    engine: "render-image-similarity-diagnostics-v1",
    status: "diagnostics-computed",
    interpretation: "review-recommended",
    renderSha256: "1".repeat(64),
    referenceSha256,
    metrics: {
      meanAbsoluteError: 55.5,
      rootMeanSquaredError: 72.25,
      psnrDb: 10.96,
      localSsim8x8: 0.12,
      differenceHashHammingDistance: 51,
    },
    comparability: {
      aspectRatioDifferencePercent: 0.5,
      aspectRatioWithinScreeningThreshold: true,
      sameFacadeConfirmedByTool: false,
      cameraPoseAlignmentVerifiedByTool: false,
    },
    warnings: ["low-grayscale-ssim-screening-hint", "high-grayscale-pixel-error-screening-hint"],
    automaticMatch: false,
    ...overrides,
  };
}

test("a changed model and fresh match still wait for an explicit approved proposal", () => {
  const sourceTask = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      correctionProposal: {
        ...task().reviewChecklist.correctionProposal,
        proposalText: null,
        proposedBy: null,
        proposedAt: null,
        approval: {
          status: "not-approved",
          approvedBy: null,
          approvedAt: null,
          rationale: null,
        },
      },
    },
  });
  const result = verifyWithArtifactEvidence(backlog({ tasks: [sourceTask] }), reviewReport());
  assert.equal(result.tasks[0].status, "awaiting-approved-proposal");
  assert.equal(result.tasks[0].verified, false);
  assert.equal(result.tasks[0].gates.proposalWritten, false);
  assert.equal(result.tasks[0].gates.proposalApproved, false);
  assert.equal(result.counts.awaitingApprovedProposal, 1);
});

test("rejects an approval timestamp that follows implementation", () => {
  const sourceTask = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      correctionProposal: {
        ...task().reviewChecklist.correctionProposal,
        approval: {
          ...task().reviewChecklist.correctionProposal.approval,
          approvedAt: "2026-10-21T13:30:00Z",
        },
      },
    },
  });
  const result = verifyWithArtifactEvidence(backlog({ tasks: [sourceTask] }), reviewReport());
  assert.equal(result.tasks[0].status, "approval-order-violation");
  assert.equal(result.tasks[0].verified, false);
  assert.equal(result.tasks[0].gates.approvalOrderViolation, true);
  assert.equal(result.counts.approvalOrderViolation, 1);
});

test("requires geometry QA and fresh report hashes to match implementation evidence", () => {
  const noGeometryQa = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      implementationEvidence: {
        ...task().reviewChecklist.implementationEvidence,
        geometryQaReportSha256: null,
      },
    },
  });
  const noGeometryResult = verifyWithArtifactEvidence(backlog({ tasks: [noGeometryQa] }), reviewReport());
  assert.equal(noGeometryResult.tasks[0].status, "incomplete-implementation-evidence");
  assert.equal(noGeometryResult.tasks[0].gates.geometryQaEvidencePresent, false);

  const staleOutputHash = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      implementationEvidence: {
        ...task().reviewChecklist.implementationEvidence,
        outputModelSha256: modelSha,
      },
    },
  });
  const staleOutputResult = verifyWithArtifactEvidence(backlog({ tasks: [staleOutputHash] }), reviewReport());
  assert.equal(staleOutputResult.tasks[0].status, "incomplete-implementation-evidence");
  assert.equal(staleOutputResult.tasks[0].gates.outputModelMatchesVerificationReport, false);

  const staleManifestHash = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      implementationEvidence: {
        ...task().reviewChecklist.implementationEvidence,
        generatedRenderManifestSha256: manifestSha,
      },
    },
  });
  const staleManifestResult = verifyWithArtifactEvidence(backlog({ tasks: [staleManifestHash] }), reviewReport());
  assert.equal(staleManifestResult.tasks[0].status, "incomplete-implementation-evidence");
  assert.equal(staleManifestResult.tasks[0].gates.renderManifestMatchesVerificationReport, false);
  assert.equal(staleManifestResult.counts.incompleteImplementationEvidence, 1);
});

test("does not verify QA hashes while implementation is still marked not-started", () => {
  const incomplete = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      implementationEvidence: {
        ...task().reviewChecklist.implementationEvidence,
        status: "not-started",
      },
    },
  });
  const result = verifyWithArtifactEvidence(backlog({ tasks: [incomplete] }), reviewReport());
  assert.equal(result.tasks[0].status, "incomplete-implementation-evidence");
  assert.equal(result.tasks[0].gates.implementationQaMarkedComplete, false);
});

test("requires an explicit texture-change decision and texture QA when textures changed", () => {
  const missingApplicability = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      implementationEvidence: {
        ...task().reviewChecklist.implementationEvidence,
        textureChangeApplicable: null,
      },
    },
  });
  const missingApplicabilityResult = verifyWithArtifactEvidence(
    backlog({ tasks: [missingApplicability] }), reviewReport());
  assert.equal(missingApplicabilityResult.tasks[0].status, "incomplete-implementation-evidence");
  assert.equal(missingApplicabilityResult.tasks[0].gates.textureChangeApplicabilityRecorded, false);

  const textureChangedWithoutQa = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      implementationEvidence: {
        ...task().reviewChecklist.implementationEvidence,
        textureChangeApplicable: true,
        textureQaReportSha256: null,
      },
    },
  });
  const textureQaResult = verifyWithArtifactEvidence(backlog({ tasks: [textureChangedWithoutQa] }), reviewReport());
  assert.equal(textureQaResult.tasks[0].status, "incomplete-implementation-evidence");
  assert.equal(textureQaResult.tasks[0].gates.textureQaEvidencePresent, false);

  const withTextureQa = task({
    reviewChecklist: {
      ...task().reviewChecklist,
      implementationEvidence: {
        ...task().reviewChecklist.implementationEvidence,
        textureChangeApplicable: true,
        textureQaReportSha256: "8".repeat(64),
      },
    },
  });
  assert.equal(verifyWithArtifactEvidence(backlog({ tasks: [withTextureQa] }), reviewReport()).tasks[0].status, "verified");
});

test("carries fresh similarity diagnostics into verification evidence without changing status", () => {
  const review = reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      similarityDiagnostics: similarityDiagnostics(),
    }],
  });
  const result = verifyWithArtifactEvidence(backlog(), review);
  assert.equal(result.tasks[0].status, "verified");
  assert.equal(result.tasks[0].verified, true);
  assert.equal(result.tasks[0].matchedEvidence.similarityDiagnostics.metrics.localSsim8x8, 0.12);
  assert.equal(result.tasks[0].matchedEvidence.similarityDiagnostics.renderSha256, "1".repeat(64));
  assert.equal(result.tasks[0].matchedEvidence.similarityDiagnostics.referenceSha256, referenceSha256);
  assert.deepEqual(result.tasks[0].matchedEvidence.similarityDiagnostics.warnings, [
    "low-grayscale-ssim-screening-hint",
    "high-grayscale-pixel-error-screening-hint",
  ]);
  assert.equal(result.similarityDiagnosticsSummary.comparisonsWithDiagnostics, 1);
  assert.equal(result.similarityDiagnosticsSummary.comparisonsWithWarnings, 1);
  assert.equal(result.similarityDiagnosticsSummary.affectVerificationStatus, false);
  assert.equal(result.automationPolicy.similarityDiagnosticsAffectVerificationStatus, false);
  assert.equal(result.automationPolicy.publicationEligible, false);
});

test("rejects diagnostics that do not match the reviewed render/reference hashes", () => {
  assert.throws(() => verifyWithArtifactEvidence(backlog(), reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      similarityDiagnostics: similarityDiagnostics({ referenceSha256: "8".repeat(64) }),
    }],
  })), /similarity-diagnostics-invalid/);
});

test("rejects malformed diagnostic metric ranges instead of silently trusting them", () => {
  const invalid = similarityDiagnostics();
  invalid.metrics.localSsim8x8 = 2;
  assert.throws(() => verifyWithArtifactEvidence(backlog(), reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      similarityDiagnostics: invalid,
    }],
  })), /similarity-diagnostics-invalid/);
});

test("legacy verification reports without diagnostic metrics remain supported", () => {
  const result = verifyWithArtifactEvidence(backlog(), reviewReport());
  assert.equal(result.tasks[0].status, "verified");
  assert.equal(result.tasks[0].matchedEvidence.similarityDiagnostics, null);
  assert.equal(result.similarityDiagnosticsSummary.comparisonsWithDiagnostics, 0);
  assert.equal(result.similarityDiagnosticsSummary.comparisonsWithWarnings, 0);
});

test("does not verify a match when the source model has not changed", () => {
  const result = verifyWithArtifactEvidence(backlog(), reviewReport({
    provenance: { sourceModelSha256: modelSha, renderManifestSha256: changedManifestSha },
  }));
  assert.equal(result.tasks[0].status, "stale-evidence");
  assert.equal(result.tasks[0].verified, false);
});

test("does not verify a match when the render manifest has not changed", () => {
  const result = verifyWithArtifactEvidence(backlog(), reviewReport({
    provenance: { sourceModelSha256: changedModelSha, renderManifestSha256: manifestSha },
  }));
  assert.equal(result.tasks[0].status, "stale-evidence");
});

test("does not verify a match when the reference image hash changed", () => {
  const changedReference = "7".repeat(64);
  const report = reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      referenceSha256: changedReference,
    }],
  });
  const result = verifyWithArtifactEvidence(backlog(), report);
  assert.equal(result.tasks[0].status, "stale-evidence");
  assert.equal(result.tasks[0].gates.referenceImageHashUnchanged, false);
});

test("keeps a task active when the latest comparison is partial or mismatch", () => {
  const partial = reviewReport({
    comparisons: [reviewReport().comparisons[0] && {
      ...reviewReport().comparisons[0],
      outcome: "partial",
    }],
  });
  assert.equal(verifyWithArtifactEvidence(backlog(), partial).tasks[0].status, "needs-more-work");
  const mismatch = reviewReport({
    comparisons: [reviewReport().comparisons[0] && {
      ...reviewReport().comparisons[0],
      outcome: "mismatch",
    }],
  });
  assert.equal(verifyWithArtifactEvidence(backlog(), mismatch).tasks[0].status, "needs-more-work");
});

test("pending comparison waits and not-comparable evidence blocks model verification", () => {
  const pending = reviewReport({
    comparisons: [{
      viewId: "front",
      renderSha256: "1".repeat(64),
      referenceImageId: "reference-front",
      referenceSha256,
      comparisonBasis: "same-facade-known",
      outcome: "pending",
      reviewer: "",
      reviewedAt: null,
      notes: "",
    }],
  });
  assert.equal(verifyWithArtifactEvidence(backlog(), pending).tasks[0].status, "awaiting-review");

  const incomparable = reviewReport({
    comparisons: [{
      viewId: "front",
      renderSha256: "1".repeat(64),
      referenceImageId: "reference-front",
      referenceSha256,
      comparisonBasis: "not-comparable",
      outcome: "not-comparable",
      reviewer: "reviewer-01",
      reviewedAt: "2026-10-21T12:00:00Z",
      notes: "Camera orientation cannot be aligned.",
    }],
  });
  assert.equal(verifyWithArtifactEvidence(backlog(), incomparable).tasks[0].status, "blocked");
});

test("missing exact view/reference evidence cannot close a correction task", () => {
  const result = verifyWithArtifactEvidence(backlog(), reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      viewId: "side",
    }],
  }));
  assert.equal(result.tasks[0].status, "missing-evidence");
  assert.equal(result.tasks[0].verified, false);
});

test("review-only tasks can complete without claiming geometry correction", () => {
  const sourceTask = task({
    kind: "complete-reference-review",
    evidence: { ...task().evidence, referenceImageId: "reference-front" },
  });
  const sourceBacklog = backlog({ tasks: [sourceTask] });
  const report = reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      outcome: "mismatch",
    }],
  });
  const result = verifyWithArtifactEvidence(sourceBacklog, report);
  assert.equal(result.tasks[0].status, "completed");
  assert.equal(result.tasks[0].verified, false);
});

test("uncovered-view task completes only after the new report has an outcome", () => {
  const sourceTask = task({
    kind: "add-reference-comparison",
    evidence: { ...task().evidence, referenceImageId: null, viewId: "back" },
  });
  const sourceBacklog = backlog({ tasks: [sourceTask] });
  const report = reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      viewId: "back",
      referenceImageId: "reference-back",
    }],
  });
  assert.equal(verifyWithArtifactEvidence(sourceBacklog, report).tasks[0].status, "completed");
});

test("rejects same report reuse, wrong building, invalid hashes and duplicate comparisons", () => {
  const sameReport = {
    ...reviewReport(),
    provenance: { sourceModelSha256: modelSha, renderManifestSha256: manifestSha },
  };
  // Explicitly reuse the exact source report digest to ensure it is not accepted as a fresh cycle.
  const exactDigest = createHash("sha256").update(JSON.stringify(sameReport)).digest("hex");
  assert.throws(() => verifyWithArtifactEvidence(backlog({
    createdFromReviewReportSha256: exactDigest,
    tasks: [task({ evidence: { ...task().evidence, reviewReportSha256: exactDigest } })],
  }), sameReport), /must-be-new-review-evidence/);
  assert.throws(() => verifyWithArtifactEvidence(backlog(), reviewReport({ buildingId: "another-building" })), /does-not-match-backlog/);
  assert.throws(() => verifyWithArtifactEvidence(backlog(), reviewReport({
    provenance: { sourceModelSha256: "bad", renderManifestSha256: changedManifestSha },
  })), /source-model-sha256-invalid/);
  assert.throws(() => verifyWithArtifactEvidence(backlog(), reviewReport({
    comparisons: [
      reviewReport().comparisons[0],
      reviewReport().comparisons[0],
    ],
  })), /duplicate-verification-comparison/);
});


function spatialDiagnosticMetrics() {
  const cells = Array.from({ length: 16 }, (_, index) => {
    const cellX = index % 4;
    const cellY = Math.floor(index / 4);
    const edgeSampleCount = (cellX === 0 || cellX === 3 ? 15 : 16) *
      (cellY === 0 || cellY === 3 ? 15 : 16);
    const referenceEdgePixelCount = index + 1;
    const candidateEdgePixelCount = (index * 3) % 17;
    return {
      cellX,
      cellY,
      meanAbsoluteError: index + 1,
      meanSignedLuminanceOffset: index - 8,
      localSsim16x16: Number((0.5 + index / 100).toFixed(4)),
      edgeSampleCount,
      referenceEdgePixelCount,
      candidateEdgePixelCount,
      referenceEdgeDensity: Number((referenceEdgePixelCount / edgeSampleCount).toFixed(4)),
      candidateEdgeDensity: Number((candidateEdgePixelCount / edgeSampleCount).toFixed(4)),
      edgeDensityAbsoluteDifference: Number((
        Math.abs(referenceEdgePixelCount - candidateEdgePixelCount) / edgeSampleCount
      ).toFixed(4)),
    };
  });
  const medianOf = (values) => {
    const ordered = [...values].sort((left, right) => left - right);
    return (ordered[7] + ordered[8]) / 2;
  };
  const pixelRanked = [...cells].sort((left, right) =>
    right.meanAbsoluteError - left.meanAbsoluteError || left.cellY - right.cellY || left.cellX - right.cellX);
  const edgeRanked = [...cells].sort((left, right) =>
    right.edgeDensityAbsoluteDifference - left.edgeDensityAbsoluteDifference ||
    left.cellY - right.cellY || left.cellX - right.cellX);
  const errors = cells.map((cell) => cell.meanAbsoluteError);
  const edgeDifferences = cells.map((cell) => cell.edgeDensityAbsoluteDifference);
  return {
    spatialCellDiagnostics: cells,
    spatialCellMaeMedian: medianOf(errors),
    spatialCellMaeMaximum: Math.max(...errors),
    spatialCellMaeMedianGap: Math.max(...errors) - medianOf(errors),
    highestDifferenceCells: pixelRanked.slice(0, 4).map(({ cellX, cellY }) => ({ cellX, cellY })),
    localEdgeDensityDifferenceMedian: medianOf(edgeDifferences),
    localEdgeDensityDifferenceMaximum: Math.max(...edgeDifferences),
    highestEdgeDifferenceCells: edgeRanked.slice(0, 4).map(({ cellX, cellY }) => ({ cellX, cellY })),
    luminanceOffsetNormalizedMeanAbsoluteError: 18.5,
    luminanceOffsetNormalizedRootMeanSquaredError: 27.25,
    luminanceOffsetNormalizedSsim8x8: 0.61,
    luminanceOffsetNormalizedMaeReductionPercent: 66.6667,
  };
}

function storedSpatialHotspots() {
  return {
    coordinateSpace: "normalized-64x64-grayscale-preview-4x4-grid",
    gridSize: 4,
    note: "Descriptive image-space context only. Not facade coordinates.",
    pixelDifference: {
      medianMeanAbsoluteError: 22,
      maximumMeanAbsoluteError: 44,
      maximumAboveMedian: 22,
      highestDifferenceCells: [
        { cellX: 0, cellY: 0, meanAbsoluteError: 44, meanSignedLuminanceOffset: -5, localSsim16x16: 0.6 },
        { cellX: 1, cellY: 0, meanAbsoluteError: 38, meanSignedLuminanceOffset: -4, localSsim16x16: 0.7 },
        { cellX: 2, cellY: 0, meanAbsoluteError: 30, meanSignedLuminanceOffset: 2, localSsim16x16: 0.8 },
        { cellX: 3, cellY: 0, meanAbsoluteError: 28, meanSignedLuminanceOffset: 1, localSsim16x16: 0.8 },
      ],
    },
    edgeStructure: {
      medianAbsoluteEdgeDensityDifference: 0.04,
      maximumAbsoluteEdgeDensityDifference: 0.2,
      highestEdgeDifferenceCells: [
        { cellX: 0, cellY: 0, edgeDensityAbsoluteDifference: 0.2, referenceEdgeDensity: 0.3, candidateEdgeDensity: 0.1, referenceEdgePixelCount: 45, candidateEdgePixelCount: 15 },
        { cellX: 1, cellY: 0, edgeDensityAbsoluteDifference: 0.15, referenceEdgeDensity: 0.25, candidateEdgeDensity: 0.1, referenceEdgePixelCount: 60, candidateEdgePixelCount: 24 },
        { cellX: 2, cellY: 0, edgeDensityAbsoluteDifference: 0.12, referenceEdgeDensity: 0.2, candidateEdgeDensity: 0.08, referenceEdgePixelCount: 48, candidateEdgePixelCount: 19 },
        { cellX: 3, cellY: 0, edgeDensityAbsoluteDifference: 0.1, referenceEdgeDensity: 0.2, candidateEdgeDensity: 0.1, referenceEdgePixelCount: 45, candidateEdgePixelCount: 22 },
      ],
    },
  };
}

test("reports before/after hotspot overlap as image-space context without affecting verification status", () => {
  const originalTask = task({
    evidence: {
      ...task().evidence,
      similarityDiagnostics: {
        reportSha256: "2".repeat(64),
        renderSha256,
        referenceSha256,
        warnings: ["localized-image-difference-screening-hint"],
        automaticMatch: false,
        spatialHotspots: storedSpatialHotspots(),
      },
    },
  });
  const sourceBacklog = backlog({ tasks: [originalTask] });
  const nextReport = reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      similarityDiagnostics: similarityDiagnostics({
        metrics: {
          meanAbsoluteError: 55.5,
          rootMeanSquaredError: 72.25,
          psnrDb: 10.96,
          localSsim8x8: 0.12,
          differenceHashHammingDistance: 51,
          ...spatialDiagnosticMetrics(),
        },
      }),
    }],
  });

  const result = verifyWithArtifactEvidence(sourceBacklog, nextReport);
  const taskResult = result.tasks[0];
  assert.equal(taskResult.status, "verified");
  assert.equal(taskResult.verified, true);
  assert.equal(taskResult.matchedEvidence.similarityDiagnostics.spatialHotspots.gridSize, 4);
  assert.equal(taskResult.matchedEvidence.similarityDiagnostics.metrics.luminanceOffsetNormalizedSsim8x8, 0.61);
  assert.equal(taskResult.diagnosticHotspotComparison.coordinateSpace,
    "normalized-64x64-grayscale-preview-4x4-grid");
  assert.equal(taskResult.diagnosticHotspotComparison.affectsVerificationStatus, false);
  assert.equal(taskResult.diagnosticHotspotComparison.pixelDifference.sharedCellCount, 0);
  assert.deepEqual(taskResult.diagnosticHotspotComparison.pixelDifference.baselineOnlyCells,
    [{ cellX: 0, cellY: 0 }, { cellX: 1, cellY: 0 }, { cellX: 2, cellY: 0 }, { cellX: 3, cellY: 0 }]);
  assert.equal(taskResult.diagnosticHotspotComparison.edgeStructure.baselineAvailable, true);
  assert.equal(taskResult.diagnosticHotspotComparison.edgeStructure.verificationAvailable, true);
  assert.equal(result.similarityDiagnosticsSummary.comparisonsWithSpatialHotspots, 1);
  assert.equal(result.similarityDiagnosticsSummary.tasksWithHotspotComparison, 1);
  assert.equal(result.automationPolicy.hotspotOverlapAffectsVerificationStatus, false);
  assert.equal(result.automationPolicy.publicationEligible, false);
});

test("rejects malformed before/after hotspot evidence rather than comparing untrusted coordinates", () => {
  const invalidStored = storedSpatialHotspots();
  invalidStored.pixelDifference.highestDifferenceCells[1].cellX = 0;
  const sourceTask = task({
    evidence: {
      ...task().evidence,
      similarityDiagnostics: {
        reportSha256: "2".repeat(64),
        renderSha256,
        referenceSha256,
        warnings: [],
        automaticMatch: false,
        spatialHotspots: invalidStored,
      },
    },
  });
  assert.throws(() => verifyWithArtifactEvidence(backlog({ tasks: [sourceTask] }), reviewReport()),
    /backlog-spatial-hotspots-invalid/);

  const invalidFreshMetrics = spatialDiagnosticMetrics();
  invalidFreshMetrics.highestDifferenceCells = [
    { cellX: 0, cellY: 0 }, { cellX: 1, cellY: 0 },
    { cellX: 2, cellY: 0 }, { cellX: 3, cellY: 0 },
  ];
  assert.throws(() => verifyWithArtifactEvidence(backlog(), reviewReport({
    comparisons: [{
      ...reviewReport().comparisons[0],
      similarityDiagnostics: similarityDiagnostics({
        metrics: {
          meanAbsoluteError: 55.5,
          rootMeanSquaredError: 72.25,
          psnrDb: 10.96,
          localSsim8x8: 0.12,
          differenceHashHammingDistance: 51,
          ...invalidFreshMetrics,
        },
      }),
    }],
  })), /spatial-hotspots-invalid/);
});

test("legacy correction tasks without baseline hotspots remain verifiable and report no hotspot delta", () => {
  const result = verifyWithArtifactEvidence(backlog(), reviewReport());
  assert.equal(result.tasks[0].status, "verified");
  assert.equal(result.tasks[0].diagnosticHotspotComparison, null);
  assert.equal(result.similarityDiagnosticsSummary.tasksWithHotspotComparison, 0);
});
