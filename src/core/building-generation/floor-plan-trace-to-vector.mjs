const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const HASH = /^[a-f0-9]{64}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be a finite number between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function positiveInteger(value, label, maximum = 10000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(label + " must be an integer between 1 and " + maximum + ".");
  }
  return value;
}

function id(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw new TypeError(label + " must be a safe identifier.");
  return value;
}

function point2(value, label, width, height) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(label + " must be a two-element pixel coordinate.");
  return {
    x: number(value[0], label + "[0]", 0, width),
    y: number(value[1], label + "[1]", 0, height),
  };
}

function localPoint(analysisX, analysisY, trace, originPixel, metresPerSourcePixel) {
  const sourceX = analysisX * trace.raster.sourcePixelsPerAnalysisPixelX;
  const sourceY = analysisY * trace.raster.sourcePixelsPerAnalysisPixelY;
  const x = (sourceX - originPixel.x) * metresPerSourcePixel;
  const z = (sourceY - originPixel.y) * metresPerSourcePixel;
  if (Math.abs(x) > 1000 || Math.abs(z) > 1000) {
    throw new RangeError("Transformed local floor-plan coordinates exceed the 1000 metre safety bound.");
  }
  return [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000];
}

function validateTrace(trace) {
  if (!isRecord(trace) || trace.schemaVersion !== "1.0.0" ||
      trace.engine !== "orthogonal-floor-plan-raster-trace-v1" ||
      trace.status !== "needs-human-trace-review" ||
      trace.coordinateSystem !== "oriented-raster-pixels" ||
      trace.mapReady !== false || trace.publicationEligible !== false) {
    throw new TypeError("trace must be a valid unreviewed orthogonal floor-plan raster trace.");
  }
  if (!HASH.test(trace.source?.sha256 ?? "") ||
      !HASH.test(trace.sourceEvidence?.sha256 ?? "") ||
      trace.source.sha256 !== trace.sourceEvidence.sha256) {
    throw new TypeError("trace must contain matching verified original-source SHA-256 hashes.");
  }
  if (!isRecord(trace.raster) ||
      !Number.isSafeInteger(trace.raster.orientedSourceWidth) ||
      !Number.isSafeInteger(trace.raster.orientedSourceHeight) ||
      !Number.isSafeInteger(trace.raster.analysisWidth) ||
      !Number.isSafeInteger(trace.raster.analysisHeight) ||
      !Number.isFinite(trace.raster.sourcePixelsPerAnalysisPixelX) ||
      trace.raster.sourcePixelsPerAnalysisPixelX <= 0 ||
      !Number.isFinite(trace.raster.sourcePixelsPerAnalysisPixelY) ||
      trace.raster.sourcePixelsPerAnalysisPixelY <= 0) {
    throw new TypeError("trace raster scale metadata is invalid.");
  }
  if (!isRecord(trace.candidates) ||
      !Array.isArray(trace.candidates.horizontalWalls) ||
      !Array.isArray(trace.candidates.verticalWalls) ||
      !Array.isArray(trace.candidates.rooms)) {
    throw new TypeError("trace line and room candidates are required.");
  }
}

function validateLevel(level) {
  if (!isRecord(level)) throw new TypeError("level is required.");
  return {
    elevationM: number(level.elevationM, "level.elevationM", -1000, 10000),
    wallHeightM: number(level.wallHeightM, "level.wallHeightM", 2, 8),
    wallThicknessM: number(level.wallThicknessM, "level.wallThicknessM", 0.05, 0.75),
    floorThicknessM: number(level.floorThicknessM, "level.floorThicknessM", 0.03, 0.5),
  };
}

/**
 * Convert only explicitly confirmed raster hypotheses into a measured plan draft.
 * The distance calibration and WGS84 placement are operator supplied, not inferred.
 */
export function convertFloorPlanTraceToVectorPlan(input) {
  if (!isRecord(input)) throw new TypeError("vector-plan conversion input is required.");
  const trace = input.trace;
  validateTrace(trace);
  if (input.confirmTraceReview !== true) {
    throw new TypeError("confirmTraceReview must be true after checking each selected line and room against the source image.");
  }
  const buildingId = id(trace.buildingId, "trace.buildingId");
  const planId = id(input.planId, "planId");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 160) {
    throw new TypeError("name must be non-empty and at most 160 characters.");
  }
  if (typeof input.reviewNotes !== "string" || input.reviewNotes.trim().length < 12 || input.reviewNotes.trim().length > 2000) {
    throw new TypeError("reviewNotes must explain the trace check in 12 to 2000 characters.");
  }
  const width = trace.raster.orientedSourceWidth;
  const height = trace.raster.orientedSourceHeight;
  positiveInteger(width, "trace raster width", 100000);
  positiveInteger(height, "trace raster height", 100000);

  if (!isRecord(input.origin)) throw new TypeError("surveyed origin is required.");
  const origin = {
    longitude: number(input.origin.longitude, "origin.longitude", -180, 180),
    latitude: number(input.origin.latitude, "origin.latitude", -85, 85),
    heightM: number(input.origin.heightM, "origin.heightM", -1000, 10000),
    headingDegrees: number(input.origin.headingDegrees, "origin.headingDegrees", 0, 359.999999),
  };
  const originPixel = point2(input.originPixel, "originPixel", width, height);

  if (!isRecord(input.calibration)) throw new TypeError("a known-distance calibration segment is required.");
  const calibrationStart = point2(input.calibration.startPx, "calibration.startPx", width, height);
  const calibrationEnd = point2(input.calibration.endPx, "calibration.endPx", width, height);
  const knownDistanceM = number(input.calibration.distanceM, "calibration.distanceM", 0.1, 1000);
  const calibrationPixels = Math.hypot(
    calibrationEnd.x - calibrationStart.x,
    calibrationEnd.y - calibrationStart.y,
  );
  if (calibrationPixels < 5) {
    throw new RangeError("calibration endpoints must be at least 5 source pixels apart.");
  }
  const metresPerSourcePixel = knownDistanceM / calibrationPixels;
  if (metresPerSourcePixel < 0.00001 || metresPerSourcePixel > 5) {
    throw new RangeError("calculated metres-per-source-pixel falls outside the supported 0.00001–5 range.");
  }

  const level = validateLevel(input.level);
  if (!Array.isArray(input.confirmedLineIds) || input.confirmedLineIds.length < 4 || input.confirmedLineIds.length > 2000) {
    throw new RangeError("confirmedLineIds must select between 4 and 2000 reviewed wall candidates.");
  }
  if (!Array.isArray(input.confirmedRoomIds) || input.confirmedRoomIds.length < 1 || input.confirmedRoomIds.length > 500) {
    throw new RangeError("confirmedRoomIds must select between 1 and 500 reviewed room candidates.");
  }
  const allLines = [...trace.candidates.horizontalWalls, ...trace.candidates.verticalWalls];
  const lineMap = new Map(allLines.map((line) => [line.id, line]));
  const roomMap = new Map(trace.candidates.rooms.map((room) => [room.id, room]));
  const confirmedLineIds = input.confirmedLineIds.map((value) => id(value, "confirmedLineId"));
  const confirmedRoomIds = input.confirmedRoomIds.map((value) => id(value, "confirmedRoomId"));
  if (new Set(confirmedLineIds).size !== confirmedLineIds.length) throw new TypeError("confirmedLineIds contains duplicate IDs.");
  if (new Set(confirmedRoomIds).size !== confirmedRoomIds.length) throw new TypeError("confirmedRoomIds contains duplicate IDs.");
  if (confirmedLineIds.some((value) => !lineMap.has(value))) throw new TypeError("confirmedLineIds includes a line not present in this trace.");
  if (confirmedRoomIds.some((value) => !roomMap.has(value))) throw new TypeError("confirmedRoomIds includes a room not present in this trace.");
  const confirmedSet = new Set(confirmedLineIds);
  const confirmedRooms = confirmedRoomIds.map((roomId) => roomMap.get(roomId));
  for (const room of confirmedRooms) {
    if (!Array.isArray(room.boundaryLineIds) || room.boundaryLineIds.some((lineId) => !confirmedSet.has(lineId))) {
      throw new TypeError("Each selected room must have all four of its boundary wall candidates selected and reviewed.");
    }
  }

  const walls = confirmedLineIds.map((lineId) => {
    const line = lineMap.get(lineId);
    if (line.reviewStatus !== "unreviewed" || !Number.isFinite(line.positionPx) ||
        !Number.isFinite(line.startPx) || !Number.isFinite(line.endPx) ||
        line.endPx <= line.startPx) {
      throw new TypeError("Trace wall line " + lineId + " is malformed.");
    }
    const start = line.orientation === "horizontal"
      ? localPoint(line.startPx, line.positionPx, trace, originPixel, metresPerSourcePixel)
      : localPoint(line.positionPx, line.startPx, trace, originPixel, metresPerSourcePixel);
    const end = line.orientation === "horizontal"
      ? localPoint(line.endPx, line.positionPx, trace, originPixel, metresPerSourcePixel)
      : localPoint(line.positionPx, line.endPx, trace, originPixel, metresPerSourcePixel);
    if (!["horizontal", "vertical"].includes(line.orientation)) {
      throw new TypeError("Trace line " + lineId + " has unsupported orientation.");
    }
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 0.1) {
      throw new RangeError("Confirmed wall " + lineId + " is shorter than 0.1 metres after calibration.");
    }
    return {
      id: "trace-" + lineId,
      start,
      end,
      openings: [],
    };
  });

  const rooms = confirmedRooms.map((room) => {
    if (!Array.isArray(room.polygonPx) || room.polygonPx.length !== 4) {
      throw new TypeError("Selected room candidate " + room.id + " is not a four-corner orthogonal cell.");
    }
    const polygon = room.polygonPx.map((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError("Room polygon coordinate is malformed.");
      return localPoint(
        number(pair[0], "room pixel x", 0, trace.raster.analysisWidth),
        number(pair[1], "room pixel y", 0, trace.raster.analysisHeight),
        trace,
        originPixel,
        metresPerSourcePixel,
      );
    });
    const area = Math.abs(polygon.reduce((sum, p, i) => {
      const next = polygon[(i + 1) % polygon.length];
      return sum + p[0] * next[1] - next[0] * p[1];
    }, 0) / 2);
    if (area < 0.25) throw new RangeError("Confirmed room " + room.id + " is smaller than 0.25 square metres after calibration.");
    return {
      id: "trace-" + room.id,
      name: room.id.replace(/-/g, " ").replace(/^room /, "Room "),
      polygon,
    };
  });

  const transformation = {
    schemaVersion: "1.0.0",
    method: "operator-confirmed-orthogonal-raster-trace-to-metric-vectors-v1",
    status: "measured-draft-needs-independent-QA",
    traceId: trace.traceId,
    sourceSha256: trace.sourceEvidence.sha256,
    traceSha256: trace.artifactSha256 ?? null,
    confirmedLineIds,
    confirmedRoomIds,
    calibration: {
      startPx: [calibrationStart.x, calibrationStart.y],
      endPx: [calibrationEnd.x, calibrationEnd.y],
      distanceM: knownDistanceM,
      sourcePixelDistance: calibrationPixels,
      metresPerSourcePixel,
    },
    origin,
    originPixel: [originPixel.x, originPixel.y],
    reviewNotes: input.reviewNotes.trim(),
    warnings: [
      "Line and room selection was explicitly confirmed by an operator, but the reviewer identity and measurement claims are not independently verified.",
      "Known distance, WGS84 origin, heading and height must be checked against reliable survey/dimension evidence.",
      "Detected wall thickness, wall openings, furniture, stairs, roof, ceiling and non-orthogonal architecture are not inferred by this converter.",
    ],
    mapReady: false,
    publicationEligible: false,
  };
  const floorPlan = {
    schemaVersion: "1.0.0",
    id: planId,
    buildingId,
    name: input.name.trim(),
    units: "m",
    origin,
    level,
    source: {
      sourceId: trace.sourceId,
      sha256: trace.sourceEvidence.sha256,
    },
    rooms,
    walls,
  };
  return { floorPlan, transformation };
}
