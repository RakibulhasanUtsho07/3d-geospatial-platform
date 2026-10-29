import { createHash } from "node:crypto";

import { generateFloorPlanGlb } from "./floor-plan-model.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PROPOSAL_BYTES = 10 * 1024 * 1024;
const MAX_REVIEW_BYTES = 5 * 1024 * 1024;
const MAX_ENDPOINT_CORRECTION_PX = 25;
const EPSILON = 1e-8;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail("INVALID_INPUT", label + " must be an object.");
  return value;
}

function requireText(value, label, maximum = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    fail("INVALID_INPUT", label + " must be non-empty text of at most " + maximum + " characters.");
  }
  return value.trim();
}

function requireId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail("INVALID_INPUT", label + " must be a safe identifier.");
  }
  return value;
}

function requireNumber(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail("INVALID_INPUT", label + " must be a finite number between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (isRecord(value)) {
    return "{" + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ":" + canonicalJson(value[key])
    ).join(",") + "}";
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("INVALID_INPUT", "Input contains a value that cannot be represented as JSON.");
  return encoded;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashFloorPlanRasterProposalReport(report) {
  requireRecord(report, "proposalReport");
  return sha256(Buffer.from(canonicalJson(report), "utf8"));
}

function almostSamePoint(a, b) {
  return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

function pixelPair(value, label, raster) {
  if (!Array.isArray(value) || value.length !== 2) {
    fail("INVALID_PIXEL_COORDINATE", label + " must be [x, y] in normalized raster pixels.");
  }
  const x = requireNumber(value[0], label + "[0]", 0, raster.width - 1);
  const y = requireNumber(value[1], label + "[1]", 0, raster.height - 1);
  return [x, y];
}

function euclidean(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function roundMetric(value) {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function toLocalMetric(pointPx, originPx, metresPerPixel) {
  return [
    roundMetric((pointPx[0] - originPx[0]) * metresPerPixel),
    roundMetric((originPx[1] - pointPx[1]) * metresPerPixel),
  ];
}

function candidateEndpoints(candidate, raster) {
  if (!isRecord(candidate) || typeof candidate.id !== "string" ||
      !isRecord(candidate.start) || !isRecord(candidate.end)) {
    fail("INVALID_PROPOSAL_REPORT", "Every proposal candidate must have an id and start/end pixel points.");
  }
  return {
    start: pixelPair([candidate.start.x, candidate.start.y], "candidate " + candidate.id + ".start", raster),
    end: pixelPair([candidate.end.x, candidate.end.y], "candidate " + candidate.id + ".end", raster),
  };
}

function endpointDifferencePx(actualStart, actualEnd, candidateStart, candidateEnd) {
  const direct = euclidean(actualStart, candidateStart) + euclidean(actualEnd, candidateEnd);
  const reversed = euclidean(actualStart, candidateEnd) + euclidean(actualEnd, candidateStart);
  return Math.min(direct, reversed) / 2;
}

function pointToLine(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return { distance: Infinity, t: 0 };
  const px = point[0] - a[0];
  const py = point[1] - a[1];
  return {
    distance: Math.abs(dx * py - dy * px) / length,
    t: (px * dx + py * dy) / (length * length),
  };
}

function roomBoundaryCoverage(roomId, ring, walls, toleranceM) {
  const checks = [];
  for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex += 1) {
    const a = ring[edgeIndex];
    const b = ring[(edgeIndex + 1) % ring.length];
    const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (edgeLength < 0.05) {
      fail("INVALID_ROOM_POLYGON", "Room '" + roomId + "' contains an edge shorter than 0.05 metres.");
    }
    const parameterTolerance = Math.min(0.25, toleranceM / edgeLength);
    const intervals = [];
    for (const wall of walls) {
      const left = pointToLine(wall.start, a, b);
      const right = pointToLine(wall.end, a, b);
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
    const covered = coveredUntil >= 1 - parameterTolerance;
    checks.push({
      roomId,
      edgeIndex,
      edgeLengthM: roundMetric(edgeLength),
      covered,
      uncoveredLengthM: roundMetric(Math.max(0, 1 - coveredUntil) * edgeLength),
    });
    if (!covered) {
      fail(
        "ROOM_BOUNDARY_NOT_COVERED",
        "Room '" + roomId + "' edge " + edgeIndex + " is not covered by reviewed wall centre-lines within " +
          toleranceM + " m; trace/confirm the walls or room boundary before conversion.",
      );
    }
  }
  return checks;
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    fail("INVALID_REVIEW_TIMESTAMP", "reviewedAt must be an ISO 8601 timestamp with an explicit timezone.");
  }
  return new Date(value).toISOString();
}

export function calibrateFloorPlanRasterVectors({
  proposalReport,
  review,
  sourceBytes,
} = {}) {
  requireRecord(proposalReport, "proposalReport");
  requireRecord(review, "review");
  if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 1 || sourceBytes.length > MAX_SOURCE_BYTES) {
    fail("INVALID_SOURCE_BYTES", "sourceBytes must be a non-empty Buffer of at most 20 MiB.");
  }
  if (Buffer.byteLength(canonicalJson(proposalReport), "utf8") > MAX_PROPOSAL_BYTES) {
    fail("PROPOSAL_TOO_LARGE", "Canonical proposal report exceeds 10 MiB.");
  }
  if (Buffer.byteLength(canonicalJson(review), "utf8") > MAX_REVIEW_BYTES) {
    fail("REVIEW_TOO_LARGE", "Canonical review input exceeds 5 MiB.");
  }
  if (proposalReport.schemaVersion !== "1.0.0" ||
      proposalReport.engine !== "floor-plan-raster-line-proposals-v1" ||
      proposalReport.status !== "review-required-not-scaled") {
    fail("INVALID_PROPOSAL_REPORT", "Only a version 1.0.0, uncalibrated raster-line proposal report is accepted.");
  }
  if (proposalReport.mapReady !== false || proposalReport.publicationEligible !== false) {
    fail("INVALID_PROPOSAL_REPORT", "Proposal release flags must remain explicitly false.");
  }

  const source = requireRecord(proposalReport.source, "proposalReport.source");
  const raster = requireRecord(proposalReport.raster, "proposalReport.raster");
  if (typeof source.sha256 !== "string" || !HASH.test(source.sha256)) {
    fail("INVALID_PROPOSAL_REPORT", "Proposal source SHA-256 is invalid.");
  }
  if (!ALLOWED_MIME.has(source.mimeType)) fail("INVALID_PROPOSAL_REPORT", "Unsupported source MIME type.");
  if (!Number.isSafeInteger(source.byteSize) || source.byteSize !== sourceBytes.length) {
    fail("SOURCE_SIZE_MISMATCH", "Actual source byte length does not match the proposal report.");
  }
  const actualSourceSha256 = sha256(sourceBytes);
  if (actualSourceSha256 !== source.sha256) {
    fail("SOURCE_CHECKSUM_MISMATCH", "Actual raster source bytes do not match the proposal source SHA-256.");
  }

  if (!Number.isSafeInteger(raster.width) || raster.width < 64 || raster.width > 4096 ||
      !Number.isSafeInteger(raster.height) || raster.height < 64 || raster.height > 4096 ||
      raster.pixelUnits !== "px") {
    fail("INVALID_PROPOSAL_REPORT", "Proposal raster dimensions or normalized pixel units are invalid.");
  }
  const reportHash = hashFloorPlanRasterProposalReport(proposalReport);
  if (review.schemaVersion !== "1.0.0") fail("INVALID_REVIEW", "review.schemaVersion must be 1.0.0.");
  if (review.sourceSha256 !== actualSourceSha256) fail("REVIEW_SOURCE_MISMATCH", "Review sourceSha256 does not match the actual raster bytes.");
  if (review.proposalReportSha256 !== reportHash) {
    fail("REVIEW_PROPOSAL_MISMATCH", "Review proposalReportSha256 does not match the exact canonical proposal report.");
  }
  if (review.confirmedAgainstSource !== true) {
    fail("SOURCE_REVIEW_REQUIRED", "A reviewer must explicitly confirm the proposed vectors against the source raster.");
  }
  const reviewer = requireText(review.reviewer, "review.reviewer", 200);
  const reviewedAt = isoTimestamp(review.reviewedAt);
  const notes = requireText(review.notes, "review.notes", 4000);
  const sourceId = requireId(review.sourceId, "review.sourceId");
  const buildingId = requireId(review.buildingId, "review.buildingId");
  const floorPlanId = requireId(review.floorPlanId, "review.floorPlanId");
  const floorPlanName = requireText(review.floorPlanName, "review.floorPlanName", 160);
  const originPixel = pixelPair(review.originPixel, "review.originPixel", raster);
  const topologyToleranceM = review.topologyToleranceM === undefined
    ? 0.15
    : requireNumber(review.topologyToleranceM, "review.topologyToleranceM", 0.05, 0.5);

  const calibration = requireRecord(review.calibration, "review.calibration");
  const pointA = pixelPair(calibration.pointA, "review.calibration.pointA", raster);
  const pointB = pixelPair(calibration.pointB, "review.calibration.pointB", raster);
  const calibrationDistancePx = euclidean(pointA, pointB);
  if (calibrationDistancePx < 5) {
    fail("INVALID_CALIBRATION", "Calibration reference points must be at least 5 pixels apart.");
  }
  const distanceM = requireNumber(calibration.distanceM, "review.calibration.distanceM", 0.1, 10000);
  const evidenceDescription = requireText(calibration.evidenceDescription, "review.calibration.evidenceDescription", 1000);
  const metresPerPixel = distanceM / calibrationDistancePx;
  if (metresPerPixel < 0.00001 || metresPerPixel > 10) {
    fail("IMPLAUSIBLE_SCALE", "Calibrated metres-per-pixel is outside the allowed 0.00001..10 range.");
  }
  const pixelsPerMetre = calibrationDistancePx / distanceM;

  const placement = requireRecord(review.placement, "review.placement");
  const normalizedPlacement = {
    longitude: requireNumber(placement.longitude, "review.placement.longitude", -180, 180),
    latitude: requireNumber(placement.latitude, "review.placement.latitude", -85, 85),
    heightM: requireNumber(placement.heightM, "review.placement.heightM", -1000, 10000),
    headingDegrees: requireNumber(placement.headingDegrees, "review.placement.headingDegrees", 0, 359.999999),
  };
  const level = requireRecord(review.level, "review.level");
  const normalizedLevel = {
    elevationM: requireNumber(level.elevationM, "review.level.elevationM", -1000, 10000),
    wallHeightM: requireNumber(level.wallHeightM, "review.level.wallHeightM", 2, 8),
    wallThicknessM: requireNumber(level.wallThicknessM, "review.level.wallThicknessM", 0.05, 0.75),
    floorThicknessM: requireNumber(level.floorThicknessM, "review.level.floorThicknessM", 0.03, 0.5),
  };

  if (!Array.isArray(proposalReport.candidates) || proposalReport.candidates.length < 1 ||
      proposalReport.candidates.length > 5000) {
    fail("INVALID_PROPOSAL_REPORT", "Proposal report must contain 1..5000 candidate lines.");
  }
  const candidateMap = new Map();
  for (const candidate of proposalReport.candidates) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidateMap.has(candidate.id)) {
      fail("INVALID_PROPOSAL_REPORT", "Proposal candidate IDs must be unique strings.");
    }
    candidateEndpoints(candidate, raster);
    candidateMap.set(candidate.id, candidate);
  }

  if (!Array.isArray(review.candidateDecisions) || review.candidateDecisions.length !== candidateMap.size) {
    fail("INCOMPLETE_CANDIDATE_REVIEW", "Every detected line candidate must have one explicit accept-wall or reject decision.");
  }
  const decisions = new Map();
  for (const decision of review.candidateDecisions) {
    requireRecord(decision, "review.candidateDecisions[]");
    if (typeof decision.proposalId !== "string" || !candidateMap.has(decision.proposalId) || decisions.has(decision.proposalId)) {
      fail("INCOMPLETE_CANDIDATE_REVIEW", "Candidate decisions must uniquely refer to existing proposal IDs.");
    }
    if (decision.decision !== "accept-wall" && decision.decision !== "reject") {
      fail("INVALID_CANDIDATE_DECISION", "Each candidate decision must be accept-wall or reject.");
    }
    if (decision.decision === "reject") requireText(decision.reason, "candidate rejection reason", 1000);
    decisions.set(decision.proposalId, decision);
  }
  if ([...candidateMap.keys()].some((id) => !decisions.has(id))) {
    fail("INCOMPLETE_CANDIDATE_REVIEW", "At least one detected candidate has no explicit review decision.");
  }

  if (!Array.isArray(review.rooms) || review.rooms.length < 1 || review.rooms.length > 500) {
    fail("INVALID_REVIEW", "review.rooms must contain 1..500 explicitly reviewed room polygons.");
  }
  const rooms = review.rooms.map((room, index) => {
    requireRecord(room, "review.rooms[" + index + "]");
    const id = requireId(room.id, "review.rooms[" + index + "].id");
    const name = requireText(room.name, "review.rooms[" + index + "].name", 160);
    if (room.decision !== "accept" || room.reviewed !== true) {
      fail("ROOM_REVIEW_REQUIRED", "Room '" + id + "' must be explicitly accepted and marked reviewed.");
    }
    if (!Array.isArray(room.polygonPx) || room.polygonPx.length < 3 || room.polygonPx.length > 256) {
      fail("INVALID_ROOM_POLYGON", "Room '" + id + "' polygonPx must contain 3..256 points.");
    }
    let ring = room.polygonPx.map((p, pointIndex) =>
      pixelPair(p, "room " + id + ".polygonPx[" + pointIndex + "]", raster)
    );
    if (ring.length > 3 && almostSamePoint(ring[0], ring[ring.length - 1])) ring = ring.slice(0, -1);
    if (ring.length < 3) fail("INVALID_ROOM_POLYGON", "Room '" + id + "' polygon is degenerate.");
    return {
      id,
      name,
      polygonPx: ring,
      polygon: ring.map((pointPx) => toLocalMetric(pointPx, originPixel, metresPerPixel)),
    };
  });

  if (!Array.isArray(review.walls) || review.walls.length < 1 || review.walls.length > 2000) {
    fail("INVALID_REVIEW", "review.walls must contain 1..2000 explicitly reviewed wall vectors.");
  }
  const acceptedIds = new Set([...decisions.values()].filter((item) => item.decision === "accept-wall").map((item) => item.proposalId));
  const walls = review.walls.map((wall, index) => {
    requireRecord(wall, "review.walls[" + index + "]");
    const id = requireId(wall.id, "review.walls[" + index + "].id");
    const proposalId = requireText(wall.proposalId, "wall.proposalId", 100);
    if (!acceptedIds.has(proposalId)) {
      fail("WALL_DECISION_MISMATCH", "Wall '" + id + "' must refer to a proposal explicitly accepted as a wall.");
    }
    if (wall.decision !== "accept" || wall.semanticClass !== "wall" || wall.reviewed !== true) {
      fail("WALL_REVIEW_REQUIRED", "Wall '" + id + "' must be explicitly accepted as a reviewed wall.");
    }
    const proposal = candidateMap.get(proposalId);
    const proposalPoints = candidateEndpoints(proposal, raster);
    const startPx = pixelPair(wall.startPx, "wall " + id + ".startPx", raster);
    const endPx = pixelPair(wall.endPx, "wall " + id + ".endPx", raster);
    const segmentLengthPx = euclidean(startPx, endPx);
    if (segmentLengthPx < 5) fail("INVALID_WALL_VECTOR", "Wall '" + id + "' must be at least 5 normalized pixels long.");
    const correctionPx = endpointDifferencePx(startPx, endPx, proposalPoints.start, proposalPoints.end);
    const correctionReason = wall.correctionReason === undefined ? null : requireText(wall.correctionReason, "wall.correctionReason", 1000);
    if (correctionPx > MAX_ENDPOINT_CORRECTION_PX && !correctionReason) {
      fail("WALL_CORRECTION_REASON_REQUIRED", "Wall '" + id + "' endpoints differ from the detected line by more than 25 px; record correctionReason.");
    }
    const openingsRaw = wall.openings === undefined ? [] : wall.openings;
    if (!Array.isArray(openingsRaw) || openingsRaw.length > 20) {
      fail("INVALID_WALL_OPENINGS", "Wall '" + id + "' openings must be an array with at most 20 entries.");
    }
    const openings = openingsRaw.map((opening, openingIndex) => {
      requireRecord(opening, "wall " + id + ".openings[" + openingIndex + "]");
      const offsetPx = requireNumber(opening.offsetPx, "opening.offsetPx", 0, segmentLengthPx);
      const widthPx = requireNumber(opening.widthPx, "opening.widthPx", 0.5, segmentLengthPx);
      return {
        id: requireId(opening.id, "opening.id"),
        type: opening.type,
        offsetM: roundMetric(offsetPx * metresPerPixel),
        widthM: roundMetric(widthPx * metresPerPixel),
        heightM: requireNumber(opening.heightM, "opening.heightM", 0.4, normalizedLevel.wallHeightM),
        sillHeightM: requireNumber(opening.sillHeightM, "opening.sillHeightM", 0, normalizedLevel.wallHeightM),
      };
    }).sort((left, right) => left.offsetM - right.offsetM);
    return {
      id,
      proposalId,
      startPx,
      endPx,
      start: toLocalMetric(startPx, originPixel, metresPerPixel),
      end: toLocalMetric(endPx, originPixel, metresPerPixel),
      lengthM: roundMetric(segmentLengthPx * metresPerPixel),
      correctionPx: roundMetric(correctionPx),
      correctionReason,
      wall: (() => {
        const normalizedWall = {
          id,
          start: toLocalMetric(startPx, originPixel, metresPerPixel),
          end: toLocalMetric(endPx, originPixel, metresPerPixel),
          openings,
        };
        if (wall.heightM !== undefined) {
          normalizedWall.heightM = requireNumber(wall.heightM, "wall.heightM", 2, normalizedLevel.wallHeightM);
        }
        if (wall.thicknessM !== undefined) {
          normalizedWall.thicknessM = requireNumber(wall.thicknessM, "wall.thicknessM", 0.05, 0.75);
        }
        return normalizedWall;
      })(),
    };
  });
  if (new Set(walls.map((wall) => wall.proposalId)).size !== walls.length ||
      acceptedIds.size !== walls.length) {
    fail("WALL_DECISION_MISMATCH", "Each accept-wall decision must map to exactly one reviewed wall vector.");
  }

  const boundaryChecks = [];
  for (const room of rooms) {
    boundaryChecks.push(...roomBoundaryCoverage(room.id, room.polygon, walls, topologyToleranceM));
  }

  const floorPlan = {
    schemaVersion: "1.0.0",
    id: floorPlanId,
    buildingId,
    name: floorPlanName,
    units: "m",
    origin: normalizedPlacement,
    level: normalizedLevel,
    source: { sourceId, sha256: actualSourceSha256 },
    rooms: rooms.map(({ id, name, polygon }) => ({ id, name, polygon })),
    walls: walls.map(({ wall }) => wall),
  };

  const preview = generateFloorPlanGlb(floorPlan);
  const floorPlanSha256 = sha256(Buffer.from(canonicalJson(floorPlan), "utf8"));
  const reviewSha256 = sha256(Buffer.from(canonicalJson(review), "utf8"));
  const calibrationSummary = {
    method: "two-point-known-distance-isotropic-scale",
    status: "human-attested-scale-not-independently-survey-verified",
    pointA,
    pointB,
    distancePx: roundMetric(calibrationDistancePx),
    distanceM,
    metresPerPixel: roundMetric(metresPerPixel),
    pixelsPerMetre: roundMetric(pixelsPerMetre),
    evidenceDescription,
    pixelOrigin: originPixel,
    coordinateMapping: "localX=(pixelX-originPixelX)*metresPerPixel; localZ=(originPixelY-pixelY)*metresPerPixel",
    assumesUniformScale: true,
    doesNotInferNorthOrSurveyedPlacement: true,
  };
  const audit = {
    schemaVersion: "1.0.0",
    engine: "floor-plan-raster-vector-calibration-v1",
    status: "review-required-calibrated-vector-draft",
    createdAt: reviewedAt,
    reviewer,
    notes,
    source: {
      sha256: actualSourceSha256,
      byteSize: sourceBytes.length,
      mimeType: source.mimeType,
      bytesVerified: true,
    },
    proposal: {
      engine: proposalReport.engine,
      canonicalSha256: reportHash,
      candidateCount: candidateMap.size,
      acceptedWallCandidateIds: walls.map((wall) => wall.proposalId),
      rejectedCandidateIds: [...decisions.values()].filter((item) => item.decision === "reject").map((item) => item.proposalId),
    },
    review: {
      canonicalSha256: reviewSha256,
      confirmedAgainstSource: true,
      reviewer,
      reviewedAt,
      notes,
    },
    calibration: calibrationSummary,
    vector: {
      floorPlanSha256,
      roomCount: rooms.length,
      wallCount: walls.length,
      openingCount: walls.reduce((sum, wall) => sum + wall.wall.openings.length, 0),
      topologyToleranceM,
      roomBoundaryEdgeCount: boundaryChecks.length,
      roomBoundaryChecks: boundaryChecks,
      allRoomBoundariesCovered: boundaryChecks.every((check) => check.covered),
      generatedPreviewGlbSha256: preview.report.output.sha256,
      generatedPreviewGlbByteSize: preview.report.output.byteSize,
      geometrySummary: preview.report.geometry,
      previewWrittenToDisk: false,
    },
    limitations: [
      "The scale is only as reliable as the reviewer's cited dimension and selected pixel points; it has not been independently surveyed.",
      "Every room, wall semantic, opening, image-space correction and placement value is reviewer-supplied. Detection scores are not semantic truth.",
      "The origin, heading, height/elevation datum and coordinate reference have not been independently surveyed or transformed by this tool.",
      "The generated GLB hash is an in-memory geometry preflight; this tool writes vector JSON and an audit only, never a map asset.",
    ],
    releaseFlags: {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
  };
  return {
    schemaVersion: "1.0.0",
    status: audit.status,
    floorPlan,
    audit,
    mapReady: false,
    publicationEligible: false,
  };
}
