import sharp from "sharp";

const MAX_SAMPLES = 150_000;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Measures a conservative saturated-red pixel signal from a map-canvas PNG.
 * It is a diagnostic only; it cannot identify which layer produced the pixels.
 */
export async function measureCanvasRedPixelSignal(pngBytes) {
  const decoded = await sharp(pngBytes, { failOn: "error" })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = decoded;
  if (info.channels < 3 || info.width < 1 || info.height < 1) {
    throw new TypeError("Map canvas screenshot has invalid pixel dimensions");
  }

  const pixelCount = info.width * info.height;
  const stride = Math.max(1, Math.ceil(pixelCount / MAX_SAMPLES));
  let sampledPixels = 0;
  let redPixels = 0;
  for (let index = 0; index < pixelCount; index += stride) {
    const offset = index * info.channels;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    sampledPixels += 1;
    if (
      red >= 145 &&
      red > green * 1.35 &&
      red > blue * 1.25 &&
      red - green > 28
    ) {
      redPixels += 1;
    }
  }

  return {
    width: info.width,
    height: info.height,
    sampledPixels,
    redPixelSamples: redPixels,
    redPixelRatio: sampledPixels ? Number((redPixels / sampledPixels).toFixed(6)) : 0,
  };
}

/**
 * Flag a sample only when its red signal is both above a baseline floor and
 * materially above peer samples. This requests visual review; it is not a
 * classifier for intentional red roofs, markers, or overlays.
 */
export function flagCanvasRedPixelOutliers(samples, options = {}) {
  const minimumRatio = Number(options.minimumRatio ?? 0.005);
  const peerMultiplier = Number(options.peerMultiplier ?? 3);
  if (!Number.isFinite(minimumRatio) || minimumRatio < 0 || minimumRatio > 1) {
    throw new RangeError("minimumRatio must be between 0 and 1");
  }
  if (!Number.isFinite(peerMultiplier) || peerMultiplier < 1 || peerMultiplier > 100) {
    throw new RangeError("peerMultiplier must be between 1 and 100");
  }

  const ratios = samples
    .map((sample) => sample?.redPixelRatio)
    .filter((ratio) => typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0);
  const peerMedianRatio = median(ratios);
  const threshold = Math.max(minimumRatio, (peerMedianRatio ?? 0) * peerMultiplier);

  return samples.map((sample) => {
    const ratio = sample?.redPixelRatio;
    const valid = typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0;
    return {
      flagged: valid && ratio >= threshold,
      threshold: Number(threshold.toFixed(6)),
      peerMedianRatio: peerMedianRatio === null ? null : Number(peerMedianRatio.toFixed(6)),
      reason: !valid
        ? "missing-or-invalid-red-pixel-signal"
        : ratio >= threshold
          ? "red-pixel-signal-outlier-review-required"
          : "no-red-pixel-outlier-detected",
    };
  });
}
