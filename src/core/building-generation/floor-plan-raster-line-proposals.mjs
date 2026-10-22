import { createHash } from "node:crypto";
import sharp from "sharp";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_RUN_SEGMENTS_PER_AXIS = 50_000;
const SHA256 = /^[a-f0-9]{64}$/i;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function integerOption(value, label, fallback, minimum, maximum) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new RangeError(label + " must be an integer from " + minimum + " to " + maximum + ".");
  }
  return candidate;
}

function normalizedOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object.");
  }
  return {
    maxDimension: integerOption(options.maxDimension, "maxDimension", 4096, 256, 4096),
    minLineLengthPx: integerOption(options.minLineLengthPx, "minLineLengthPx", 48, 12, 2048),
    mergeGapPx: integerOption(options.mergeGapPx, "mergeGapPx", 2, 0, 12),
    maxCandidates: integerOption(options.maxCandidates, "maxCandidates", 300, 1, 1000),
  };
}

function otsuThreshold(pixels) {
  const histogram = new Uint32Array(256);
  for (const value of pixels) histogram[value] += 1;
  const total = pixels.length;
  let totalWeighted = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    totalWeighted += value * histogram[value];
  }
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let value = 0; value < histogram.length; value += 1) {
    backgroundWeight += histogram[value];
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += value * histogram[value];
    const meanBackground = backgroundSum / backgroundWeight;
    const meanForeground = (totalWeighted - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight *
      (meanBackground - meanForeground) * (meanBackground - meanForeground);
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
    }
  }
  // Pure black/white diagrams may yield Otsu=0; include anti-aliased dark strokes too.
  return threshold < 8 ? 128 : threshold;
}

function makeDarkMask(pixels, threshold) {
  const mask = new Uint8Array(pixels.length);
  let darkPixels = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    if (pixels[index] <= threshold) {
      mask[index] = 1;
      darkPixels += 1;
    }
  }
  return { mask, darkPixels };
}

function scanHorizontalRuns(mask, width, height, minimumLength) {
  const runs = [];
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width;
    let x = 0;
    while (x < width) {
      while (x < width && mask[rowStart + x] === 0) x += 1;
      const start = x;
      while (x < width && mask[rowStart + x] !== 0) x += 1;
      if (x - start >= minimumLength) {
        runs.push({ fixed: y, start, end: x - 1, length: x - start });
        if (runs.length > MAX_RUN_SEGMENTS_PER_AXIS) {
          throw new RangeError("Raster contains too many horizontal fragments; increase minLineLengthPx or reduce maxDimension.");
        }
      }
    }
  }
  return runs;
}

function scanVerticalRuns(mask, width, height, minimumLength) {
  const runs = [];
  for (let x = 0; x < width; x += 1) {
    let y = 0;
    while (y < height) {
      while (y < height && mask[y * width + x] === 0) y += 1;
      const start = y;
      while (y < height && mask[y * width + x] !== 0) y += 1;
      if (y - start >= minimumLength) {
        runs.push({ fixed: x, start, end: y - 1, length: y - start });
        if (runs.length > MAX_RUN_SEGMENTS_PER_AXIS) {
          throw new RangeError("Raster contains too many vertical fragments; increase minLineLengthPx or reduce maxDimension.");
        }
      }
    }
  }
  return runs;
}

function overlapRatio(aStart, aEnd, bStart, bEnd) {
  const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart) + 1);
  const shorter = Math.max(1, Math.min(aEnd - aStart + 1, bEnd - bStart + 1));
  return overlap / shorter;
}

function mergeRuns(runs, mergeGapPx) {
  const ordered = runs.slice().sort((a, b) => a.fixed - b.fixed || a.start - b.start);
  const clusters = [];
  const active = new Map();
  const bucketSize = 32;
  const bucketFor = (fixed, start) => fixed + ":" + Math.floor(start / bucketSize);
  function removeActive(cluster) {
    const key = bucketFor(cluster.lastFixed, cluster.bucketStart);
    const bucket = active.get(key);
    if (!bucket) return;
    const index = bucket.indexOf(cluster);
    if (index >= 0) bucket.splice(index, 1);
    if (bucket.length === 0) active.delete(key);
  }
  function addActive(cluster) {
    cluster.bucketStart = Math.floor(cluster.start / bucketSize) * bucketSize;
    const key = bucketFor(cluster.lastFixed, cluster.bucketStart);
    if (!active.has(key)) active.set(key, []);
    active.get(key).push(cluster);
  }

  for (const run of ordered) {
    let best = null;
    let bestScore = 0;
    const currentBucket = Math.floor(run.start / bucketSize);
    const firstFixed = Math.max(0, run.fixed - mergeGapPx - 1);
    for (let fixed = firstFixed; fixed <= run.fixed; fixed += 1) {
      for (let bin = Math.max(0, currentBucket - 1); bin <= currentBucket + 1; bin += 1) {
        const bucket = active.get(fixed + ":" + (bin * bucketSize)) ?? [];
        for (const cluster of bucket) {
          const overlap = overlapRatio(run.start, run.end, cluster.start, cluster.end);
          if (overlap < 0.55) continue;
          const score = overlap - Math.abs(
            ((run.start + run.end) / 2) - ((cluster.start + cluster.end) / 2),
          ) / 100000;
          if (score > bestScore) {
            best = cluster;
            bestScore = score;
          }
        }
      }
    }

    if (!best) {
      const cluster = {
        fixedMin: run.fixed,
        fixedMax: run.fixed,
        lastFixed: run.fixed,
        start: run.start,
        end: run.end,
        runCount: 1,
        totalLength: run.length,
      };
      clusters.push(cluster);
      addActive(cluster);
      continue;
    }

    removeActive(best);
    best.fixedMin = Math.min(best.fixedMin, run.fixed);
    best.fixedMax = Math.max(best.fixedMax, run.fixed);
    best.lastFixed = run.fixed;
    best.start = Math.min(best.start, run.start);
    best.end = Math.max(best.end, run.end);
    best.runCount += 1;
    best.totalLength += run.length;
    addActive(best);
  }
  return clusters;
}

function confidenceScore(lengthPx, imageWidth, imageHeight, supportLines, strokeWidthPx) {
  const diagonal = Math.hypot(imageWidth, imageHeight);
  const lengthScore = clamp(lengthPx / Math.max(1, diagonal * 0.7), 0, 1);
  const supportScore = clamp(supportLines / Math.max(2, strokeWidthPx + 1), 0, 1);
  // Heuristic ranking only, not a probability that a detected line is a wall.
  return Math.round(clamp(0.35 + 0.4 * lengthScore + 0.25 * supportScore, 0, 0.99) * 1000) / 1000;
}

function clusterToCandidate(cluster, orientation, width, height) {
  const fixed = (cluster.fixedMin + cluster.fixedMax) / 2;
  const start = cluster.start;
  const end = cluster.end;
  const lengthPx = end - start + 1;
  const strokeWidthPx = cluster.fixedMax - cluster.fixedMin + 1;
  const startPoint = orientation === "horizontal" ? { x: start, y: fixed } : { x: fixed, y: start };
  const endPoint = orientation === "horizontal" ? { x: end, y: fixed } : { x: fixed, y: end };
  const confidence = confidenceScore(lengthPx, width, height, cluster.runCount, strokeWidthPx);
  return {
    orientation,
    start: startPoint,
    end: endPoint,
    lengthPx: Math.round(lengthPx * 100) / 100,
    strokeWidthPx: Math.round(strokeWidthPx * 100) / 100,
    confidenceScore: confidence,
    evidence: {
      supportingScanLines: cluster.runCount,
      pixelCoverageMean: Math.round(
        (cluster.totalLength / Math.max(1, cluster.runCount * lengthPx)) * 1000,
      ) / 1000,
    },
    touchesImageBoundary: orientation === "horizontal"
      ? start === 0 || end >= width - 1 || fixed <= 0 || fixed >= height - 1
      : start === 0 || end >= height - 1 || fixed <= 0 || fixed >= width - 1,
    semanticClass: "ambiguous-line-candidate",
  };
}

/**
 * Propose long horizontal/vertical line segments from a raster drawing.
 * The result is a human-review trace aid, not a room/wall semantic classifier.
 */
export async function proposeFloorPlanRasterLines({
  imageBytes,
  sourceSha256,
  sourceMimeType,
  options = {},
} = {}) {
  if (!Buffer.isBuffer(imageBytes) || imageBytes.length === 0) {
    throw new TypeError("imageBytes must be a non-empty Buffer.");
  }
  if (imageBytes.length > MAX_SOURCE_BYTES) {
    throw new RangeError("Raster floor-plan source must be at most 20 MiB.");
  }
  if (typeof sourceSha256 !== "string" || !SHA256.test(sourceSha256)) {
    throw new TypeError("sourceSha256 must be a 64-character SHA-256 digest.");
  }
  const actualSha256 = createHash("sha256").update(imageBytes).digest("hex");
  if (actualSha256 !== sourceSha256.toLowerCase()) {
    const error = new Error("Raster bytes do not match the verified source SHA-256.");
    error.code = "SOURCE_CHECKSUM_MISMATCH";
    throw error;
  }
  if (!ALLOWED_MIME_TYPES.has(sourceMimeType)) {
    throw new TypeError("Raster proposals support JPEG, PNG and WebP sources only; PDF rasterization is a separate step.");
  }

  const config = normalizedOptions(options);
  let decoded;
  let originalWidth;
  let originalHeight;
  try {
    const image = sharp(imageBytes, {
      failOn: "error",
      limitInputPixels: MAX_SOURCE_PIXELS,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width < 1 || metadata.height < 1) {
      throw new TypeError("Source image dimensions are missing or invalid.");
    }
    originalWidth = metadata.width;
    originalHeight = metadata.height;
    if (metadata.width * metadata.height > MAX_SOURCE_PIXELS) {
      throw new RangeError("Source raster exceeds the 40 megapixel limit.");
    }
    decoded = await sharp(imageBytes, {
      failOn: "error",
      limitInputPixels: MAX_SOURCE_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: config.maxDimension,
        height: config.maxDimension,
        fit: "inside",
        withoutEnlargement: true,
        kernel: "lanczos3",
      })
      .greyscale()
      .normalise()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) throw error;
    throw new TypeError("Could not decode the uploaded raster floor-plan image.");
  }

  const { data, info } = decoded;
  const width = info.width;
  const height = info.height;
  if (width < 64 || height < 64) {
    throw new RangeError("Raster floor-plan image must be at least 64 x 64 pixels after normalization.");
  }
  const threshold = otsuThreshold(data);
  const { mask, darkPixels } = makeDarkMask(data, threshold);
  const minimumLength = Math.min(
    Math.max(12, config.minLineLengthPx),
    Math.max(12, Math.round(Math.min(width, height) * 0.8)),
  );
  const horizontal = mergeRuns(
    scanHorizontalRuns(mask, width, height, minimumLength),
    config.mergeGapPx,
  ).map((cluster) => clusterToCandidate(cluster, "horizontal", width, height));
  const vertical = mergeRuns(
    scanVerticalRuns(mask, width, height, minimumLength),
    config.mergeGapPx,
  ).map((cluster) => clusterToCandidate(cluster, "vertical", width, height));

  const allCandidates = [...horizontal, ...vertical]
    .sort((a, b) => b.confidenceScore - a.confidenceScore || b.lengthPx - a.lengthPx ||
      a.orientation.localeCompare(b.orientation) || a.start.y - b.start.y || a.start.x - b.start.x)
    .map((candidate, index) => ({
      id: "line-" + String(index + 1).padStart(4, "0"),
      ...candidate,
    }));
  const truncated = allCandidates.length > config.maxCandidates;
  const candidates = allCandidates.slice(0, config.maxCandidates);

  const lineCount = candidates.length;
  const widthMeters = null;
  const heightMeters = null;
  const warnings = [
    "Line detections are geometric image heuristics; they may include dimension lines, text strokes, furniture, hatching and page borders.",
    "Room polygons, door/window types, wall thickness in metres, and semantic wall identity are not inferred.",
    "No metric scale, north orientation, elevation datum or geospatial origin is inferred from raster pixels.",
    "Manually trace/confirm candidate lines against the source before converting any of them into FloorPlanGeometry metres.",
  ];
  if (truncated) warnings.push("Candidate output was capped by maxCandidates; not all detected lines are included.");
  if (candidates.some((candidate) => candidate.touchesImageBoundary)) {
    warnings.push("One or more candidate lines touch the image boundary; verify whether they are page borders or real wall lines.");
  }
  if (lineCount === 0) warnings.push("No long axis-aligned line segments met the configured minimum length.");

  return {
    schemaVersion: "1.0.0",
    engine: "floor-plan-raster-line-proposals-v1",
    status: "review-required-not-scaled",
    source: {
      sha256: actualSha256,
      mimeType: sourceMimeType,
      byteSize: imageBytes.length,
    },
    raster: {
      width,
      height,
      originalWidth,
      originalHeight,
      pixelUnits: "px",
      thresholdMethod: "otsu-global-grayscale",
      threshold,
      darkPixelRatio: Math.round((darkPixels / (width * height)) * 10000) / 10000,
    },
    calibration: {
      status: "not-calibrated",
      pixelsPerMetre: null,
      metresPerPixel: null,
      units: "pixel",
      widthMeters,
      heightMeters,
    },
    summary: {
      candidateCount: lineCount,
      horizontalCandidates: candidates.filter((candidate) => candidate.orientation === "horizontal").length,
      verticalCandidates: candidates.filter((candidate) => candidate.orientation === "vertical").length,
      truncated,
      minimumLineLengthPx: minimumLength,
    },
    candidates,
    warnings,
    mapReady: false,
    publicationEligible: false,
  };
}
