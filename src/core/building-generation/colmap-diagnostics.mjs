const DEFAULT_THRESHOLDS = Object.freeze({
  minimumRegisteredImageRatio: 0.75,
  minimumSparsePointsPerRegisteredImage: 50,
  maximumMeanReprojectionErrorPx: 2,
  minimumMeanTrackLength: 2,
});

const NUMBER_PATTERN = "([0-9][0-9,]*(?:\\.[0-9]+)?)";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readMetric(lines, label) {
  const pattern = new RegExp("(?:^|\\]\\s*)" + escapeRegExp(label) + ":\\s*" + NUMBER_PATTERN);
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      const value = Number(match[1].replaceAll(",", ""));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/**
 * Parse the human-readable output from `colmap model_analyzer`.
 * COLMAP prefixes metric lines with timestamp/logger metadata, so parsing
 * allows the standard logger prefix before the exact metric label.
 */
export function parseColmapModelAnalysis(output) {
  if (typeof output !== "string") throw new TypeError("COLMAP model analysis output must be a string");
  const lines = output.split(/\r?\n/);
  return {
    totalImages: readMetric(lines, "Images"),
    registeredImages: readMetric(lines, "Registered images"),
    sparsePointCount: readMetric(lines, "Points"),
    observationCount: readMetric(lines, "Observations"),
    meanTrackLength: readMetric(lines, "Mean track length"),
    meanReprojectionErrorPx: readMetric(lines, "Mean reprojection error"),
  };
}

/**
 * Turn COLMAP metrics into review warnings instead of silently treating every
 * successful process exit as a high-quality reconstruction. These are
 * heuristics only: they must never certify architectural accuracy or publish a model.
 */
export function assessColmapReconstruction({ analysisText, sourceCount, thresholds = {} }) {
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 3 || sourceCount > 120) {
    throw new RangeError("sourceCount must be an integer between 3 and 120");
  }
  const effectiveThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  for (const [name, value] of Object.entries(effectiveThresholds)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new RangeError("diagnostic threshold " + name + " must be a non-negative finite number");
    }
  }

  const metrics = parseColmapModelAnalysis(analysisText);
  const warnings = [];
  if (metrics.registeredImages === null || metrics.sparsePointCount === null) {
    return {
      schemaVersion: "1.0.0",
      status: "unavailable",
      sourceImageCount: sourceCount,
      metrics,
      thresholds: effectiveThresholds,
      warnings: ["COLMAP model_analyzer output could not be parsed; registered-image and sparse-point diagnostics are unavailable."],
      caveat: "Diagnostics are heuristic review hints, not proof of overlap, scale, completeness, or architectural accuracy.",
    };
  }

  if (metrics.registeredImages > sourceCount || (metrics.totalImages !== null && metrics.totalImages > sourceCount)) {
    warnings.push("COLMAP model image counts exceed the selected input count; inspect the workspace/model identity before trusting this result.");
  }
  if (metrics.registeredImages < sourceCount) {
    warnings.push("Only " + metrics.registeredImages + " of " + sourceCount + " selected images registered; missing views can cause incomplete or stretched geometry.");
  }
  const registeredImageRatio = metrics.registeredImages / sourceCount;
  if (registeredImageRatio < effectiveThresholds.minimumRegisteredImageRatio) {
    warnings.push("Registered-image ratio " + registeredImageRatio.toFixed(3) + " is below the review threshold " + effectiveThresholds.minimumRegisteredImageRatio + ".");
  }
  if (metrics.totalImages !== null && metrics.totalImages < metrics.registeredImages) {
    warnings.push("COLMAP reports more registered images than total images; model analysis is inconsistent.");
  }
  if (metrics.registeredImages > 0 && metrics.sparsePointCount < metrics.registeredImages * effectiveThresholds.minimumSparsePointsPerRegisteredImage) {
    warnings.push("Sparse reconstruction has " + metrics.sparsePointCount + " points for " + metrics.registeredImages + " registered images; this is low by the configured heuristic and may yield unstable surfaces.");
  }
  if (metrics.meanTrackLength !== null && metrics.meanTrackLength < effectiveThresholds.minimumMeanTrackLength) {
    warnings.push("Mean feature-track length " + metrics.meanTrackLength.toFixed(2) + " is below the review threshold " + effectiveThresholds.minimumMeanTrackLength + ".");
  }
  if (metrics.meanReprojectionErrorPx !== null && metrics.meanReprojectionErrorPx > effectiveThresholds.maximumMeanReprojectionErrorPx) {
    warnings.push("Mean reprojection error " + metrics.meanReprojectionErrorPx.toFixed(2) + " px exceeds the review threshold " + effectiveThresholds.maximumMeanReprojectionErrorPx + " px.");
  }

  return {
    schemaVersion: "1.0.0",
    status: warnings.length ? "review-recommended" : "diagnostics-passed",
    sourceImageCount: sourceCount,
    registeredImageRatio,
    metrics,
    thresholds: effectiveThresholds,
    warnings,
    caveat: "Diagnostics are heuristic review hints, not proof of overlap, scale, completeness, or architectural accuracy.",
  };
}
