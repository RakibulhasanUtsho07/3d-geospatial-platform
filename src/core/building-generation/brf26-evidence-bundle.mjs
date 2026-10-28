const SHA256 = /^[a-f0-9]{64}$/i;
const RELEASE_FLAGS = ["acceptanceEligible", "publicationEligible", "mapReady", "automaticApproval"];
const ARTIFACT_KEYS = [
  "sourceReviewDecision", "authorizationRecord", "candidateGlb", "geometryValidationReport",
  "preparedManifest", "evaluationReport", "independentReference", "sourceCameraReport",
  "renderManifest", "visualReviewDecision",
];
export const BRF26_REQUIRED_ARTIFACT_KEYS = ARTIFACT_KEYS;
const SURVEY_BASES = new Set(["surveyed", "official-survey", "lidar", "cad-bim", "published-measurement"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function hash(value) {
  return typeof value === "string" && SHA256.test(value);
}
function timestampUtc(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}
function flagsFalse(value) {
  return object(value) && RELEASE_FLAGS.every((key) => value[key] === false);
}
function modelHashClaims(value) {
  const nested = object(value?.manifest) ? value.manifest : {};
  return [
    value?.candidateGlbSha256, value?.modelSha256, value?.model?.sha256,
    nested.candidateGlbSha256, nested.modelSha256, nested.model?.sha256,
  ].filter((item) => item !== undefined && item !== null && item !== "");
}
function bindsEveryModelHash(value, expectedSha256) {
  const claims = modelHashClaims(value);
  return claims.length > 0 && claims.every((item) => hash(item) && item.toLowerCase() === expectedSha256);
}
function buildingIdClaims(value) {
  const nested = object(value?.manifest) ? value.manifest : {};
  return [value?.buildingId, nested.buildingId]
    .filter((item) => item !== undefined && item !== null && item !== "");
}
function checkFactory() {
  const checks = [];
  const failures = [];
  const blockers = [];
  const check = (id, passed, detail, failureKind = "blocked") => {
    const status = passed ? "passed" : failureKind;
    const item = { id, status, detail };
    checks.push(item);
    if (!passed && failureKind === "failed") failures.push(item);
    if (!passed && failureKind === "blocked") blockers.push(item);
  };
  return { checks, failures, blockers, check };
}

/**
 * Assess the cross-artifact chain for BRF-26.
 * Artifact entries contain recomputed/expected SHA-256, path, byte size, parsed
 * JSON for JSON files, and any read/parse error. This is review-readiness only.
 */
export function assessBrf26EvidenceBundle(input = {}) {
  const { checks, failures, blockers, check } = checkFactory();
  const manifest = input.manifest;
  const artifacts = input.artifacts;

  check("manifest-schema", object(manifest) &&
    manifest.schemaVersion === "1.0.0" &&
    manifest.recordType === "brf-26-evidence-bundle-manifest" &&
    /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(manifest.bundleId ?? "") &&
    /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(manifest.buildingId ?? "") &&
    ["real-evidence", "synthetic-test"].includes(manifest.evidenceMode),
  "Manifest must define a supported schema, safe IDs, and explicit evidence mode.", "failed");

  for (const key of ARTIFACT_KEYS) {
    const item = artifacts?.[key];
    if (!object(item)) {
      check("artifact-present-" + key, false, "Required artifact is not declared: " + key + ".", "blocked");
      continue;
    }
    if (item.error) {
      check("artifact-readable-" + key, false,
        item.errorKind === "missing" ? "Required artifact is missing: " + key + "." :
          "Required artifact could not be safely read: " + key + " (" + item.error + ").",
        item.errorKind === "missing" ? "blocked" : "failed");
      continue;
    }
    check("artifact-hash-pinned-" + key, hash(item.expectedSha256) &&
      item.expectedSha256.toLowerCase() === item.actualSha256?.toLowerCase(),
    "Manifest SHA-256 must match the SHA-256 recomputed from the exact " + key + " bytes.", "failed");
    if (item.parseError) {
      check("artifact-json-valid-" + key, false, key + " is not valid JSON: " + item.parseError, "failed");
    } else if (item.jsonRequired !== false) {
      check("artifact-json-object-" + key, object(item.value), key + " must be a JSON object.", "failed");
    }
  }

  const unusable = ARTIFACT_KEYS.some((key) => {
    const item = artifacts?.[key];
    return !object(item) || Boolean(item.error) || Boolean(item.parseError) ||
      (item.jsonRequired !== false && !object(item.value));
  });
  if (unusable) return buildOutput(input, checks, failures, blockers, null);

  const review = artifacts.sourceReviewDecision.value;
  const authorization = artifacts.authorizationRecord.value;
  const geometry = artifacts.geometryValidationReport.value;
  const prepared = artifacts.preparedManifest.value;
  const evaluation = artifacts.evaluationReport.value;
  const reference = artifacts.independentReference.value;
  const sourceCamera = artifacts.sourceCameraReport.value;
  const renderManifest = artifacts.renderManifest.value;
  const visual = artifacts.visualReviewDecision.value;
  const candidateSha = artifacts.candidateGlb.actualSha256?.toLowerCase();
  const candidateSize = artifacts.candidateGlb.byteSize;

  check("real-evidence-mode", manifest.evidenceMode === "real-evidence",
    "Synthetic test fixtures can never produce a real-evidence sign-off-ready disposition.", "blocked");
  check("candidate-path-bound-to-workspace", input.candidatePathBindingValid === true,
    "The actual candidate path must equal the authorization-relative path inside the reviewed workspace.", "failed");

  check("source-review-schema", review.recordType === "brf-21-human-review-decision" &&
    review.schemaVersion === "1.0.0",
  "Source review must be the BRF-21 reviewer-authored decision record.", "failed");
  check("source-review-complete", review.overallDisposition === "continue-to-reconstruction-preflight" &&
    object(review.reviewer) && nonempty(review.reviewer.name) && nonempty(review.reviewer.identifier) &&
    timestampUtc(review.reviewedAtUtc),
  "A complete reviewer decision with explicit UTC timestamp is required.", "blocked");
  check("source-identity-confirmed", review.sameBuildingIdentity?.decision === "confirmed",
    "Human review must confirm that the selected views show the same building.", "blocked");
  check("source-coverage-adequate", review.coverageAssessment?.decision === "adequate",
    "Human review must confirm adequate source coverage.", "blocked");
  check("source-rights-approved", review.assetRights?.decision === "approved-for-this-use",
    "Rights must be reviewed and approved for this intended use.", "blocked");
  check("source-axis-confirmed", review.sourceUpAxis?.decision === "confirmed" &&
    ["X", "Y", "Z"].includes(review.sourceUpAxis?.axis) &&
    ["positive", "negative"].includes(review.sourceUpAxis?.positiveDirection),
  "The source up-axis must be explicitly reviewed.", "blocked");
  check("source-review-release-flags-false", flagsFalse(review),
    "Source review must keep all release gates false.", "failed");
  check("source-review-sample-bound", !nonempty(manifest.sampleId) || review.sampleId === manifest.sampleId,
    "Manifest sampleId must match the reviewed source sample when supplied.", "failed");

  const reviewHash = artifacts.sourceReviewDecision.actualSha256?.toLowerCase();
  check("authorization-schema", authorization.recordType === "brf-24-colmap-execution-authorization" &&
    authorization.schemaVersion === "1.0.0",
  "Authorization must use the BRF-24 schema.", "failed");
  check("authorization-review-hash", hash(authorization.humanDecision?.sha256) &&
    authorization.humanDecision.sha256.toLowerCase() === reviewHash,
  "BRF-24 must bind to the exact reviewer-decision bytes.", "failed");
  check("authorization-reviewer-match", authorization.humanDecision?.reviewer?.name === review.reviewer?.name &&
    authorization.humanDecision?.reviewer?.identifier === review.reviewer?.identifier &&
    authorization.humanDecision?.reviewedAtUtc === review.reviewedAtUtc &&
    authorization.humanDecision?.overallDisposition === review.overallDisposition,
  "BRF-24 reviewer fields must match the hash-bound source review record.", "failed");
  check("authorization-candidate-generated", authorization.status === "candidate-generated-requires-review" &&
    authorization.candidateGlbGenerated === true && object(authorization.candidateGlb),
  "A real worker-generated candidate GLB is required; an authorization to attempt reconstruction is insufficient.", "blocked");
  check("authorization-release-flags-false", flagsFalse(authorization) &&
    authorization.candidateGeometryValidated === false &&
    authorization.independentReferenceVerified === false &&
    authorization.heldOutCheckpointAccuracyVerified === false,
  "Authorization must not pre-assert geometry, independent truth, held-out accuracy or release approval.", "failed");
  check("authorization-candidate-hash", hash(authorization.candidateGlb?.sha256) &&
    authorization.candidateGlb.sha256.toLowerCase() === candidateSha,
  "Candidate GLB bytes must match the hash recorded by the reconstruction worker.", "failed");
  check("authorization-candidate-size", Number.isSafeInteger(authorization.candidateGlb?.byteSize) &&
    authorization.candidateGlb.byteSize === candidateSize && candidateSize > 0,
  "Candidate GLB byte size must match the worker authorization record.", "failed");
  check("candidate-manifest-hash", artifacts.candidateGlb.expectedSha256?.toLowerCase() === candidateSha,
    "Candidate artifact manifest hash must equal the current candidate bytes.", "failed");

  check("geometry-report-schema", geometry.recordType === "brf-25-geometry-validation" &&
    geometry.schemaVersion === "1.0.0",
  "Geometry report must be produced by the BRF-25 validation runner.", "failed");
  check("geometry-report-candidate-binding", geometry.binding?.candidateGlbSha256?.toLowerCase() === candidateSha,
    "BRF-25 must bind its geometry extraction to the same candidate GLB.", "failed");
  check("prepared-manifest-binding", geometry.artifacts?.preparedManifest?.path === artifacts.preparedManifest.path &&
    geometry.artifacts?.preparedManifest?.sha256?.toLowerCase() === artifacts.preparedManifest.actualSha256?.toLowerCase() &&
    geometry.artifacts?.preparedManifest?.candidateGlbSha256?.toLowerCase() === candidateSha &&
    prepared.preparation?.exactCandidateGlbSha256?.toLowerCase() === candidateSha,
  "Prepared geometry manifest path/hash and candidate binding must match the BRF-25 report.", "failed");
  check("evaluation-report-binding", geometry.artifacts?.evaluationReport?.path === artifacts.evaluationReport.path &&
    geometry.artifacts?.evaluationReport?.sha256?.toLowerCase() === artifacts.evaluationReport.actualSha256?.toLowerCase() &&
    evaluation.candidate?.glbSha256?.toLowerCase() === candidateSha,
  "Independent-truth evaluation path/hash and candidate binding must match BRF-25.", "failed");
  check("independent-reference-binding", hash(evaluation.reference?.sourceSha256) &&
    evaluation.reference.sourceSha256.toLowerCase() === artifacts.independentReference.actualSha256?.toLowerCase() &&
    prepared.preparation?.exactReferenceSourceSha256?.toLowerCase() === artifacts.independentReference.actualSha256?.toLowerCase(),
  "Prepared geometry and evaluation reports must bind to the exact independent-reference bytes.", "failed");
  check("independent-reference-descriptor", object(reference) && nonempty(reference.sourceId) &&
    nonempty(reference.sourceDescription),
  "Independent-reference bytes must describe a source and identify the referenced survey/model.", "blocked");
  check("independent-reference-provenance", nonempty(evaluation.reference?.sourceId) &&
    SURVEY_BASES.has(evaluation.reference?.evidenceBasis) &&
    nonempty(evaluation.reference?.reviewedBy) && timestampUtc(evaluation.reference?.reviewedAt) &&
    evaluation.reference?.independentlyAuthenticated === false,
  "Independent reference needs declared source, survey basis and curation metadata; this tool does not authenticate them.", "blocked");
  check("held-out-checkpoints-present", Number.isSafeInteger(prepared.preparation?.extractedHeldOutCheckPointCount) &&
    prepared.preparation.extractedHeldOutCheckPointCount > 0 &&
    evaluation.metrics?.checkPoints?.matchedPointCount === prepared.preparation.extractedHeldOutCheckPointCount &&
    evaluation.checks?.some((item) => item.id === "check-points-excluded-from-fit" && item.status === "passed"),
  "At least one matching held-out checkpoint must be extracted from the actual GLB and declared independent of fit.", "blocked");
  check("geometry-runner-has-no-explicit-failure", !["geometry-extraction-failed", "independent-evaluation-failed", "geometry-evaluation-failed"].includes(geometry.status) &&
    evaluation.status !== "benchmark-failed",
  "BRF-25 geometry extraction/evaluation must not report an explicit failure.", "failed");
  check("geometry-metrics-complete", geometry.status === "geometry-evaluated-review-required" &&
    evaluation.status === "benchmark-review-required" &&
    evaluation.counts?.failures === 0 && evaluation.counts?.warnings === 0 &&
    Array.isArray(evaluation.failures) && evaluation.failures.length === 0,
  "BRF-25 must finish metric evaluation without metric failures or warnings; review is still required.", "blocked");
  check("geometry-release-flags-false", flagsFalse(geometry.policy) && flagsFalse(evaluation.policy),
    "Geometry/evaluator policy objects must keep every release flag false.", "failed");

  const sourceCameraBuildingIds = buildingIdClaims(sourceCamera);
  check("source-camera-building-binding", sourceCameraBuildingIds.length > 0 &&
    sourceCameraBuildingIds.every((value) => value === manifest.buildingId),
  "Source-camera evidence must declare the same building ID as the bundle manifest.", "failed");
  check("source-camera-candidate-binding", bindsEveryModelHash(sourceCamera, candidateSha),
    "Source-camera evidence must bind its model hash to the exact candidate GLB bytes.", "failed");

  const renderManifestBuildingIds = buildingIdClaims(renderManifest);
  check("render-manifest-building-binding", renderManifestBuildingIds.length === 0 ||
    renderManifestBuildingIds.every((value) => value === manifest.buildingId),
  "Any building ID declared by the render manifest must match the bundle building.", "failed");
  check("render-manifest-candidate-binding", bindsEveryModelHash(renderManifest, candidateSha),
    "The fixed-camera render manifest must bind its model hash to the exact candidate GLB bytes.", "failed");

  const renderViews = Array.isArray(renderManifest.views) ? renderManifest.views :
    Array.isArray(renderManifest.manifest?.views) ? renderManifest.manifest.views : null;
  const renderViewIds = Array.isArray(renderViews) ? renderViews.map((view) =>
    object(view) ? (nonempty(view.id) ? view.id : view.viewId) : null) : [];
  const renderViewIdsValid = renderViewIds.length > 0 &&
    renderViewIds.every(nonempty) &&
    new Set(renderViewIds).size === renderViewIds.length;
  check("render-manifest-view-set", renderViewIdsValid,
    "Render manifest must contain a non-empty set of uniquely identified fixed-camera views.", "failed");
  check("render-manifest-render-complete", renderViewIdsValid && renderViews.every((view) =>
    object(view) && view.renderComplete === true),
  "Every render-manifest view must be explicitly marked renderComplete=true.", "blocked");

  check("visual-review-schema", visual.recordType === "brf-26-visual-review-decision" &&
    visual.schemaVersion === "1.0.0",
  "Visual review must use the BRF-26 human-authored decision schema.", "failed");
  check("visual-review-building-id", visual.buildingId === manifest.buildingId,
    "Visual review decision must identify the same building as the bundle manifest.", "failed");
  check("visual-review-candidate-binding", visual.candidateGlbSha256?.toLowerCase() === candidateSha,
    "Visual review decision must pin the exact same GLB SHA-256.", "failed");
  check("visual-review-evidence-binding", visual.sourceCameraReportSha256?.toLowerCase() === artifacts.sourceCameraReport.actualSha256?.toLowerCase() &&
    visual.renderManifestSha256?.toLowerCase() === artifacts.renderManifest.actualSha256?.toLowerCase(),
  "Visual review must pin the exact source-camera report and render-manifest bytes.", "failed");
  check("visual-review-status-complete", visual.status === "human-review-complete",
    "Visual-review decision must be explicitly marked human-review-complete.", "blocked");
  check("visual-review-reviewer", object(visual.reviewer) && nonempty(visual.reviewer.name) &&
    nonempty(visual.reviewer.identifier) && timestampUtc(visual.reviewedAtUtc),
  "Visual review requires a named reviewer, identifier, and explicit UTC timestamp.", "blocked");
  check("visual-review-release-flags-false", flagsFalse(visual),
    "Human visual review must not set model release flags.", "failed");
  const views = visual.views;
  const visualViewIds = Array.isArray(views) ? views.map((view) => object(view) ? view.viewId : null) : [];
  const visualViewIdsValid = visualViewIds.length > 0 &&
    visualViewIds.every(nonempty) &&
    new Set(visualViewIds).size === visualViewIds.length;
  check("visual-views-reviewed", visualViewIdsValid && views.every((view) => object(view) &&
    ["pass", "fail", "not-comparable"].includes(view.disposition) && nonempty(view.rationale)),
  "Every reviewed view must have a unique ID, a disposition and a rationale; pending/empty templates cannot pass.", "blocked");
  check("visual-review-view-coverage", renderViewIdsValid && visualViewIdsValid &&
    renderViewIds.length === visualViewIds.length &&
    renderViewIds.every((viewId) => visualViewIds.includes(viewId)),
  "Human review must cover every render-manifest view exactly once; omitted or invented view IDs block sign-off.", "blocked");
  check("visual-review-disposition", visual.overallDisposition === "pass",
    visual.overallDisposition === "fail" ? "Human visual review rejected the candidate." :
      visual.overallDisposition === "not-comparable" ? "Visual evidence is not comparable." :
        "Visual review remains pending or did not explicitly pass.",
    visual.overallDisposition === "fail" ? "failed" : "blocked");
  check("visual-review-all-views-pass", Array.isArray(views) && views.length > 0 &&
    views.every((view) => view.disposition === "pass"),
  "Every included visual comparison must pass; not-comparable views cannot be silently counted as passing.", "blocked");

  const result = {
    schemaVersion: "1.0.0",
    recordType: "brf-26-evidence-bundle",
    bundleId: manifest.bundleId ?? null,
    buildingId: manifest.buildingId ?? null,
    evidenceMode: manifest.evidenceMode ?? "unknown",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    checks,
    blockers,
    failures,
    artifacts: Object.fromEntries(ARTIFACT_KEYS.map((key) => {
      const item = artifacts?.[key];
      return [key, object(item) ? {
        path: item.path ?? null, expectedSha256: item.expectedSha256 ?? null,
        actualSha256: item.actualSha256 ?? null, byteSize: item.byteSize ?? null,
        integrity: item.error ? item.errorKind === "missing" ? "missing" : "unreadable" :
          item.parseError ? "invalid-json" :
            hash(item.expectedSha256) && item.expectedSha256.toLowerCase() === item.actualSha256?.toLowerCase() ? "verified" : "hash-mismatch",
      } : null];
    })),
    candidate: hash(candidateSha) ? { glbSha256: candidateSha, byteSize: candidateSize } : null,
    geometry: {
      runnerStatus: geometry.status ?? null,
      evaluatorStatus: evaluation.status ?? null,
      matchedHeldOutCheckpointCount: evaluation.metrics?.checkPoints?.matchedPointCount ?? null,
      independentReferenceSha256: evaluation.reference?.sourceSha256 ?? null,
      independentReferenceBasis: evaluation.reference?.evidenceBasis ?? null,
    },
    visualReview: {
      status: visual.status ?? "missing",
      disposition: visual.overallDisposition ?? "pending",
      reviewer: visual.reviewer ?? null,
      sourceCameraReportSha256: visual.sourceCameraReportSha256 ?? null,
      renderManifestSha256: visual.renderManifestSha256 ?? null,
    },
    policy: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false },
    limitations: [
      "A hash binds supplied bytes; it does not authenticate reviewer identity, copyright/asset-rights claims, survey provenance, or reference independence.",
      "The bundle validates declarations and cross-artifact consistency; a qualified reviewer must inspect the source, geometry, metric and visual evidence.",
      "Synthetic test evidence can verify software behaviour only and can never produce a real-evidence sign-off-ready disposition.",
      "READY_FOR_HUMAN_SIGNOFF is not model acceptance, publication approval, map readiness, or automatic approval.",
    ],
  };
  return buildOutput(input, checks, failures, blockers, result);
}

function buildOutput(input, checks, failures, blockers, result) {
  const manifest = input.manifest ?? {};
  const artifacts = input.artifacts ?? {};
  if (!result) {
    result = {
      schemaVersion: "1.0.0",
      recordType: "brf-26-evidence-bundle",
      bundleId: manifest.bundleId ?? null,
      buildingId: manifest.buildingId ?? null,
      evidenceMode: manifest.evidenceMode ?? "unknown",
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      candidate: null,
      geometry: null,
      visualReview: { status: "unknown", disposition: "pending" },
      artifacts: Object.fromEntries(ARTIFACT_KEYS.map((key) => {
        const item = artifacts[key];
        return [key, object(item) ? {
          path: item.path ?? null, expectedSha256: item.expectedSha256 ?? null,
          actualSha256: item.actualSha256 ?? null, byteSize: item.byteSize ?? null,
          integrity: item.error ? item.errorKind === "missing" ? "missing" : "unreadable" :
            item.parseError ? "invalid-json" :
              hash(item.expectedSha256) && item.expectedSha256.toLowerCase() === item.actualSha256?.toLowerCase() ? "verified" : "hash-mismatch",
        } : null];
      })),
      policy: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false },
      limitations: ["The bundle is a provenance/review readiness record only; no release flag is enabled."],
    };
  }
  result.checks = checks;
  result.failures = failures;
  result.blockers = blockers;
  result.status = failures.length ? "VALIDATION_FAILED" : blockers.length ? "BLOCKED" : "REVIEW_REQUIRED";
  result.finalDisposition = result.status;
  if (!failures.length && !blockers.length && manifest.evidenceMode === "real-evidence") {
    result.status = "READY_FOR_HUMAN_SIGNOFF";
    result.finalDisposition = result.status;
  }
  result.policy = { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false };
  return result;
}
