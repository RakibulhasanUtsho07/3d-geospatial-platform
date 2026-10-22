import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { hammingDistanceHex, readImageDimensions } from "./image-quality-preflight.mjs";

const SAMPLE_WIDTH = 64;
const SAMPLE_HEIGHT = 64;
const SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;
const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 8000;

function validPositiveInteger(value, label, max = 120000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(label + " must be an integer between 1 and " + max);
  }
  return value;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values, avg = mean(values)) {
  return values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
}

function meanSquaredError(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += (left[i] - right[i]) ** 2;
  return sum / left.length;
}

function meanAbsoluteError(left, right) {
  let sum = 0;
  for (let i = 0; i < left.length; i++) sum += Math.abs(left[i] - right[i]);
  return sum / left.length;
}

function differenceHash(pixels) {
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    const py = Math.min(SAMPLE_HEIGHT - 1, Math.floor((y + 0.5) * SAMPLE_HEIGHT / 8));
    for (let x = 0; x < 8; x++) {
      const leftX = Math.min(SAMPLE_WIDTH - 1, Math.floor((x + 0.5) * SAMPLE_WIDTH / 9));
      const rightX = Math.min(SAMPLE_WIDTH - 1, Math.floor((x + 1.5) * SAMPLE_WIDTH / 9));
      bits = (bits << 1n) | (pixels[py * SAMPLE_WIDTH + leftX] > pixels[py * SAMPLE_WIDTH + rightX] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

function localSsim(left, right) {
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const windowSize = 8;
  const values = [];
  for (let top = 0; top < SAMPLE_HEIGHT; top += windowSize) {
    for (let leftX = 0; leftX < SAMPLE_WIDTH; leftX += windowSize) {
      const a = [];
      const b = [];
      for (let y = top; y < top + windowSize; y++) {
        for (let x = leftX; x < leftX + windowSize; x++) {
          const index = y * SAMPLE_WIDTH + x;
          a.push(left[index]);
          b.push(right[index]);
        }
      }
      const meanA = mean(a);
      const meanB = mean(b);
      let covariance = 0;
      for (let i = 0; i < a.length; i++) covariance += (a[i] - meanA) * (b[i] - meanB);
      covariance /= a.length;
      const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
      const denominator = (meanA ** 2 + meanB ** 2 + c1) * (variance(a, meanA) + variance(b, meanB) + c2);
      values.push(denominator === 0 ? 1 : numerator / denominator);
    }
  }
  return mean(values);
}

function edgeStructure(pixels) {
  const orientationWeights = Array(8).fill(0);
  const laplacianValues = [];
  let gradientSum = 0;
  let edgePixelCount = 0;
  const sampleCount = (SAMPLE_WIDTH - 2) * (SAMPLE_HEIGHT - 2);

  for (let y = 1; y < SAMPLE_HEIGHT - 1; y++) {
    for (let x = 1; x < SAMPLE_WIDTH - 1; x++) {
      const index = y * SAMPLE_WIDTH + x;
      const left = pixels[index - 1];
      const right = pixels[index + 1];
      const up = pixels[index - SAMPLE_WIDTH];
      const down = pixels[index + SAMPLE_WIDTH];
      const center = pixels[index];
      const gx = right - left;
      const gy = down - up;
      const magnitude = Math.hypot(gx, gy) / 2;
      gradientSum += magnitude;
      if (magnitude >= 18) {
        edgePixelCount++;
        const angle = Math.atan2(gy, gx);
        const foldedAngle = ((angle % Math.PI) + Math.PI) % Math.PI;
        const bin = Math.min(7, Math.floor(foldedAngle / Math.PI * 8));
        orientationWeights[bin] += magnitude;
      }
      laplacianValues.push(4 * center - left - right - up - down);
    }
  }

  const orientationTotal = orientationWeights.reduce((sum, value) => sum + value, 0);
  const orientationHistogram = orientationTotal > 0
    ? orientationWeights.map((value) => value / orientationTotal)
    : Array(8).fill(0);
  const meanLaplacian = mean(laplacianValues);
  return {
    meanGradientMagnitude: gradientSum / sampleCount,
    edgePixelCount,
    edgeDensity: edgePixelCount / sampleCount,
    laplacianVariance: variance(laplacianValues, meanLaplacian),
    orientationHistogram,
  };
}

function edgeOrientationHistogramDistance(left, right) {
  const leftTotal = left.reduce((sum, value) => sum + value, 0);
  const rightTotal = right.reduce((sum, value) => sum + value, 0);
  if (leftTotal === 0 && rightTotal === 0) return 0;
  if (leftTotal === 0 || rightTotal === 0) return 1;
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    distance += Math.abs(left[index] - right[index]);
  }
  return distance / 2;
}

/**
 * Compare two decoded 64x64 grayscale previews. These values are triage signals,
 * not a calibrated architectural/geometry accuracy metric.
 */
export function compareGrayscaleImageSamples(referencePixels, candidatePixels, dimensions, options = {}) {
  if (!Buffer.isBuffer(referencePixels) || referencePixels.length !== SAMPLE_BYTES) {
    throw new TypeError("referencePixels must contain exactly 4096 grayscale bytes");
  }
  if (!Buffer.isBuffer(candidatePixels) || candidatePixels.length !== SAMPLE_BYTES) {
    throw new TypeError("candidatePixels must contain exactly 4096 grayscale bytes");
  }
  const reference = dimensions?.reference;
  const candidate = dimensions?.candidate;
  for (const [label, value] of [["reference", reference], ["candidate", candidate]]) {
    if (!value || !Number.isSafeInteger(value.width) || value.width < 1 ||
      !Number.isSafeInteger(value.height) || value.height < 1) {
      throw new TypeError(label + " dimensions must contain positive integer width and height");
    }
  }

  const referenceAspect = reference.width / reference.height;
  const candidateAspect = candidate.width / candidate.height;
  const aspectRatioDifferencePercent = Math.abs(candidateAspect - referenceAspect) / referenceAspect * 100;
  const maxAspectRatioDifferencePercent = options.maxAspectRatioDifferencePercent ?? 2;
  const minimumLocalSsim = options.minimumLocalSsim ?? 0.75;
  const maximumMeanAbsoluteError = options.maximumMeanAbsoluteError ?? 24;
  const maximumEdgeDensityDifference = options.maximumEdgeDensityDifference ?? 0.15;
  const maximumEdgeOrientationHistogramDistance = options.maximumEdgeOrientationHistogramDistance ?? 0.35;
  const minimumSharpnessRatio = options.minimumSharpnessRatio ?? 0.5;
  const minimumReferenceLaplacianVariance = options.minimumReferenceLaplacianVariance ?? 18;
  if (!Number.isFinite(maxAspectRatioDifferencePercent) || maxAspectRatioDifferencePercent < 0 || maxAspectRatioDifferencePercent > 100) {
    throw new RangeError("maxAspectRatioDifferencePercent must be between 0 and 100");
  }
  if (!Number.isFinite(minimumLocalSsim) || minimumLocalSsim < -1 || minimumLocalSsim > 1) {
    throw new RangeError("minimumLocalSsim must be between -1 and 1");
  }
  if (!Number.isFinite(maximumMeanAbsoluteError) || maximumMeanAbsoluteError < 0 || maximumMeanAbsoluteError > 255) {
    throw new RangeError("maximumMeanAbsoluteError must be between 0 and 255");
  }
  if (!Number.isFinite(maximumEdgeDensityDifference) || maximumEdgeDensityDifference < 0 || maximumEdgeDensityDifference > 1) {
    throw new RangeError("maximumEdgeDensityDifference must be between 0 and 1");
  }
  if (!Number.isFinite(maximumEdgeOrientationHistogramDistance) ||
    maximumEdgeOrientationHistogramDistance < 0 || maximumEdgeOrientationHistogramDistance > 1) {
    throw new RangeError("maximumEdgeOrientationHistogramDistance must be between 0 and 1");
  }
  if (!Number.isFinite(minimumSharpnessRatio) || minimumSharpnessRatio < 0 || minimumSharpnessRatio > 1) {
    throw new RangeError("minimumSharpnessRatio must be between 0 and 1");
  }
  if (!Number.isFinite(minimumReferenceLaplacianVariance) ||
    minimumReferenceLaplacianVariance < 0 || minimumReferenceLaplacianVariance > 1000000) {
    throw new RangeError("minimumReferenceLaplacianVariance must be between 0 and 1000000");
  }

  const referenceStructure = edgeStructure(referencePixels);
  const candidateStructure = edgeStructure(candidatePixels);
  const edgeDensityAbsoluteDifference = Math.abs(referenceStructure.edgeDensity - candidateStructure.edgeDensity);
  const orientationDistance = edgeOrientationHistogramDistance(
    referenceStructure.orientationHistogram,
    candidateStructure.orientationHistogram,
  );
  const candidateToReferenceSharpnessRatio = referenceStructure.laplacianVariance > 1e-9
    ? candidateStructure.laplacianVariance / referenceStructure.laplacianVariance
    : null;
  const mse = meanSquaredError(referencePixels, candidatePixels);
  const mae = meanAbsoluteError(referencePixels, candidatePixels);
  const ssim = localSsim(referencePixels, candidatePixels);
  const referenceHash = differenceHash(referencePixels);
  const candidateHash = differenceHash(candidatePixels);
  const warnings = [];
  if (aspectRatioDifferencePercent > maxAspectRatioDifferencePercent) {
    warnings.push("aspect-ratio-difference-exceeds-screening-threshold");
  }
  if (ssim < minimumLocalSsim) warnings.push("low-grayscale-ssim-screening-hint");
  if (mae > maximumMeanAbsoluteError) warnings.push("high-grayscale-pixel-error-screening-hint");
  if (edgeDensityAbsoluteDifference > maximumEdgeDensityDifference) {
    warnings.push("edge-density-difference-screening-hint");
  }
  if (referenceStructure.edgePixelCount >= 16 && candidateStructure.edgePixelCount >= 16 &&
    orientationDistance > maximumEdgeOrientationHistogramDistance) {
    warnings.push("edge-orientation-structure-difference-screening-hint");
  }
  if (candidateToReferenceSharpnessRatio !== null &&
    referenceStructure.laplacianVariance >= minimumReferenceLaplacianVariance &&
    candidateToReferenceSharpnessRatio < minimumSharpnessRatio) {
    warnings.push("candidate-lower-sharpness-screening-hint");
  }

  return {
    schemaVersion: "1.0.0",
    engine: "render-image-similarity-diagnostics-v1",
    status: "diagnostics-computed",
    comparability: {
      aspectRatioDifferencePercent: Number(aspectRatioDifferencePercent.toFixed(3)),
      maxAspectRatioDifferencePercent,
      aspectRatioWithinScreeningThreshold: aspectRatioDifferencePercent <= maxAspectRatioDifferencePercent,
      sameFacadeConfirmedByTool: false,
      cameraPoseAlignmentVerifiedByTool: false,
    },
    metrics: {
      sampleWidth: SAMPLE_WIDTH,
      sampleHeight: SAMPLE_HEIGHT,
      pixelCount: SAMPLE_BYTES,
      meanAbsoluteError: Number(mae.toFixed(3)),
      rootMeanSquaredError: Number(Math.sqrt(mse).toFixed(3)),
      psnrDb: mse === 0 ? null : Number((10 * Math.log10((255 ** 2) / mse)).toFixed(3)),
      localSsim8x8: Number(ssim.toFixed(6)),
      referenceDifferenceHash: referenceHash,
      candidateDifferenceHash: candidateHash,
      differenceHashHammingDistance: hammingDistanceHex(referenceHash, candidateHash),
      maxDifferenceHashHammingDistance: 64,
      referenceEdgePixelCount: referenceStructure.edgePixelCount,
      candidateEdgePixelCount: candidateStructure.edgePixelCount,
      referenceEdgeDensity: Number(referenceStructure.edgeDensity.toFixed(4)),
      candidateEdgeDensity: Number(candidateStructure.edgeDensity.toFixed(4)),
      edgeDensityAbsoluteDifference: Number(edgeDensityAbsoluteDifference.toFixed(4)),
      referenceMeanGradientMagnitude: Number(referenceStructure.meanGradientMagnitude.toFixed(3)),
      candidateMeanGradientMagnitude: Number(candidateStructure.meanGradientMagnitude.toFixed(3)),
      referenceLaplacianVariance: Number(referenceStructure.laplacianVariance.toFixed(3)),
      candidateLaplacianVariance: Number(candidateStructure.laplacianVariance.toFixed(3)),
      candidateToReferenceSharpnessRatio: candidateToReferenceSharpnessRatio === null
        ? null : Number(candidateToReferenceSharpnessRatio.toFixed(4)),
      referenceEdgeOrientationHistogram: referenceStructure.orientationHistogram.map((value) => Number(value.toFixed(4))),
      candidateEdgeOrientationHistogram: candidateStructure.orientationHistogram.map((value) => Number(value.toFixed(4))),
      edgeOrientationHistogramDistance: Number(orientationDistance.toFixed(4)),
    },
    thresholds: {
      minimumLocalSsim,
      maximumMeanAbsoluteError,
      maximumEdgeDensityDifference,
      maximumEdgeOrientationHistogramDistance,
      minimumSharpnessRatio,
      minimumReferenceLaplacianVariance,
    },
    warnings,
    interpretation: warnings.length ? "review-recommended" : "no-screening-warning",
    policy: {
      automaticMatch: false,
      architecturalAccuracyCertified: false,
      publicationEligible: false,
      mapReady: false,
      note: "No warning is not proof of a match; these grayscale, downsampled pixel metrics are sensitive to pose, crop, lighting, occlusion and texture.",
    },
    limitations: [
      "The tool resizes each image into a bounded 64x64 grayscale preview with aspect-ratio-preserving padding; it does not align cameras or register image features.",
      "Edge density, orientation histograms and Laplacian variance are coarse, downsampled screening signals; they can be affected by texture, noise, lighting, crop and unrelated scene content.",
      "Edge orientation measures image-gradient direction, not compass heading or a verified building-facade orientation. The sharpness ratio is not a calibrated blur measurement.",
      "Use only reference/render pairs showing the same facade from a closely matched pose, with similar crop and exposure.",
      "Different illumination, shadows, weather, lens distortion, perspective, vegetation and occlusion can dominate the metrics even when geometry is sound.",
      "Similar pixel values can be caused by texture or background and do not establish correct 3D geometry, dimensions, building identity or heritage fidelity.",
      "This diagnostic never changes a human comparison outcome or release-readiness decision.",
    ],
  };
}

async function inspectImageFile(imagePath, label) {
  if (typeof imagePath !== "string" || !imagePath.trim()) throw new TypeError(label + " imagePath is required");
  const absolutePath = path.resolve(imagePath);
  const entry = await lstat(absolutePath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new TypeError(label + " image must be a regular file and must not be a symlink");
  }
  const resolvedPath = await realpath(absolutePath);
  const fileStats = await stat(resolvedPath);
  if (fileStats.size <= 0) throw new TypeError(label + " image file is empty");

  const headerLength = Math.min(fileStats.size, MAX_HEADER_BYTES);
  const headerChunks = [];
  for await (const chunk of createReadStream(resolvedPath, { start: 0, end: headerLength - 1 })) headerChunks.push(chunk);
  const dimensions = readImageDimensions(Buffer.concat(headerChunks));
  if (!dimensions) throw new TypeError(label + " image must have readable JPEG/PNG dimensions in its header");

  const sha = createHash("sha256");
  for await (const chunk of createReadStream(resolvedPath)) sha.update(chunk);
  return {
    path: resolvedPath,
    filename: path.basename(resolvedPath),
    bytes: fileStats.size,
    sha256: sha.digest("hex"),
    mtimeMs: fileStats.mtimeMs,
    inode: fileStats.ino,
    dimensions,
  };
}

async function decodeGrayscalePreview(imagePath, options = {}) {
  const timeoutMs = validPositiveInteger(options.timeoutMs ?? 15000, "timeoutMs", 120000);
  if (timeoutMs < 1000) throw new RangeError("timeoutMs must be at least 1000");
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_BIN || "ffmpeg";
  const filter = "scale=64:64:force_original_aspect_ratio=decrease:flags=area,pad=64:64:(ow-iw)/2:(oh-ih)/2:color=gray,format=gray";
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-i", imagePath,
    "-frames:v", "1", "-vf", filter, "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ];
  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = (options.spawnImpl ?? nodeSpawn)(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new Error("Could not start FFmpeg image comparison: " + error.message));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = "";
    let settled = false;
    let timer;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    child.stdout?.on("data", (chunk) => {
      if (stdout.length + chunk.length > SAMPLE_BYTES) {
        child.kill("SIGTERM");
        done(reject, new Error("FFmpeg emitted too many grayscale preview bytes"));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARS); });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(reject, new Error("FFmpeg image comparison timed out after " + timeoutMs + " ms"));
    }, timeoutMs);
    child.once("error", (error) => done(reject, new Error("Could not start FFmpeg image comparison: " + error.message)));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        done(reject, new Error("FFmpeg image comparison failed (exit " + code + (signal ? ", signal " + signal : "") + "): " + (stderr.trim().slice(-3000) || "no diagnostic output")));
      } else if (stdout.length !== SAMPLE_BYTES) {
        done(reject, new TypeError("FFmpeg returned " + stdout.length + " grayscale bytes; expected " + SAMPLE_BYTES));
      } else {
        done(resolve, stdout);
      }
    });
  });
}

/** Decode two JPEG/PNG images and emit diagnostic metrics for a single reference/render pair. */
export async function analyzeRenderImageSimilarity(options = {}) {
  if (!options || typeof options !== "object") throw new TypeError("options must be an object");
  const [reference, candidate] = await Promise.all([
    inspectImageFile(options.referenceImagePath, "reference"),
    inspectImageFile(options.candidateImagePath, "candidate render"),
  ]);
  const [referencePixels, candidatePixels] = await Promise.all([
    decodeGrayscalePreview(reference.path, options),
    decodeGrayscalePreview(candidate.path, options),
  ]);
  const beforeAfter = await Promise.all([
    stat(reference.path),
    stat(candidate.path),
  ]);
  if (beforeAfter[0].size !== reference.bytes || beforeAfter[1].size !== candidate.bytes ||
    beforeAfter[0].mtimeMs !== reference.mtimeMs || beforeAfter[1].mtimeMs !== candidate.mtimeMs ||
    beforeAfter[0].ino !== reference.inode || beforeAfter[1].ino !== candidate.inode) {
    throw new Error("an image file changed while similarity diagnostics were running");
  }
  const diagnostic = compareGrayscaleImageSamples(
    referencePixels,
    candidatePixels,
    { reference: reference.dimensions, candidate: candidate.dimensions },
    options.thresholds,
  );
  return {
    ...diagnostic,
    pair: {
      reference: {
        filename: reference.filename,
        bytes: reference.bytes,
        sha256: reference.sha256,
        width: reference.dimensions.width,
        height: reference.dimensions.height,
      },
      candidateRender: {
        filename: candidate.filename,
        bytes: candidate.bytes,
        sha256: candidate.sha256,
        width: candidate.dimensions.width,
        height: candidate.dimensions.height,
      },
    },
  };
}
