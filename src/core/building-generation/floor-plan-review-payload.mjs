const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_CANDIDATES = 5000;
const MAX_ROOMS = 500;
const MAX_WALLS = 2000;
const MAX_CORRECTION_PX = 25;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_REVIEW", label + " must be an object.");
  }
  return value;
}

function text(value, label, maximum = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    fail("INVALID_REVIEW", label + " must be non-empty text of at most " + maximum + " characters.");
  }
  return value.trim();
}

function id(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail("INVALID_REVIEW", label + " must be a safe identifier.");
  }
  return value;
}

function number(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail("INVALID_REVIEW", label + " must be a finite number between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",") + "}";
  }
  const result = JSON.stringify(value);
  if (result === undefined) fail("INVALID_REVIEW", "Input contains a value that cannot be represented as JSON.");
  return result;
}

export function canonicalFloorPlanReviewJson(value) {
  return canonicalJson(value);
}


export function validateFloorPlanReviewProposal(proposalReport) {
  record(proposalReport, "proposalReport");
  if (proposalReport.schemaVersion !== "1.0.0" ||
      proposalReport.engine !== "floor-plan-raster-line-proposals-v1" ||
      proposalReport.status !== "review-required-not-scaled") {
    fail("INVALID_PROPOSAL_REPORT", "Only a version 1.0.0 uncalibrated raster-line proposal report is supported.");
  }
  if (proposalReport.mapReady !== false || proposalReport.publicationEligible !== false) {
    fail("INVALID_PROPOSAL_REPORT", "Proposal release flags must remain explicitly false.");
  }
  const source = record(proposalReport.source, "proposalReport.source");
  const raster = record(proposalReport.raster, "proposalReport.raster");
  if (typeof source.sha256 !== "string" || !HASH.test(source.sha256) ||
      !ALLOWED_MIME.has(source.mimeType) ||
      !Number.isSafeInteger(source.byteSize) || source.byteSize < 1) {
    fail("INVALID_PROPOSAL_REPORT", "Proposal source metadata is invalid.");
  }
  if (!Number.isSafeInteger(raster.width) || raster.width < 64 || raster.width > 4096 ||
      !Number.isSafeInteger(raster.height) || raster.height < 64 || raster.height > 4096 ||
      raster.pixelUnits !== "px") {
    fail("INVALID_PROPOSAL_REPORT", "Proposal raster dimensions or pixel units are invalid.");
  }
  if (!Array.isArray(proposalReport.candidates) ||
      proposalReport.candidates.length < 1 ||
      proposalReport.candidates.length > MAX_CANDIDATES) {
    fail("INVALID_PROPOSAL_REPORT", "Proposal candidates must contain 1.." + MAX_CANDIDATES + " lines.");
  }
  const candidateIds = new Set();
  for (const candidate of proposalReport.candidates) {
    record(candidate, "proposal candidate");
    const candidateId = id(candidate.id, "candidate.id");
    if (candidateIds.has(candidateId)) fail("INVALID_PROPOSAL_REPORT", "Proposal candidate IDs must be unique.");
    candidateIds.add(candidateId);
    record(candidate.start, "candidate.start");
    record(candidate.end, "candidate.end");
    number(candidate.start.x, "candidate.start.x", 0, raster.width - 1);
    number(candidate.start.y, "candidate.start.y", 0, raster.height - 1);
    number(candidate.end.x, "candidate.end.x", 0, raster.width - 1);
    number(candidate.end.y, "candidate.end.y", 0, raster.height - 1);
  }
  return { source, raster, candidates: proposalReport.candidates, candidateIds };
}

function pointPx(value, label, raster) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail("INVALID_REVIEW", label + " must be an [x, y] pixel pair.");
  }
  return [
    number(value[0], label + "[0]", 0, raster.width - 1),
    number(value[1], label + "[1]", 0, raster.height - 1),
  ];
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function endpointDeltaPx(startPx, endPx, candidate) {
  const sourceStart = [candidate.start.x, candidate.start.y];
  const sourceEnd = [candidate.end.x, candidate.end.y];
  const direct = distance(startPx, sourceStart) + distance(endPx, sourceEnd);
  const reverse = distance(startPx, sourceEnd) + distance(endPx, sourceStart);
  return Math.min(direct, reverse) / 2;
}

function localMetric(point, origin, metresPerPixel) {
  return [(point[0] - origin[0]) * metresPerPixel, (origin[1] - point[1]) * metresPerPixel];
}

function pointLineDistance(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-8) return { distance: Infinity, t: 0 };
  return {
    distance: Math.abs(dx * (a[1] - point[1]) - (a[0] - point[0]) * dy) / length,
    t: ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (length * length),
  };
}

function assertRoomBoundariesCovered(rooms, walls, originPixel, metresPerPixel, toleranceM) {
  const metricWalls = walls.map((wall) => ({
    id: wall.id,
    start: localMetric(wall.startPx, originPixel, metresPerPixel),
    end: localMetric(wall.endPx, originPixel, metresPerPixel),
  }));
  for (const room of rooms) {
    const ring = room.polygonPx.map((point) => localMetric(point, originPixel, metresPerPixel));
    for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex += 1) {
      const a = ring[edgeIndex];
      const b = ring[(edgeIndex + 1) % ring.length];
      const edgeLength = distance(a, b);
      if (edgeLength < 0.05) fail("INVALID_REVIEW", "Room '" + room.id + "' contains an edge shorter than 0.05 m.");
      const parameterTolerance = Math.min(0.25, toleranceM / edgeLength);
      const intervals = [];
      for (const wall of metricWalls) {
        const left = pointLineDistance(wall.start, a, b);
        const right = pointLineDistance(wall.end, a, b);
        if (left.distance > toleranceM || right.distance > toleranceM) continue;
        const low = Math.max(0, Math.min(left.t, right.t));
        const high = Math.min(1, Math.max(left.t, right.t));
        if (high >= low - parameterTolerance) intervals.push([low, high]);
      }
      intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
      let coveredUntil = 0;
      for (const [start, end] of intervals) {
        if (start > coveredUntil + parameterTolerance) break;
        coveredUntil = Math.max(coveredUntil, end);
        if (coveredUntil >= 1 - parameterTolerance) break;
      }
      if (coveredUntil < 1 - parameterTolerance) {
        fail("ROOM_BOUNDARY_NOT_COVERED", "Room '" + room.id + "' edge " + edgeIndex + " is not covered by reviewed wall vectors within " + toleranceM + " m.");
      }
    }
  }
}

function normalizeOpening(opening, wallLengthPx, wallId, index, level) {
  record(opening, "wall.openings[" + index + "]");
  const openingId = id(opening.id, "opening.id");
  if (opening.type !== "door" && opening.type !== "window") {
    fail("INVALID_REVIEW", "Opening type must be door or window.");
  }
  const offsetPx = number(opening.offsetPx, "opening.offsetPx", 0, wallLengthPx);
  const widthPx = number(opening.widthPx, "opening.widthPx", 0.5, wallLengthPx);
  if (offsetPx + widthPx > wallLengthPx + 1e-8) {
    fail("INVALID_REVIEW", "Opening '" + openingId + "' extends past wall '" + wallId + "'.");
  }
  const heightM = number(opening.heightM, "opening.heightM", 0.4, level.wallHeightM);
  const sillHeightM = number(opening.sillHeightM, "opening.sillHeightM", 0, level.wallHeightM);
  if (sillHeightM + heightM > level.wallHeightM + 1e-8) {
    fail("INVALID_REVIEW", "Opening '" + openingId + "' extends above its wall level.");
  }
  if (opening.type === "door" && sillHeightM > 0.05) {
    fail("INVALID_REVIEW", "Door '" + openingId + "' must start at floor level.");
  }
  return { id: openingId, type: opening.type, offsetPx, widthPx, heightM, sillHeightM };
}

/**
 * Builds the exact review.json contract consumed by calibrateFloorPlanRasterVectors.
 * The caller must independently hash the original image bytes and present the same
 * digest here. This only builds a local review payload; it does not approve or publish.
 */
export function buildFloorPlanRasterReviewPayload({
  proposalReport,
  sourceSha256,
  proposalReportSha256,
  reviewer,
  reviewedAt,
  notes,
  sourceId,
  buildingId,
  floorPlanId,
  floorPlanName,
  confirmedAgainstSource,
  originPixel,
  calibration,
  placement,
  level,
  topologyToleranceM = 0.15,
  candidateReviews,
  rooms,
} = {}) {
  const { source, raster, candidates, candidateIds } = validateFloorPlanReviewProposal(proposalReport);
  if (typeof sourceSha256 !== "string" || !HASH.test(sourceSha256) ||
      sourceSha256.toLowerCase() !== source.sha256) {
    fail("SOURCE_CHECKSUM_MISMATCH", "Verified source file SHA-256 does not match the proposal report.");
  }
  if (confirmedAgainstSource !== true) {
    fail("SOURCE_REVIEW_REQUIRED", "Confirm that the source image and all proposals were reviewed before exporting.");
  }
  if (typeof proposalReportSha256 !== "string" || !HASH.test(proposalReportSha256)) {
    fail("INVALID_REVIEW", "proposalReportSha256 must be a canonical SHA-256 digest.");
  }
  const normalizedReviewer = text(reviewer, "reviewer", 200);
  const normalizedNotes = text(notes, "notes", 4000);
  const normalizedSourceId = id(sourceId, "sourceId");
  const normalizedBuildingId = id(buildingId, "buildingId");
  const normalizedFloorPlanId = id(floorPlanId, "floorPlanId");
  const normalizedFloorPlanName = text(floorPlanName, "floorPlanName", 160);
  if (typeof reviewedAt !== "string" || !Number.isFinite(Date.parse(reviewedAt)) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(reviewedAt)) {
    fail("INVALID_REVIEW", "reviewedAt must be an ISO 8601 timestamp with an explicit timezone.");
  }
  if (!Array.isArray(candidateReviews) || candidateReviews.length !== candidates.length) {
    fail("INCOMPLETE_CANDIDATE_REVIEW", "Every detected line candidate needs one explicit decision.");
  }
  const reviewById = new Map();
  for (const item of candidateReviews) {
    record(item, "candidate review");
    if (typeof item.proposalId !== "string" || !candidateIds.has(item.proposalId) || reviewById.has(item.proposalId)) {
      fail("INCOMPLETE_CANDIDATE_REVIEW", "Candidate reviews must uniquely match existing proposal IDs.");
    }
    if (item.decision !== "accept-wall" && item.decision !== "reject") {
      fail("INCOMPLETE_CANDIDATE_REVIEW", "Each candidate must be explicitly accepted as a wall or rejected.");
    }
    if (item.decision === "reject") text(item.reason, "rejection reason", 1000);
    reviewById.set(item.proposalId, item);
  }
  if (candidates.some((candidate) => !reviewById.has(candidate.id))) {
    fail("INCOMPLETE_CANDIDATE_REVIEW", "At least one detected candidate has no decision.");
  }

  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > MAX_ROOMS) {
    fail("INVALID_REVIEW", "At least one explicitly reviewed room polygon is required.");
  }
  const vectorIds = new Set([normalizedBuildingId, normalizedFloorPlanId]);
  if (vectorIds.size !== 2) fail("INVALID_REVIEW", "Building ID and floor-plan ID must be different.");
  const normalizedRooms = rooms.map((room, index) => {
    record(room, "rooms[" + index + "]");
    const roomId = id(room.id, "room.id");
    if (vectorIds.has(roomId)) fail("INVALID_REVIEW", "Room, wall, building and floor-plan IDs must be unique.");
    vectorIds.add(roomId);
    const name = text(room.name, "room.name", 160);
    if (room.reviewed !== true || room.decision !== "accept") {
      fail("ROOM_REVIEW_REQUIRED", "Room '" + roomId + "' must be accepted and marked reviewed.");
    }
    if (!Array.isArray(room.polygonPx) || room.polygonPx.length < 3 || room.polygonPx.length > 256) {
      fail("INVALID_REVIEW", "Room '" + roomId + "' needs 3..256 polygon points.");
    }
    const polygonPx = room.polygonPx.map((point, pointIndex) => pointPx(point, "room " + roomId + ".polygonPx[" + pointIndex + "]", raster));
    return { id: roomId, name, decision: "accept", reviewed: true, polygonPx };
  });

  const origin = pointPx(originPixel, "originPixel", raster);
  record(calibration, "calibration");
  const pointA = pointPx(calibration.pointA, "calibration.pointA", raster);
  const pointB = pointPx(calibration.pointB, "calibration.pointB", raster);
  if (distance(pointA, pointB) < 5) fail("INVALID_CALIBRATION", "Scale calibration points must be at least 5 pixels apart.");
  const distanceM = number(calibration.distanceM, "calibration.distanceM", 0.1, 10000);
  const evidenceDescription = text(calibration.evidenceDescription, "calibration.evidenceDescription", 1000);
  const metresPerPixel = distanceM / distance(pointA, pointB);
  if (metresPerPixel < 0.00001 || metresPerPixel > 10) {
    fail("IMPLAUSIBLE_SCALE", "Scale must be between 0.00001 and 10 metres per pixel.");
  }

  record(placement, "placement");
  const normalizedPlacement = {
    longitude: number(placement.longitude, "placement.longitude", -180, 180),
    latitude: number(placement.latitude, "placement.latitude", -85, 85),
    heightM: number(placement.heightM, "placement.heightM", -1000, 10000),
    headingDegrees: number(placement.headingDegrees, "placement.headingDegrees", 0, 359.999999),
  };
  record(level, "level");
  const normalizedLevel = {
    elevationM: number(level.elevationM, "level.elevationM", -1000, 10000),
    wallHeightM: number(level.wallHeightM, "level.wallHeightM", 2, 8),
    wallThicknessM: number(level.wallThicknessM, "level.wallThicknessM", 0.05, 0.75),
    floorThicknessM: number(level.floorThicknessM, "level.floorThicknessM", 0.03, 0.5),
  };
  const tolerance = number(topologyToleranceM, "topologyToleranceM", 0.05, 0.5);

  const walls = [];
  const wallIds = new Set();
  for (const candidate of candidates) {
    const item = reviewById.get(candidate.id);
    if (item.decision !== "accept-wall") continue;
    if (walls.length >= MAX_WALLS) fail("INVALID_REVIEW", "Too many accepted wall candidates.");
    const wallId = id(item.wallId, "wallId");
    if (vectorIds.has(wallId)) fail("INVALID_REVIEW", "Room, wall, building and floor-plan IDs must be unique.");
    vectorIds.add(wallId);
    wallIds.add(wallId);
    const startPx = pointPx(item.startPx, "wall " + wallId + ".startPx", raster);
    const endPx = pointPx(item.endPx, "wall " + wallId + ".endPx", raster);
    const lengthPx = distance(startPx, endPx);
    if (lengthPx < 5) fail("INVALID_REVIEW", "Wall '" + wallId + "' must be at least 5 pixels long.");
    const correctionPx = endpointDeltaPx(startPx, endPx, candidate);
    const correctionReason = item.correctionReason === undefined ? "" : String(item.correctionReason).trim();
    if (correctionPx > MAX_CORRECTION_PX && !correctionReason) {
      fail("WALL_CORRECTION_REASON_REQUIRED", "Wall '" + wallId + "' moved more than 25 px; add a correction reason.");
    }
    const openings = item.openings === undefined ? [] : item.openings;
    if (!Array.isArray(openings) || openings.length > 20) fail("INVALID_REVIEW", "A wall can have at most 20 openings.");
    const normalizedOpenings = openings.map((opening, index) => {
      const normalized = normalizeOpening(opening, lengthPx, wallId, index, normalizedLevel);
      if (vectorIds.has(normalized.id)) fail("INVALID_REVIEW", "Room, wall and opening IDs must all be unique.");
      vectorIds.add(normalized.id);
      return normalized;
    });
    const normalized = {
      proposalId: candidate.id,
      decision: "accept",
      semanticClass: "wall",
      reviewed: true,
      startPx,
      endPx,
      openings: normalizedOpenings,
    };
    if (correctionReason) normalized.correctionReason = text(correctionReason, "correctionReason", 1000);
    if (item.heightM !== undefined && item.heightM !== "") {
      normalized.heightM = number(Number(item.heightM), "wall.heightM", 2, normalizedLevel.wallHeightM);
    }
    if (item.thicknessM !== undefined && item.thicknessM !== "") {
      normalized.thicknessM = number(Number(item.thicknessM), "wall.thicknessM", 0.05, 0.75);
    }
    walls.push({ id: wallId, ...normalized });
  }
  if (walls.length < 1) fail("INVALID_REVIEW", "At least one candidate must be accepted as a wall.");
  assertRoomBoundariesCovered(normalizedRooms, walls, origin, metresPerPixel, tolerance);
  if (walls.length !== [...reviewById.values()].filter((item) => item.decision === "accept-wall").length) {
    fail("INVALID_REVIEW", "Each accepted wall decision must have exactly one wall vector.");
  }
  const candidateDecisions = candidates.map((candidate) => {
    const item = reviewById.get(candidate.id);
    return item.decision === "reject"
      ? { proposalId: candidate.id, decision: "reject", reason: text(item.reason, "rejection reason", 1000) }
      : { proposalId: candidate.id, decision: "accept-wall" };
  });

  return {
    schemaVersion: "1.0.0",
    sourceSha256: source.sha256,
    proposalReportSha256,
    confirmedAgainstSource: true,
    reviewer: normalizedReviewer,
    reviewedAt: new Date(reviewedAt).toISOString(),
    notes: normalizedNotes,
    sourceId: normalizedSourceId,
    buildingId: normalizedBuildingId,
    floorPlanId: normalizedFloorPlanId,
    floorPlanName: normalizedFloorPlanName,
    originPixel: origin,
    calibration: { pointA, pointB, distanceM, evidenceDescription },
    placement: normalizedPlacement,
    level: normalizedLevel,
    topologyToleranceM: tolerance,
    candidateDecisions,
    rooms: normalizedRooms,
    walls: walls.map(({ id: wallId, ...wall }) => ({ id: wallId, ...wall })),
  };
}
