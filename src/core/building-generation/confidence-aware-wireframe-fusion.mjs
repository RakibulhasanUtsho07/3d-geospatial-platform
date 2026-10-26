import { normalizeArchitecturalObservationBatch } from "./architectural-observation-schema.mjs";
import { validateCameraProjectionEvidence } from "./camera-projection-validation.mjs";
import { robustTriangulateCorrespondence } from "./multi-view-wireframe-registration.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const round4 = (value) => Number(value.toFixed(4));
const refKey = (ref) => ref.batchId + "\u0000" + ref.observationId;

function safeId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(label + " must be a safe identifier.");
  return value;
}
function validateConfidence(value, label) {
  if (!finite(value) || value < 0 || value > 1) throw new RangeError(label + " must be between 0 and 1.");
  return value;
}
function validReview(reviewedBy, reviewedAt) {
  return typeof reviewedBy === "string" && reviewedBy.trim().length > 0 &&
    typeof reviewedAt === "string" && Number.isFinite(Date.parse(reviewedAt));
}
function normalizeReviewStatus(status) {
  return ["proposed", "accepted", "review-required", "rejected", "conflict"].includes(status);
}
function sourceObservation(batch, observation, cameraId) {
  return {
    batchId: batch.batchId,
    observationId: observation.id,
    buildingId: batch.buildingId,
    viewId: batch.viewId,
    cameraId,
    sourceId: batch.source.id,
    sourceSha256: batch.source.sha256,
    sourceWidth: batch.source.width,
    sourceHeight: batch.source.height,
    category: observation.category,
    sourcePixel: observation.geometry?.type === "Point" ? observation.geometry.coordinates.slice() : null,
    sourceGeometryType: observation.geometry?.type ?? null,
    observationConfidence: observation.confidence,
    observationStatus: observation.status,
    visibility: observation.visibility,
    ...(observation.reviewedBy ? { reviewedBy: observation.reviewedBy } : {}),
    ...(observation.reviewedAt ? { reviewedAt: observation.reviewedAt } : {}),
    evidence: { ...observation.evidence },
  };
}
function confidenceReport(groupConfidence, sourceObservations, geometry, threshold, calibrationReady) {
  const meanObservationConfidence = sourceObservations.length
    ? sourceObservations.reduce((sum, item) => sum + item.observationConfidence, 0) / sourceObservations.length : 0;
  const inlierRatio = geometry.viewCount > 0 ? geometry.consensusSize / geometry.viewCount : 0;
  const residualQuality = finite(geometry.inlierRmsReprojectionError)
    ? 1 / (1 + geometry.inlierRmsReprojectionError / threshold) : 0;
  const parallaxQuality = geometry.parallax?.status === "adequate" ? 1
    : geometry.parallax?.status === "low" ? 0.5 : 0.25;
  const calibrationQuality = calibrationReady ? 1 : 0.6;
  const score = clamp01(groupConfidence * meanObservationConfidence * inlierRatio *
    residualQuality * parallaxQuality * calibrationQuality);
  return {
    score: round4(score),
    semantics: "heuristic-confidence-score-not-a-calibrated-probability",
    components: {
      correspondenceConfidence: round4(groupConfidence),
      meanObservationConfidence: round4(meanObservationConfidence),
      inlierRatio: round4(inlierRatio),
      residualQuality: round4(residualQuality),
      parallaxQuality,
      calibrationQuality,
    },
  };
}

/**
 * Fuse reviewed image-space observations into a sparse, provenance-preserving graph.
 * A correspondence group is one physical 3D feature; groups may only enter as accepted
 * geometry when the observations and correspondence have review attestations and the
 * robust geometric checks pass. Output is always a non-publishable candidate.
 */
export function fuseReviewedObservationsIntoWireframe({
  buildingId,
  cameras,
  observationBatches,
  correspondences,
  edgeProposals = [],
  facadeInventory = [],
  facadeCoverage = [],
  viewCameraMap = [],
  options = {},
} = {}) {
  safeId(buildingId, "buildingId");
  if (!Array.isArray(cameras) || cameras.length < 2) throw new RangeError("at least two cameras are required.");
  if (!Array.isArray(observationBatches) || !observationBatches.length) throw new TypeError("observationBatches must be a non-empty array.");
  if (!Array.isArray(correspondences) || !correspondences.length) throw new TypeError("correspondences must be a non-empty array.");
  if (!Array.isArray(edgeProposals)) throw new TypeError("edgeProposals must be an array.");
  if (!Array.isArray(facadeInventory) || !Array.isArray(facadeCoverage) || !Array.isArray(viewCameraMap)) {
    throw new TypeError("facade and view-camera inputs must be arrays.");
  }

  const cameraById = new Map();
  for (const camera of cameras) {
    safeId(camera?.id, "camera.id");
    if (cameraById.has(camera.id)) throw new TypeError("camera ids must be unique.");
    cameraById.set(camera.id, camera);
  }
  const cameraEvidence = validateCameraProjectionEvidence({ cameras });
  if (cameraEvidence.status === "failed") {
    throw new TypeError("camera projection evidence failed validation: " +
      cameraEvidence.errors.map((issue) => issue.code + (issue.cameraId ? ":" + issue.cameraId : "")).join(", "));
  }
  const calibrationReady = cameraEvidence.status === "structurally-valid";

  const explicitViewCamera = new Map();
  for (const item of viewCameraMap) {
    safeId(item?.viewId, "viewCameraMap.viewId");
    safeId(item?.cameraId, "viewCameraMap.cameraId");
    if (explicitViewCamera.has(item.viewId)) throw new TypeError("viewCameraMap viewIds must be unique.");
    if (!cameraById.has(item.cameraId)) throw new TypeError("viewCameraMap references an unknown camera.");
    explicitViewCamera.set(item.viewId, item.cameraId);
  }
  const cameraIdForView = (viewId) => explicitViewCamera.get(viewId) ?? viewId;
  const batches = new Map(), observationByRef = new Map(), cameraForBatch = new Map();
  for (const rawBatch of observationBatches) {
    const batch = normalizeArchitecturalObservationBatch(rawBatch);
    if (batch.buildingId !== buildingId) throw new TypeError("all observation batches must match buildingId.");
    if (batches.has(batch.batchId)) throw new TypeError("observation batch IDs must be unique.");
    const cameraId = cameraIdForView(batch.viewId), camera = cameraById.get(cameraId);
    if (!camera) throw new TypeError("no calibrated camera is mapped to view " + batch.viewId + ".");
    if (camera.imageSize.width !== batch.source.width || camera.imageSize.height !== batch.source.height) {
      throw new TypeError("camera imageSize must match the hash-pinned source dimensions for view " + batch.viewId + ".");
    }
    batches.set(batch.batchId, batch);
    cameraForBatch.set(batch.batchId, cameraId);
    for (const observation of batch.observations) {
      observationByRef.set(batch.batchId + "\u0000" + observation.id, {
        batch, observation, cameraId,
        provenance: sourceObservation(batch, observation, cameraId),
      });
    }
  }

  const groupIds = new Set();
  const groups = correspondences.map((group, index) => {
    safeId(group?.id, "correspondences[" + index + "].id");
    if (groupIds.has(group.id)) throw new TypeError("correspondence IDs must be unique.");
    groupIds.add(group.id);
    if (!normalizeReviewStatus(group.status)) throw new TypeError("correspondence status is unsupported.");
    validateConfidence(group.confidence, "correspondence confidence");
    if (!Array.isArray(group.observationRefs) || group.observationRefs.length < 2) {
      throw new TypeError("each correspondence needs at least two observationRefs.");
    }
    const seen = new Set();
    const refs = group.observationRefs.map((rawRef) => {
      safeId(rawRef?.batchId, "observationRefs.batchId");
      safeId(rawRef?.observationId, "observationRefs.observationId");
      const key = refKey(rawRef);
      if (seen.has(key)) throw new TypeError("a correspondence cannot repeat the same source observation.");
      seen.add(key);
      if (!observationByRef.has(key)) throw new TypeError("correspondence references an unknown source observation: " + key.replace("\u0000", "/"));
      return { batchId: rawRef.batchId, observationId: rawRef.observationId };
    });
    return { ...group, observationRefs: refs };
  });

  // A source observation assigned to two physical features is an explicit correspondence conflict.
  const ownersByObservation = new Map();
  for (const group of groups) for (const ref of group.observationRefs) {
    const key = refKey(ref);
    if (!ownersByObservation.has(key)) ownersByObservation.set(key, []);
    ownersByObservation.get(key).push(group.id);
  }
  const conflictGroups = new Set();
  for (const [key, owners] of ownersByObservation) if (owners.length > 1) {
    owners.forEach((owner) => conflictGroups.add(owner));
  }

  const issues = [];
  const vertices = [];
  const vertexById = new Map();
  const correspondenceReports = [];
  const threshold = options.maxReprojectionErrorPixels ?? 3;
  const minParallaxDeg = options.minParallaxDeg ?? 1;
  const maxPairHypotheses = options.maxPairHypotheses ?? 128;
  const cameraList = [...cameraById.values()];

  for (const group of groups) {
    const report = { correspondenceId: group.id, sourceObservationCount: group.observationRefs.length,
      inputStatus: group.status, status: "review-required", reason: null, vertexId: null };
    correspondenceReports.push(report);
    if (group.status === "rejected") {
      report.status = "rejected"; report.reason = "correspondence-rejected-by-review";
      continue;
    }
    if (conflictGroups.has(group.id) || group.status === "conflict") {
      report.reason = "observation-assigned-to-conflicting-correspondence-groups";
      issues.push({ type: "correspondence-conflict", correspondenceId: group.id, observationRefs: group.observationRefs });
      continue;
    }
    const resolved = group.observationRefs.map((ref) => observationByRef.get(refKey(ref)));
    if (resolved.some((item) => item.observation.status !== "reviewed" ||
        item.observation.visibility !== "visible" || item.observation.geometry?.type !== "Point")) {
      report.reason = "correspondence-requires-reviewed-visible-point-observations";
      issues.push({ type: "correspondence-observation-not-ready", correspondenceId: group.id });
      continue;
    }
    const viewIds = resolved.map((item) => item.batch.viewId);
    if (new Set(viewIds).size !== viewIds.length) {
      report.reason = "multiple-observations-from-one-view";
      issues.push({ type: "correspondence-conflict", correspondenceId: group.id, reason: report.reason });
      continue;
    }

    const correspondenceAttested = group.status === "accepted" && validReview(group.reviewedBy, group.reviewedAt);
    const sourceObservations = resolved.map((item) => item.provenance);
    const imageObservations = resolved.map((item) => ({
      cameraId: item.cameraId, x: item.observation.geometry.coordinates[0], y: item.observation.geometry.coordinates[1],
    }));
    let geometry;
    try {
      geometry = robustTriangulateCorrespondence(imageObservations, cameraList, {
        maxReprojectionErrorPixels: threshold, minParallaxDeg, maxPairHypotheses,
        minInlierViews: options.minInlierViews ?? 3,
      });
    } catch (error) {
      report.reason = "triangulation-failed";
      issues.push({ type: "triangulation-failed", correspondenceId: group.id, message: error.message });
      continue;
    }
    const residualByIndex = new Map(geometry.reprojectionErrors.map((residual) => [residual.index, residual]));
    const observationsWithResiduals = sourceObservations.map((source, index) => ({
      ...source,
      reprojection: residualByIndex.has(index) ? {
        projectedPixel: geometry.reprojectionErrors[residualByIndex.get(index).index]?.projected ?? null,
        residualPixels: geometry.reprojectionErrors[residualByIndex.get(index).index]?.errorPixels ?? null,
        classification: geometry.reprojectionErrors[residualByIndex.get(index).index]?.classification ?? "unknown",
      } : null,
    }));
    const confidence = confidenceReport(group.confidence, sourceObservations, geometry, threshold, calibrationReady);
    const reviewState = correspondenceAttested && resolved.every((item) => item.observation.status === "reviewed") &&
      geometry.status === "candidate" && calibrationReady ? "accepted" : "review-required";
    const vertex = {
      id: group.id,
      point: geometry.point,
      sourceObservations: observationsWithResiduals,
      confidence,
      reviewState,
      review: {
        correspondenceStatus: group.status,
        correspondenceReviewer: group.reviewedBy ?? null,
        correspondenceReviewedAt: group.reviewedAt && Number.isFinite(Date.parse(group.reviewedAt))
          ? new Date(group.reviewedAt).toISOString() : null,
        geometryStatus: geometry.status,
        geometryReason: geometry.reason,
        ...(group.notes ? { notes: String(group.notes).slice(0, 2000) } : {}),
      },
      reprojectionEvidence: {
        rmsReprojectionError: geometry.rmsReprojectionError,
        inlierRmsReprojectionError: geometry.inlierRmsReprojectionError,
        thresholdPixels: threshold,
        consensusSize: geometry.consensusSize,
        viewCount: geometry.viewCount,
        inlierCameraIds: geometry.inlierCameraIds,
        suspectedOutlierCameraIds: geometry.suspectedOutliers.map((item) => item.cameraId),
        perObservation: geometry.reprojectionErrors,
        parallax: geometry.parallax,
      },
      publicationEligible: false,
    };
    vertices.push(vertex);
    vertexById.set(vertex.id, vertex);
    report.vertexId = vertex.id;
    report.status = reviewState;
    report.reason = reviewState === "accepted" ? null
      : geometry.reason ?? (!calibrationReady ? "camera-calibration-not-verified" : "correspondence-review-attestation-missing");
    if (reviewState !== "accepted") issues.push({ type: "vertex-review-required", vertexId: vertex.id, reason: report.reason });
  }

  const edges = [];
  const edgeIds = new Set();
  for (const proposal of edgeProposals) {
    safeId(proposal?.id, "edge proposal id");
    if (edgeIds.has(proposal.id)) throw new TypeError("edge proposal IDs must be unique.");
    edgeIds.add(proposal.id);
    safeId(proposal.fromCorrespondenceId, "edge fromCorrespondenceId");
    safeId(proposal.toCorrespondenceId, "edge toCorrespondenceId");
    if (proposal.fromCorrespondenceId === proposal.toCorrespondenceId) throw new TypeError("an edge must connect two distinct correspondence IDs.");
    if (!["proposed", "reviewed", "rejected", "conflict"].includes(proposal.status)) throw new TypeError("edge proposal status is unsupported.");
    validateConfidence(proposal.confidence, "edge confidence");
    const from = vertexById.get(proposal.fromCorrespondenceId), to = vertexById.get(proposal.toCorrespondenceId);
    if (proposal.status === "rejected") {
      edges.push({ id: proposal.id, from: proposal.fromCorrespondenceId, to: proposal.toCorrespondenceId,
        reviewState: "rejected", sourceObservationRefs: [], confidence: { score: 0, semantics: "heuristic-confidence-score-not-a-calibrated-probability" },
        publicationEligible: false });
      continue;
    }
    if (!from || !to || proposal.status === "conflict") {
      issues.push({ type: "edge-endpoint-unavailable-or-conflicted", edgeId: proposal.id });
      edges.push({ id: proposal.id, from: proposal.fromCorrespondenceId, to: proposal.toCorrespondenceId,
        reviewState: "review-required", reason: "edge-endpoint-unavailable-or-conflicted", sourceObservationRefs: [],
        confidence: { score: 0, semantics: "heuristic-confidence-score-not-a-calibrated-probability" }, publicationEligible: false });
      continue;
    }
    const fromByView = new Map(from.sourceObservations.map((item) => [item.viewId, item]));
    const toByView = new Map(to.sourceObservations.map((item) => [item.viewId, item]));
    const requestedViews = Array.isArray(proposal.sourceViewIds) ? proposal.sourceViewIds : [...fromByView.keys()].filter((viewId) => toByView.has(viewId));
    const commonViews = [...new Set(requestedViews)].filter((viewId) => fromByView.has(viewId) && toByView.has(viewId));
    const sourceObservationRefs = commonViews.flatMap((viewId) => [
      { endpoint: "from", ...fromByView.get(viewId) }, { endpoint: "to", ...toByView.get(viewId) },
    ]);
    const attested = proposal.status === "reviewed" && validReview(proposal.reviewedBy, proposal.reviewedAt);
    const reviewState = attested && from.reviewState === "accepted" && to.reviewState === "accepted" && commonViews.length > 0
      ? "accepted" : "review-required";
    const score = clamp01(proposal.confidence * Math.sqrt(from.confidence.score * to.confidence.score) *
      (commonViews.length >= 2 ? 1 : 0.8));
    const edge = {
      id: proposal.id, from: from.id, to: to.id,
      sourceViewIds: commonViews,
      sourceObservationRefs,
      confidence: { score: round4(score), semantics: "heuristic-confidence-score-not-a-calibrated-probability",
        components: { reviewerConfidence: round4(proposal.confidence), fromVertex: from.confidence.score,
          toVertex: to.confidence.score, sharedSourceViewFactor: commonViews.length >= 2 ? 1 : 0.8 } },
      reviewState,
      review: { status: proposal.status, reviewer: proposal.reviewedBy ?? null,
        reviewedAt: proposal.reviewedAt && Number.isFinite(Date.parse(proposal.reviewedAt))
          ? new Date(proposal.reviewedAt).toISOString() : null },
      reprojectionEvidence: { fromVertexId: from.id, toVertexId: to.id,
        note: "Edge topology has no independent pixel residual; endpoint reprojection evidence is attached to each vertex." },
      publicationEligible: false,
    };
    edges.push(edge);
    if (reviewState !== "accepted") issues.push({ type: "edge-review-required", edgeId: edge.id,
      reason: commonViews.length ? "edge-or-endpoint-review-incomplete" : "no-shared-view-edge-evidence" });
  }

  const knownViewIds = new Set([...batches.values()].map((batch) => batch.viewId));
  const facadeIds = new Set();
  const inventory = facadeInventory.map((item) => {
    const id = safeId(typeof item === "string" ? item : item?.id, "facadeInventory.id");
    if (facadeIds.has(id)) throw new TypeError("facade IDs must be unique.");
    facadeIds.add(id);
    return { id, label: typeof item === "string" ? item : (typeof item.label === "string" ? item.label : id) };
  });
  const coverageByFacade = new Map();
  for (const item of facadeCoverage) {
    safeId(item?.facadeId, "facadeCoverage.facadeId");
    if (!facadeIds.has(item.facadeId)) throw new TypeError("facadeCoverage references an unknown facade.");
    if (coverageByFacade.has(item.facadeId)) throw new TypeError("each facade can have at most one coverage record.");
    if (!["observed", "partially-observed", "occluded", "not-visible", "not-detected", "inferred", "unknown"].includes(item.visibility)) {
      throw new TypeError("facade visibility status is unsupported.");
    }
    if (!["proposed", "reviewed", "rejected"].includes(item.status)) throw new TypeError("facade coverage status is unsupported.");
    if (!Array.isArray(item.sourceViewIds ?? [])) throw new TypeError("facade sourceViewIds must be an array.");
    const sourceViewIds = [...new Set(item.sourceViewIds ?? [])];
    if (sourceViewIds.some((viewId) => !knownViewIds.has(viewId))) throw new TypeError("facade coverage references an unknown source view.");
    coverageByFacade.set(item.facadeId, { ...item, sourceViewIds });
  }
  const facades = inventory.map(({ id, label }) => {
    const item = coverageByFacade.get(id);
    if (!item) return { id, label, status: "unknown", sourceViewIds: [], reason: "no-coverage-record" };
    const attested = item.status === "reviewed" && validReview(item.reviewedBy, item.reviewedAt);
    if (item.visibility === "inferred") return { id, label, status: "inferred", sourceViewIds: item.sourceViewIds,
      reason: item.reason ?? "explicitly-inferred-not-directly-observed",
      ...(attested ? { reviewedBy: item.reviewedBy, reviewedAt: new Date(item.reviewedAt).toISOString() } : {}) };
    if (["occluded", "not-visible", "not-detected", "unknown"].includes(item.visibility)) {
      return { id, label, status: "unknown", sourceViewIds: item.sourceViewIds,
        reason: "visibility-does-not-prove-facade-absence" };
    }
    if (!attested || item.sourceViewIds.length === 0 || item.visibility === "partially-observed") {
      return { id, label, status: "review-required", sourceViewIds: item.sourceViewIds,
        reason: item.visibility === "partially-observed" ? "partial-coverage" : "coverage-review-or-source-view-missing" };
    }
    return { id, label, status: "observed", sourceViewIds: item.sourceViewIds,
      reviewedBy: item.reviewedBy, reviewedAt: new Date(item.reviewedAt).toISOString() };
  });
  if (!inventory.length) issues.push({ type: "facade-inventory-not-supplied", reason: "unknown-facades-cannot-be-enumerated" });
  for (const facade of facades) if (facade.status !== "observed") {
    issues.push({ type: "facade-coverage-not-confirmed", facadeId: facade.id, status: facade.status, reason: facade.reason });
  }

  const acceptedVertexCount = vertices.filter((vertex) => vertex.reviewState === "accepted").length;
  const acceptedEdgeCount = edges.filter((edge) => edge.reviewState === "accepted").length;
  const graphStatus = issues.length === 0 && acceptedVertexCount === vertices.length && acceptedEdgeCount === edges.length
    ? "candidate-sparse-wireframe" : "review-required";
  return {
    schemaVersion: "1.0.0",
    engine: "confidence-aware-wireframe-fusion-v1",
    buildingId,
    status: graphStatus,
    geometryCompleteness: "sparse-wireframe-only",
    faces: [],
    vertices,
    edges,
    correspondences: correspondenceReports,
    facades,
    unknownFacadeIds: facades.filter((item) => ["unknown", "inferred", "review-required"].includes(item.status)).map((item) => item.id),
    cameraEvidence: { status: cameraEvidence.status, calibrationReady, cameraReports: cameraEvidence.cameraReports,
      limitations: cameraEvidence.limitations },
    evidenceSummary: {
      observationBatchCount: batches.size,
      sourceImageCount: new Set([...batches.values()].map((batch) => batch.source.sha256)).size,
      correspondenceCount: groups.length,
      vertexCount: vertices.length,
      acceptedVertexCount,
      edgeCount: edges.length,
      acceptedEdgeCount,
      unknownOrUnconfirmedFacadeCount: facades.filter((item) => item.status !== "observed").length,
    },
    issues,
    policy: {
      confidenceIsCalibratedProbability: false,
      incompleteFacadesAreNotAssumedAbsent: true,
      inferredFacadesAreNotDirectlyObserved: true,
      publicationEligible: false,
    },
    publicationEligible: false,
    limitations: [
      "A shared vertex exists only when source observations are explicitly grouped by a reviewed correspondence record.",
      "An accepted correspondence still depends on valid camera calibration; matrix shape and a source hash do not prove physical correctness.",
      "Confidence is a heuristic ranking signal, not a probability or survey-accuracy estimate.",
      "Only reviewed explicit edge proposals are eligible; no edge or face is automatically invented.",
      "Unseen, occluded or undetected facades remain unknown. An inferred facade is explicitly marked as inferred.",
      "The graph is sparse and may omit openings, roof surfaces, hidden sides and other geometry; publication remains disabled until independent accuracy review.",
    ],
  };
}
