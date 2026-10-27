const HASH = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const CATEGORIES = new Set([
  "silhouette-bounds", "roofline-segment", "outer-corner", "floor-band",
  "facade-region", "window-candidate", "door-candidate", "balcony-candidate", "visible-occluder",
  "arch-candidate", "column-candidate", "dome-candidate", "cornice-candidate",
  "pediment-candidate", "staircase-candidate", "parapet-candidate", "ornament-candidate",
]);
const STATUSES = new Set(["proposed", "reviewed", "rejected"]);
const VISIBILITY = new Set(["visible", "partially-occluded", "occluded", "not-visible", "not-detected"]);
const METHODS = new Set([
  "mask-foreground-bounds", "mask-top-envelope", "mask-extrema-candidate",
  "masked-edge-horizontal-band-density", "masked-edge-component", "human-review",
]);
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const number = (value) => typeof value === "number" && Number.isFinite(value);

function validatePoint(point, width, height, label) {
  if (!Array.isArray(point) || point.length !== 2 || !number(point[0]) || !number(point[1])) {
    throw new TypeError(label + " must be a finite [x,y] pair.");
  }
  if (point[0] < 0 || point[1] < 0 || point[0] > width - 1 || point[1] > height - 1) {
    throw new RangeError(label + " lies outside the source image pixel bounds.");
  }
}
function validateGeometry(geometry, width, height, label) {
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) {
    throw new TypeError(label + " geometry must be an object.");
  }
  if (geometry.type === "Point") {
    validatePoint(geometry.coordinates, width, height, label + ".coordinates");
  } else if (geometry.type === "LineString") {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
      throw new TypeError(label + " LineString needs at least two points.");
    }
    geometry.coordinates.forEach((point, index) => validatePoint(point, width, height, label + ".coordinates[" + index + "]"));
  } else if (geometry.type === "Polygon") {
    const rings = geometry.coordinates;
    if (!Array.isArray(rings) || !rings.length) throw new TypeError(label + " Polygon needs a linear ring.");
    for (const [ringIndex, ring] of rings.entries()) {
      if (!Array.isArray(ring) || ring.length < 4) throw new TypeError(label + " polygon rings need at least four points.");
      ring.forEach((point, index) => validatePoint(point, width, height, label + ".coordinates[" + ringIndex + "][" + index + "]"));
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) throw new TypeError(label + " polygon rings must be closed.");
    }
  } else if (geometry.type === "BoundingBox") {
    const value = geometry.coordinates;
    if (!Array.isArray(value) || value.length !== 4 || value.some((part) => !number(part))) {
      throw new TypeError(label + " BoundingBox coordinates must be [x,y,width,height].");
    }
    const [x, y, boxWidth, boxHeight] = value;
    if (x < 0 || y < 0 || boxWidth <= 0 || boxHeight <= 0 ||
        x + boxWidth > width || y + boxHeight > height) {
      throw new RangeError(label + " BoundingBox lies outside the source image pixel bounds.");
    }
  } else {
    throw new TypeError(label + " geometry type is unsupported.");
  }
  return geometry;
}

/** Normalize one per-view batch while preserving evidence links and unknown visibility. */
export function normalizeArchitecturalObservationBatch(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("observation batch must be an object.");
  if (input.schemaVersion !== "1.0.0") throw new TypeError("observation batch schemaVersion must be 1.0.0.");
  if (!ID.test(input.batchId ?? "") || !ID.test(input.buildingId ?? "") || !ID.test(input.viewId ?? "")) {
    throw new TypeError("batchId, buildingId and viewId must be safe identifiers.");
  }
  if (!nonEmpty(input.createdAt) || !Number.isFinite(Date.parse(input.createdAt))) {
    throw new TypeError("createdAt must be a valid timestamp.");
  }
  const source = input.source;
  if (!source || !ID.test(source.id ?? "") || !HASH.test(source.sha256 ?? "") ||
      !Number.isSafeInteger(source.width) || source.width < 1 ||
      !Number.isSafeInteger(source.height) || source.height < 1) {
    throw new TypeError("source must include a safe ID, SHA-256 and positive image dimensions.");
  }
  const mask = input.mask ?? null;
  if (mask !== null && (!HASH.test(mask.sha256 ?? "") || mask.width !== source.width || mask.height !== source.height)) {
    throw new TypeError("mask reference must have a SHA-256 and exact source pixel dimensions.");
  }
  if (!Array.isArray(input.observations) || input.observations.length > 2000) {
    throw new TypeError("observations must be an array of at most 2000 records.");
  }
  const ids = new Set();
  const observations = input.observations.map((raw, index) => {
    const label = "observations[" + index + "]";
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(label + " must be an object.");
    if (!ID.test(raw.id ?? "") || ids.has(raw.id)) throw new TypeError(label + ".id must be unique and safe.");
    ids.add(raw.id);
    if (!CATEGORIES.has(raw.category)) throw new TypeError(label + ".category is unsupported.");
    if (raw.sourceId !== source.id || !HASH.test(raw.sourceSha256 ?? "") ||
        raw.sourceSha256.toLowerCase() !== source.sha256.toLowerCase() || raw.viewId !== input.viewId) {
      throw new TypeError(label + " has dangling or mismatched source/view provenance.");
    }
    if (!METHODS.has(raw.method)) throw new TypeError(label + ".method is unsupported.");
    if (!STATUSES.has(raw.status)) throw new TypeError(label + ".status must be proposed, reviewed or rejected.");
    if (!VISIBILITY.has(raw.visibility)) throw new TypeError(label + ".visibility must distinguish not-visible from not-detected.");
    if (!number(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
      throw new RangeError(label + ".confidence must be between 0 and 1.");
    }
    const unknownVisibility = ["not-visible", "not-detected", "occluded"].includes(raw.visibility);
    if (raw.geometry === undefined || raw.geometry === null) {
      if (!unknownVisibility) throw new TypeError(label + " needs geometry unless visibility is not-visible, not-detected or occluded.");
    } else validateGeometry(raw.geometry, source.width, source.height, label);
    if (raw.status !== "proposed" && (!nonEmpty(raw.reviewedBy) || !nonEmpty(raw.reviewedAt) ||
        !Number.isFinite(Date.parse(raw.reviewedAt)))) {
      throw new TypeError(label + " reviewed/rejected status needs reviewer and timestamp.");
    }
    const evidence = raw.evidence ?? {};
    if (evidence.maskSha256 !== undefined && evidence.maskSha256 !== null &&
        (!mask || !HASH.test(evidence.maskSha256) || evidence.maskSha256.toLowerCase() !== mask.sha256.toLowerCase())) {
      throw new TypeError(label + " mask evidence does not match the batch mask hash.");
    }
    if (evidence.edgeMapSha256 !== undefined && evidence.edgeMapSha256 !== null && !HASH.test(evidence.edgeMapSha256)) {
      throw new TypeError(label + " edgeMapSha256 must be a SHA-256 digest.");
    }
    return {
      id: raw.id, category: raw.category, sourceId: raw.sourceId,
      sourceSha256: source.sha256.toLowerCase(), viewId: input.viewId,
      geometry: raw.geometry ?? null, confidence: raw.confidence, method: raw.method,
      status: raw.status, visibility: raw.visibility,
      evidence: { ...(evidence.maskSha256 ? { maskSha256: evidence.maskSha256.toLowerCase() } : {}),
        ...(evidence.edgeMapSha256 ? { edgeMapSha256: evidence.edgeMapSha256.toLowerCase() } : {}) },
      ...(raw.status !== "proposed" ? { reviewedBy: raw.reviewedBy, reviewedAt: new Date(raw.reviewedAt).toISOString() } : {}),
    };
  });
  return { schemaVersion: "1.0.0", batchId: input.batchId, buildingId: input.buildingId,
    viewId: input.viewId, createdAt: new Date(input.createdAt).toISOString(),
    coordinateConvention: "source-image-pixel-origin-top-left", source: { ...source, sha256: source.sha256.toLowerCase() },
    mask: mask ? { ...mask, sha256: mask.sha256.toLowerCase() } : null, observations,
    policy: { groundTruth: false, publicationEligible: false } };
}

/** Add a review event without discarding the original proposal or earlier review history. */
export function appendArchitecturalObservationReview(observation, { decision, reviewerId, reviewedAt, notes } = {}) {
  if (!observation || typeof observation !== "object" || !ID.test(observation.id ?? "")) {
    throw new TypeError("A valid observation is required.");
  }
  if (!["reviewed", "rejected"].includes(decision)) throw new TypeError("decision must be reviewed or rejected.");
  if (!nonEmpty(reviewerId) || !nonEmpty(reviewedAt) || !Number.isFinite(Date.parse(reviewedAt))) {
    throw new TypeError("reviewerId and reviewedAt are required.");
  }
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 2000)) {
    throw new TypeError("review notes must be a string of at most 2000 characters.");
  }
  const originalProposal = observation.originalProposal ?? {
    id: observation.id, category: observation.category, sourceId: observation.sourceId,
    sourceSha256: observation.sourceSha256, viewId: observation.viewId,
    geometry: observation.geometry ?? null, confidence: observation.confidence,
    method: observation.method, visibility: observation.visibility ?? "visible",
    evidence: observation.evidence ?? {}, status: "proposed",
  };
  const reviews = [...(observation.reviews ?? []), {
    decision, reviewerId, reviewedAt: new Date(reviewedAt).toISOString(), notes: notes?.trim() ?? "",
  }];
  return { ...observation, originalProposal, reviews, status: decision, reviewedBy: reviewerId,
    reviewedAt: new Date(reviewedAt).toISOString() };
}

export const ARCHITECTURAL_OBSERVATION_CATEGORIES = Object.freeze([...CATEGORIES]);
