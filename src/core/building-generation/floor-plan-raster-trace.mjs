const DEFAULT_THRESHOLD = 180;
const DEFAULT_GAP = 2;
const DEFAULT_LINE_MERGE = 4;
const DEFAULT_MIN_LINE_LENGTH = 20;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 40_000_000;
const MAX_LINES_PER_ORIENTATION = 1200;
const MAX_ROOM_CANDIDATES = 2500;

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be an integer between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function normalizeOptions(options = {}, width, height) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isSafeInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new RangeError("threshold must be an integer between 0 and 255.");
  }
  const maxGapPx = integer(options.maxGapPx ?? DEFAULT_GAP, "maxGapPx", 0, 12);
  const lineMergeTolerancePx = integer(options.lineMergeTolerancePx ?? DEFAULT_LINE_MERGE, "lineMergeTolerancePx", 1, 20);
  const minLineLengthPx = integer(
    options.minLineLengthPx ?? Math.max(DEFAULT_MIN_LINE_LENGTH, Math.round(Math.min(width, height) * 0.04)),
    "minLineLengthPx", 8, Math.max(width, height),
  );
  const minRoomSidePx = integer(options.minRoomSidePx ?? 24, "minRoomSidePx", 8, Math.max(width, height));
  const maxLinesPerOrientation = integer(options.maxLinesPerOrientation ?? MAX_LINES_PER_ORIENTATION, "maxLinesPerOrientation", 4, MAX_LINES_PER_ORIENTATION);
  const maxRoomCandidates = integer(options.maxRoomCandidates ?? MAX_ROOM_CANDIDATES, "maxRoomCandidates", 1, MAX_ROOM_CANDIDATES);
  return { threshold, maxGapPx, lineMergeTolerancePx, minLineLengthPx, minRoomSidePx, maxLinesPerOrientation, maxRoomCandidates };
}

function scanLine(data, width, height, horizontal, coordinate, threshold, maxGapPx) {
  const limit = horizontal ? width : height;
  const runList = [];
  let start = -1;
  let lastDark = -1;
  let gap = 0;

  function closeRun() {
    if (start >= 0 && lastDark >= start) runList.push({ coordinate, start, end: lastDark });
    start = -1;
    lastDark = -1;
    gap = 0;
  }

  for (let step = 0; step < limit; step += 1) {
    const x = horizontal ? step : coordinate;
    const y = horizontal ? coordinate : step;
    const dark = data[y * width + x] <= threshold;
    if (dark) {
      if (start < 0) start = step;
      lastDark = step;
      gap = 0;
    } else if (start >= 0) {
      gap += 1;
      if (gap > maxGapPx) closeRun();
    }
  }
  closeRun();
  return runList;
}

function overlapLength(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start) + 1);
}

function mergeParallelRuns(rawRuns, tolerance, minimumLength) {
  const sorted = rawRuns
    .filter((run) => run.end - run.start + 1 >= minimumLength)
    .sort((a, b) => a.coordinate - b.coordinate || a.start - b.start || a.end - b.end);
  const groups = [];

  for (const run of sorted) {
    let best = null;
    let bestScore = -1;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      if (run.coordinate - group.maxCoordinate > tolerance) break;
      const minimumSpan = Math.min(group.maxEnd - group.minStart + 1, run.end - run.start + 1);
      const overlap = overlapLength({ start: group.minStart, end: group.maxEnd }, run);
      const score = minimumSpan > 0 ? overlap / minimumSpan : 0;
      if (overlap > 0 && score > bestScore) {
        best = group;
        bestScore = score;
      }
    }
    if (best) {
      best.coordinates.push(run.coordinate);
      best.minStart = Math.min(best.minStart, run.start);
      best.maxEnd = Math.max(best.maxEnd, run.end);
      best.maxCoordinate = run.coordinate;
    } else {
      groups.push({
        coordinates: [run.coordinate],
        minStart: run.start,
        maxEnd: run.end,
        maxCoordinate: run.coordinate,
      });
    }
  }

  return groups
    .map((group) => {
      const coords = [...group.coordinates].sort((a, b) => a - b);
      const middle = Math.floor(coords.length / 2);
      const positionPx = coords.length % 2
        ? coords[middle]
        : (coords[middle - 1] + coords[middle]) / 2;
      const lengthPx = group.maxEnd - group.minStart + 1;
      return {
        positionPx,
        startPx: group.minStart,
        endPx: group.maxEnd,
        lengthPx,
        estimatedThicknessPx: Math.max(1, coords.at(-1) - coords[0] + 1),
        scanlineCount: coords.length,
        detectorScore: Math.round(Math.min(0.99, 0.55 + 0.4 * Math.min(1, lengthPx / Math.max(1, lengthPx + positionPx * 0.01))) * 1000) / 1000,
      };
    })
    .sort((a, b) => a.positionPx - b.positionPx || a.startPx - b.startPx);
}

function detectLines(data, width, height, options, horizontal) {
  const count = horizontal ? height : width;
  const rawRuns = [];
  for (let coordinate = 0; coordinate < count; coordinate += 1) {
    rawRuns.push(...scanLine(
      data, width, height, horizontal, coordinate, options.threshold, options.maxGapPx,
    ));
  }
  return mergeParallelRuns(rawRuns, options.lineMergeTolerancePx, options.minLineLengthPx)
    .filter((line) => line.lengthPx >= options.minLineLengthPx)
    .slice(0, options.maxLinesPerOrientation);
}

function lineCoversInterval(line, start, end, tolerance) {
  return line.startPx <= start + tolerance && line.endPx >= end - tolerance;
}

function nearPosition(line, position, tolerance) {
  return Math.abs(line.positionPx - position) <= tolerance;
}

function detectRectangularRooms(horizontalLines, verticalLines, options) {
  const tolerance = Math.max(3, options.lineMergeTolerancePx + 1);
  const rooms = [];
  const ys = horizontalLines.map((line) => line.positionPx);
  const xs = verticalLines.map((line) => line.positionPx);

  for (let row = 0; row < ys.length - 1; row += 1) {
    const top = ys[row];
    const bottom = ys[row + 1];
    if (bottom - top < options.minRoomSidePx) continue;
    const topLine = horizontalLines[row];
    const bottomLine = horizontalLines[row + 1];
    for (let column = 0; column < xs.length - 1; column += 1) {
      const left = xs[column];
      const right = xs[column + 1];
      if (right - left < options.minRoomSidePx) continue;
      const leftLine = verticalLines[column];
      const rightLine = verticalLines[column + 1];
      if (!lineCoversInterval(topLine, left, right, tolerance) ||
          !lineCoversInterval(bottomLine, left, right, tolerance) ||
          !lineCoversInterval(leftLine, top, bottom, tolerance) ||
          !lineCoversInterval(rightLine, top, bottom, tolerance)) continue;
      const areaPx2 = (right - left) * (bottom - top);
      rooms.push({
        id: "room-" + String(rooms.length + 1).padStart(3, "0"),
        polygonPx: [[left, top], [right, top], [right, bottom], [left, bottom]],
        widthPx: right - left,
        heightPx: bottom - top,
        areaPx2,
        boundaryLineIds: [
          topLine.id, rightLine.id, bottomLine.id, leftLine.id,
        ],
        detectorScore: Math.round([
          topLine.detectorScore, rightLine.detectorScore,
          bottomLine.detectorScore, leftLine.detectorScore,
        ].reduce((sum, value) => sum + value, 0) / 4 * 1000) / 1000,
        reviewStatus: "unreviewed",
      });
      if (rooms.length >= options.maxRoomCandidates) return rooms;
    }
  }
  return rooms;
}

/**
 * Detect long dark horizontal/vertical strokes from a grayscale raster.
 * This intentionally produces pixel-space hypotheses, not verified room
 * geometry. Scale, orientation, semantics, wall identity and drawing accuracy
 * must be reviewed before conversion into a measured floor plan.
 */
export function traceFloorPlanRaster({ width, height, grayscale, sourceSha256, options: rawOptions = {} }) {
  integer(width, "width", 32, MAX_DIMENSION);
  integer(height, "height", 32, MAX_DIMENSION);
  if (width * height > MAX_PIXELS) throw new RangeError("raster exceeds the 40-million-pixel analysis limit.");
  if (!(Buffer.isBuffer(grayscale) || grayscale instanceof Uint8Array) || grayscale.byteLength !== width * height) {
    throw new TypeError("grayscale must contain exactly width * height 8-bit grayscale pixels.");
  }
  if (typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sourceSha256)) {
    throw new TypeError("sourceSha256 must be a 64-character SHA-256 hash.");
  }
  const options = normalizeOptions(rawOptions, width, height);
  const horizontal = detectLines(grayscale, width, height, options, true)
    .map((line, index) => ({
      id: "h-" + String(index + 1).padStart(3, "0"),
      orientation: "horizontal",
      ...line,
      reviewStatus: "unreviewed",
    }));
  const vertical = detectLines(grayscale, width, height, options, false)
    .map((line, index) => ({
      id: "v-" + String(index + 1).padStart(3, "0"),
      orientation: "vertical",
      ...line,
      reviewStatus: "unreviewed",
    }));
  const rooms = detectRectangularRooms(horizontal, vertical, options);
  return {
    schemaVersion: "1.0.0",
    engine: "orthogonal-floor-plan-raster-trace-v1",
    status: "needs-human-trace-review",
    source: { sha256: sourceSha256.toLowerCase(), width, height, pixelFormat: "8-bit-grayscale" },
    coordinateSystem: "oriented-raster-pixels",
    scale: { metresPerPixel: null, status: "unknown-until-calibrated" },
    options,
    candidates: {
      horizontalWalls: horizontal,
      verticalWalls: vertical,
      rooms,
    },
    summary: {
      horizontalWallCandidates: horizontal.length,
      verticalWallCandidates: vertical.length,
      roomCandidates: rooms.length,
      totalWallCandidates: horizontal.length + vertical.length,
    },
    limitations: [
      "Only long dark horizontal/vertical strokes are detected; angled walls, curves, symbols and text can be missed or misclassified.",
      "Closed rectangular room candidates are heuristic grid cells, not confirmed rooms. Non-rectangular and open-plan rooms are not inferred.",
      "Coordinates are pixels, not metres. No scale, north, heading, WGS84 origin or elevation is inferred.",
      "The original raster is not changed; no AI semantics, OCR dimension reading, permission check or automatic publication is performed.",
      "Inspect and correct all candidates against the original plan, then enter measured metric coordinates in the floor-plan vector schema.",
    ],
    mapReady: false,
    publicationEligible: false,
  };
}
