import { createHash } from "node:crypto";
import { normalizeArchitecturalObservationBatch } from "./architectural-observation-schema.mjs";

const HASH = /^[a-f0-9]{64}$/i;
const MAX_ANALYSIS_PIXELS = 8_000_000;
const DEFAULTS = Object.freeze({ edgeThreshold: 160, horizontalBandDensityThreshold: 0.58,
  minimumBandSeparationRatio: 0.04, maximumProposals: 200 });
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const validHash = (value) => typeof value === "string" && HASH.test(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const clamp01 = (value) => Math.max(0, Math.min(1, value));

function bytePlane(value, width, height, label, required = true) {
  if (value == null && !required) return null;
  if (!value || value.width !== width || value.height !== height ||
      !(value.pixels instanceof Uint8Array || Array.isArray(value.pixels)) ||
      value.pixels.length !== width * height) {
    throw new TypeError(label + " must have exact source dimensions and one byte per pixel.");
  }
  return value.pixels;
}
function validateParams(source, mask, edgeMap, options) {
  if (!source || typeof source !== "object" || typeof source.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(source.id) || !validHash(source.sha256) ||
      !Number.isSafeInteger(source.width) || source.width < 1 ||
      !Number.isSafeInteger(source.height) || source.height < 1) {
    throw new TypeError("source needs a safe ID, source SHA-256 and positive pixel dimensions.");
  }
  if (source.width * source.height > MAX_ANALYSIS_PIXELS) {
    throw new RangeError("Feature proposal pixel count exceeds the bounded 8,000,000-pixel analysis limit.");
  }
  if (!mask || !validHash(mask.sha256) || mask.width !== source.width || mask.height !== source.height) {
    throw new TypeError("A hash-pinned reviewed binary mask with source-matched dimensions is required.");
  }
  const maskPixels = bytePlane(mask, source.width, source.height, "mask");
  let foregroundCount = 0;
  for (let i = 0; i < maskPixels.length; i += 1) {
    if (maskPixels[i] !== 0 && maskPixels[i] !== 255) throw new TypeError("Mask is not binary at pixel " + i + ".");
    if (maskPixels[i] === 255) foregroundCount += 1;
  }
  const edgePixels = edgeMap == null ? null : bytePlane(edgeMap, source.width, source.height, "edgeMap");
  if (edgeMap != null && !validHash(edgeMap.sha256)) throw new TypeError("edgeMap SHA-256 is required when edge data is supplied.");
  const merged = { ...DEFAULTS, ...options };
  if (!Number.isSafeInteger(merged.edgeThreshold) || merged.edgeThreshold < 1 || merged.edgeThreshold > 255) {
    throw new RangeError("edgeThreshold must be an integer from 1 to 255.");
  }
  if (!finite(merged.horizontalBandDensityThreshold) || merged.horizontalBandDensityThreshold <= 0 ||
      merged.horizontalBandDensityThreshold > 1) {
    throw new RangeError("horizontalBandDensityThreshold must be greater than 0 and at most 1.");
  }
  if (!finite(merged.minimumBandSeparationRatio) || merged.minimumBandSeparationRatio <= 0 || merged.minimumBandSeparationRatio > 0.5) {
    throw new RangeError("minimumBandSeparationRatio must be greater than 0 and at most 0.5.");
  }
  if (!Number.isSafeInteger(merged.maximumProposals) || merged.maximumProposals < 8 || merged.maximumProposals > 1000) {
    throw new RangeError("maximumProposals must be an integer from 8 to 1000.");
  }
  return { maskPixels, edgePixels, foregroundCount, options: merged };
}
function foregroundBounds(maskPixels, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) if (maskPixels[row + x] === 255) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
function componentsOfMaskedEdges(maskPixels, edgePixels, width, height, bounds, threshold, limit) {
  if (!edgePixels || !bounds) return [];
  const length = width * height, visited = new Uint8Array(length), stack = new Int32Array(length);
  const components = [];
  for (let start = 0; start < length && components.length < limit; start += 1) {
    if (visited[start] || maskPixels[start] !== 255 || edgePixels[start] < threshold) continue;
    let stackSize = 0;
    stack[stackSize++] = start; visited[start] = 1;
    let minX = width, minY = height, maxX = -1, maxY = -1, pixels = 0;
    while (stackSize > 0) {
      const index = stack[--stackSize], x = index % width, y = Math.floor(index / width);
      pixels += 1; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!visited[next] && maskPixels[next] === 255 && edgePixels[next] >= threshold) {
          visited[next] = 1; stack[stackSize++] = next;
        }
      }
    }
    const boxWidth = maxX - minX + 1, boxHeight = maxY - minY + 1;
    const relativeWidth = boxWidth / bounds.width, relativeHeight = boxHeight / bounds.height;
    if (pixels < 8 || boxWidth < Math.max(3, bounds.width * 0.025) ||
        boxHeight < Math.max(3, bounds.height * 0.015) ||
        relativeWidth > 0.45 || relativeHeight > 0.35) continue;
    components.push({ minX, minY, maxX, maxY, width: boxWidth, height: boxHeight, pixels });
  }
  return components.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
}

export function proposeArchitecturalFeatures({ buildingId, viewId, source, mask, edgeMap = null, options = {} } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(buildingId ?? "") ||
      !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(viewId ?? "")) {
    throw new TypeError("buildingId and viewId must be safe identifiers.");
  }
  const { maskPixels, edgePixels, foregroundCount, options: config } = validateParams(source, mask, edgeMap, options);
  const bounds = foregroundBounds(maskPixels, source.width, source.height);
  const observations = [];
  const add = (category, geometry, confidence, method, idSuffix, visibility = "visible") => {
    if (observations.length >= config.maximumProposals) return;
    observations.push({
      id: idSuffix, category, sourceId: source.id, sourceSha256: source.sha256,
      viewId, geometry, confidence: Number(clamp01(confidence).toFixed(4)), method,
      status: "proposed", visibility,
      evidence: { maskSha256: mask.sha256, ...(edgeMap ? { edgeMapSha256: edgeMap.sha256 } : {}) },
    });
  };
  if (bounds) {
    add("silhouette-bounds", { type: "BoundingBox", coordinates: [bounds.minX, bounds.minY, bounds.width, bounds.height] },
      0.4, "mask-foreground-bounds", "silhouette-bounds-01");
    const top = [];
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) if (maskPixels[bounds.minY * source.width + x] === 255) top.push(x);
    const firstX = top.length ? Math.min(...top) : bounds.minX;
    const lastX = top.length ? Math.max(...top) : bounds.maxX;
    add("roofline-segment", { type: "LineString", coordinates: [[firstX, bounds.minY], [lastX, bounds.minY]] },
      0.35, "mask-top-envelope", "roofline-envelope-01");
    for (const [label, x, y] of [
      ["top-left", bounds.minX, bounds.minY], ["top-right", bounds.maxX, bounds.minY],
      ["bottom-left", bounds.minX, bounds.maxY], ["bottom-right", bounds.maxX, bounds.maxY],
    ]) add("outer-corner", { type: "Point", coordinates: [x, y] }, 0.25,
      "mask-extrema-candidate", "outer-corner-" + label);

    if (edgePixels) {
      const rowScores = [];
      for (let y = bounds.minY + 1; y < bounds.maxY; y += 1) {
        let foreground = 0, edges = 0, minX = source.width, maxX = -1;
        const offset = y * source.width;
        for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
          const index = offset + x;
          if (maskPixels[index] === 255) {
            foreground += 1; if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (edgePixels[index] >= config.edgeThreshold) edges += 1;
          }
        }
        rowScores.push({ y, score: foreground ? edges / foreground : 0, minX, maxX });
      }
      const minSeparation = Math.max(2, Math.round(bounds.height * config.minimumBandSeparationRatio));
      const acceptedRows = [];
      for (let i = 1; i < rowScores.length - 1; i += 1) {
        const row = rowScores[i];
        if (row.score < config.horizontalBandDensityThreshold ||
            row.score < rowScores[i - 1].score || row.score < rowScores[i + 1].score ||
            row.maxX < row.minX) continue;
        if (acceptedRows.some((y) => Math.abs(y - row.y) < minSeparation)) continue;
        acceptedRows.push(row.y);
        add("floor-band", { type: "LineString", coordinates: [[row.minX, row.y], [row.maxX, row.y]] },
          0.25 + row.score * 0.45, "masked-edge-horizontal-band-density", "floor-band-y" + row.y);
      }
      if (!acceptedRows.length) add("floor-band", null, 0, "masked-edge-horizontal-band-density",
        "floor-band-not-detected", "not-detected");

      const components = componentsOfMaskedEdges(maskPixels, edgePixels, source.width, source.height,
        bounds, config.edgeThreshold, config.maximumProposals);
      let openingIndex = 0, doorIndex = 0;
      for (const component of components) {
        if (observations.length >= config.maximumProposals) break;
        const centerY = (component.minY + component.maxY) / 2;
        const relativeY = (centerY - bounds.minY) / bounds.height;
        const isDoor = relativeY > 0.58 && component.height / component.width > 0.65;
        const category = isDoor ? "door-candidate" : "window-candidate";
        const suffix = isDoor ? "door-candidate-" + String(++doorIndex).padStart(3, "0")
          : "window-candidate-" + String(++openingIndex).padStart(3, "0");
        const density = component.pixels / (component.width * component.height);
        add(category, { type: "BoundingBox", coordinates: [component.minX, component.minY, component.width, component.height] },
          Math.min(0.55, 0.2 + density * 0.35), "masked-edge-component", suffix);
      }
      if (!openingIndex) add("window-candidate", null, 0, "masked-edge-component", "window-not-detected", "not-detected");
      if (!doorIndex) add("door-candidate", null, 0, "masked-edge-component", "door-not-detected", "not-detected");
    } else {
      for (const [category, id] of [["floor-band", "floor-band-not-detected"],
        ["window-candidate", "window-not-detected"], ["door-candidate", "door-not-detected"]]) {
        add(category, null, 0, "masked-edge-component", id, "not-detected");
      }
    }
    add("balcony-candidate", null, 0, "masked-edge-component", "balcony-not-detected", "not-detected");
  }
  const normalized = normalizeArchitecturalObservationBatch({
    schemaVersion: "1.0.0", batchId: "features-" + buildingId + "-" + viewId,
    buildingId, viewId, createdAt: new Date().toISOString(),
    source: { id: source.id, sha256: source.sha256, width: source.width, height: source.height },
    mask: { sha256: mask.sha256, width: mask.width, height: mask.height }, observations,
  });
  const coverageCategories = ["silhouette-bounds", "roofline-segment", "outer-corner", "floor-band",
    "window-candidate", "door-candidate", "balcony-candidate"];
  const coverage = coverageCategories.map((category) => {
    const matches = normalized.observations.filter((item) => item.category === category && item.visibility !== "not-detected");
    return { category, status: matches.length ? "proposed" : "not-detected", proposalCount: matches.length };
  });
  const status = foregroundCount === 0 || !edgeMap ? "incomplete" : "proposal-review-required";
  return {
    schemaVersion: "1.0.0", engine: "architectural-feature-proposals-v1", buildingId, viewId,
    generatedAt: new Date().toISOString(), status, publishable: false,
    source: { id: source.id, sha256: source.sha256.toLowerCase(), width: source.width, height: source.height },
    evidence: { maskSha256: mask.sha256.toLowerCase(), edgeMapSha256: edgeMap?.sha256?.toLowerCase() ?? null },
    method: "bounded-rule-based-proposals-over-reviewed-mask-and-edge-map",
    maskStatistics: { foregroundPixels: foregroundCount, foregroundRatio: Number((foregroundCount / (source.width * source.height)).toFixed(6)),
      boundingBox: bounds ? [bounds.minX, bounds.minY, bounds.width, bounds.height] : null },
    config: config, coverage, observations: normalized.observations,
    warnings: [
      "All generated features are proposals, not ground truth; the mask and original image must be inspected by a human.",
      "Bounding-box extrema are not proof of true architectural corners, and a top mask envelope is not a calibrated roofline.",
      "A missing feature means not detected by this bounded heuristic, not that the physical feature is absent.",
      ...(edgeMap ? [] : ["No same-resolution edge map was supplied; horizontal-band and opening proposal coverage is incomplete."]),
      ...(foregroundCount ? [] : ["The mask contains no building foreground; no geometry is inferred."]),
    ],
    limitations: ["No segmentation model is selected or trained by this module.",
      "No camera calibration, perspective rectification, metric dimension recovery, 3D fusion or hidden-facade inference is performed.",
      "Heuristic feature proposals require per-view human review; no publication or automatic correction is allowed."]
  };
}

function geometryBounds(geometry) {
  if (!geometry) return null;
  if (geometry.type === "BoundingBox") {
    const [x, y, width, height] = geometry.coordinates;
    return { x, y, width, height };
  }
  let points = [];
  if (geometry.type === "Point") points = [geometry.coordinates];
  else if (geometry.type === "LineString") points = geometry.coordinates;
  else if (geometry.type === "Polygon") points = geometry.coordinates.flat();
  if (!points.length) return null;
  const xs = points.map((item) => item[0]), ys = points.map((item) => item[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

export function buildArchitecturalFeatureOverlaySvg(report) {
  if (!report || !Number.isSafeInteger(report.source?.width) || !Number.isSafeInteger(report.source?.height) ||
      !Array.isArray(report.observations)) throw new TypeError("A feature proposal report is required.");
  const colors = { "silhouette-bounds": "#ffcc00", "roofline-segment": "#ff3b30",
    "outer-corner": "#00e5ff", "floor-band": "#a855f7", "window-candidate": "#22c55e",
    "door-candidate": "#f97316", "balcony-candidate": "#ec4899", "facade-region": "#fbbf24" };
  const shapes = report.observations.map((item) => {
    if (!item.geometry) return "";
    const color = colors[item.category] ?? "#ffffff", geometry = item.geometry, bounds = geometryBounds(geometry);
    if (geometry.type === "Point") {
      const [x, y] = geometry.coordinates;
      return '<circle cx="' + x + '" cy="' + y + '" r="5" fill="none" stroke="' + color + '" stroke-width="2"><title>' + item.id + " confidence=" + item.confidence + "</title></circle>";
    }
    if (geometry.type === "LineString") {
      const points = geometry.coordinates.map((point) => point.join(",")).join(" ");
      return '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="3"><title>' + item.id + " confidence=" + item.confidence + "</title></polyline>";
    }
    if (bounds) return '<rect x="' + bounds.x + '" y="' + bounds.y + '" width="' + bounds.width + '" height="' + bounds.height +
      '" fill="none" stroke="' + color + '" stroke-width="2"><title>' + item.id + " confidence=" + item.confidence + "</title></rect>";
    return "";
  }).join("");
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + report.source.width + '" height="' + report.source.height +
    '" viewBox="0 0 ' + report.source.width + " " + report.source.height + '">' + shapes + "</svg>";
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x, b.x), top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Compare proposals to human-reviewed per-view features using explicit pixel tolerance/IoU criteria. */
export function evaluateArchitecturalFeatureProposals({ predicted = [], reviewed = [], sourceSha256, viewId,
  centerTolerancePx = 8, minimumBoxIoU = 0.25 } = {}) {
  if (!validHash(sourceSha256) || !Array.isArray(predicted) || !Array.isArray(reviewed)) {
    throw new TypeError("sourceSha256 and predicted/reviewed observation arrays are required.");
  }
  if (!finite(centerTolerancePx) || centerTolerancePx <= 0 ||
      !finite(minimumBoxIoU) || minimumBoxIoU < 0 || minimumBoxIoU > 1) {
    throw new RangeError("Feature comparison tolerance/IoU settings are invalid.");
  }
  const categories = [...new Set([...predicted, ...reviewed].map((item) => item.category))].sort();
  const rows = [];
  for (const category of categories) {
    const p = predicted.filter((item) => item.category === category && item.visibility !== "not-detected" && item.geometry);
    const truth = reviewed.filter((item) => item.category === category && item.status === "reviewed" &&
      ["visible", "partially-occluded"].includes(item.visibility) && item.geometry);
    const used = new Set(); let tp = 0;
    for (const proposal of p) {
      if (proposal.sourceSha256?.toLowerCase() !== sourceSha256.toLowerCase() || proposal.viewId !== viewId) continue;
      const pb = geometryBounds(proposal.geometry);
      let bestIndex = -1, bestScore = -1;
      for (let i = 0; i < truth.length; i += 1) {
        if (used.has(i) || truth[i].sourceSha256?.toLowerCase() !== sourceSha256.toLowerCase() ||
            truth[i].viewId !== viewId) continue;
        const tb = geometryBounds(truth[i].geometry);
        if (!pb || !tb) continue;
        const iou = intersectionOverUnion(pb, tb);
        const distance = Math.hypot((pb.x + pb.width / 2) - (tb.x + tb.width / 2),
          (pb.y + pb.height / 2) - (tb.y + tb.height / 2));
        const matches = iou >= minimumBoxIoU || distance <= centerTolerancePx;
        const score = Math.max(iou, distance <= centerTolerancePx ? 1 - distance / centerTolerancePx : 0);
        if (matches && score > bestScore) { bestScore = score; bestIndex = i; }
      }
      if (bestIndex >= 0) { used.add(bestIndex); tp += 1; }
    }
    const fp = p.length - tp, fn = truth.length - tp;
    rows.push({ category, tp, fp, fn, precision: tp + fp ? Number((tp / (tp + fp)).toFixed(6)) : null,
      recall: tp + fn ? Number((tp / (tp + fn)).toFixed(6)) : null,
      f1: 2 * tp + fp + fn ? Number((2 * tp / (2 * tp + fp + fn)).toFixed(6)) : null,
      reviewedReferenceCount: truth.length, proposalCount: p.length });
  }
  const missingGroundTruth = rows.every((row) => row.reviewedReferenceCount === 0);
  return { status: missingGroundTruth ? "incomplete" : "review-required", metrics: rows,
    evaluatedSourceSha256: sourceSha256.toLowerCase(), viewId,
    notes: ["A missing reviewed category is not treated as an empty ground-truth class.",
      "Point/line/polygon geometries use bounding-box overlap/centre distance for this first metric; inspect overlays and calibrate thresholds before use."],
    acceptanceEligible: false };
}
