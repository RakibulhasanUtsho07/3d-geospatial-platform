import { reviewUvSeams } from "./uv-seam-review.mjs";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function pixelDataIsValid(pixelData) {
  if (!pixelData || !Buffer.isBuffer(pixelData.pixels) ||
      !Number.isInteger(pixelData.width) || pixelData.width < 1 ||
      !Number.isInteger(pixelData.height) || pixelData.height < 1) return false;
  const channelsByType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByType[pixelData.colorType];
  return channels && pixelData.channels === channels &&
    pixelData.pixels.length === pixelData.width * pixelData.height * channels;
}

function rgbaAt(pixelData, x, y) {
  const px = clamp(x, 0, pixelData.width - 1);
  const py = clamp(y, 0, pixelData.height - 1);
  const base = (Math.round(py) * pixelData.width + Math.round(px)) * pixelData.channels;
  const p = pixelData.pixels;
  if (pixelData.colorType === 0) return [p[base], p[base], p[base], 255];
  if (pixelData.colorType === 2) return [p[base], p[base + 1], p[base + 2], 255];
  if (pixelData.colorType === 4) return [p[base], p[base], p[base], p[base + 1]];
  return [p[base], p[base + 1], p[base + 2], p[base + 3]];
}

function uvToPixel(uv, pixelData) {
  return [
    clamp(uv[0], 0, 1) * Math.max(0, pixelData.width - 1),
    (1 - clamp(uv[1], 0, 1)) * Math.max(0, pixelData.height - 1),
  ];
}

function sampleBilinear(pixelData, point) {
  const x = clamp(point[0], 0, pixelData.width - 1);
  const y = clamp(point[1], 0, pixelData.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(pixelData.width - 1, x0 + 1);
  const y1 = Math.min(pixelData.height - 1, y0 + 1);
  const tx = x - x0, ty = y - y0;
  const p00 = rgbaAt(pixelData, x0, y0), p10 = rgbaAt(pixelData, x1, y0);
  const p01 = rgbaAt(pixelData, x0, y1), p11 = rgbaAt(pixelData, x1, y1);
  return p00.map((_, channel) => {
    const top = p00[channel] * (1 - tx) + p10[channel] * tx;
    const bottom = p01[channel] * (1 - tx) + p11[channel] * tx;
    return top * (1 - ty) + bottom * ty;
  });
}

function meanRgbDelta(a, b) {
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
}

function lerp2(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function insetPointOnTriangleEdge(edgeStart, edgeEnd, thirdUv, t, pixelData, insetPixels) {
  const start = uvToPixel(edgeStart, pixelData);
  const end = uvToPixel(edgeEnd, pixelData);
  const third = uvToPixel(thirdUv, pixelData);
  const edge = [end[0] - start[0], end[1] - start[1]];
  const edgeLength = Math.hypot(edge[0], edge[1]);
  const point = [start[0] + edge[0] * t, start[1] + edge[1] * t];
  if (edgeLength < 1e-6) return point;
  let normal = [-edge[1] / edgeLength, edge[0] / edgeLength];
  const towardThird = [third[0] - point[0], third[1] - point[1]];
  if (normal[0] * towardThird[0] + normal[1] * towardThird[1] < 0) normal = [-normal[0], -normal[1]];
  const signedDistance = Math.abs(edge[0] * (third[1] - start[1]) - edge[1] * (third[0] - start[0])) / edgeLength;
  const inset = Math.min(insetPixels, signedDistance * 0.25);
  return [point[0] + normal[0] * inset, point[1] + normal[1] * inset];
}

/**
 * Samples pixels along geometric edges that the UV seam reviewer identified as
 * discontinuous. Results are review-risk signals, not automatic defect verdicts:
 * adjacent real facades can legitimately have different edge colors/lighting.
 */
export function reviewTexturePixelSeams(input, options = {}) {
  if (!input || !Array.isArray(input.positions) || !Array.isArray(input.uvs) || !Array.isArray(input.indices)) {
    throw new TypeError("input must contain positions, uvs and indices arrays");
  }
  const sampleFractions = options.sampleFractions ?? [0.125, 0.25, 0.5, 0.75, 0.875];
  const minRecommendedDimension = options.minRecommendedDimension ?? 16;
  const pixelDifferenceThreshold = options.pixelDifferenceThreshold ?? 36;
  const maxCandidates = options.maxCandidates ?? 500;
  const insetPixels = options.insetPixels ?? 1.5;
  if (!Array.isArray(sampleFractions) || sampleFractions.length < 1 ||
      sampleFractions.some((t) => !finite(t) || t <= 0 || t >= 1)) {
    throw new RangeError("sampleFractions must contain normalized edge positions strictly between zero and one");
  }
  if (!Number.isInteger(minRecommendedDimension) || minRecommendedDimension < 1) {
    throw new RangeError("minRecommendedDimension must be a positive integer");
  }
  if (!finite(pixelDifferenceThreshold) || pixelDifferenceThreshold < 0 || pixelDifferenceThreshold > 255) {
    throw new RangeError("pixelDifferenceThreshold must be between zero and 255");
  }
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 10000) {
    throw new RangeError("maxCandidates must be an integer between 1 and 10000");
  }
  if (!finite(insetPixels) || insetPixels < 0 || insetPixels > 16) {
    throw new RangeError("insetPixels must be between zero and 16");
  }

  const uvReport = reviewUvSeams(input, options.uvSeamReview ?? {});
  const base = {
    schemaVersion: "1.0.0",
    engine: "texture-pixel-seam-review-v1",
    uvSeamCandidateCount: uvReport.seamCandidateCount,
    analyzedSeamCount: 0,
    sampleCountPerSeam: sampleFractions.length,
    pixelSampleCount: 0,
    highDiscontinuityCount: 0,
    moderateDiscontinuityCount: 0,
    maxMeanEdgeRgbDelta: null,
    meanEdgeRgbDelta: null,
    candidates: [],
    warnings: [],
    publicationEligible: false,
  };
  if (uvReport.seamCandidateCount === 0) {
    return { ...base, status: "no-uv-seam-candidates", limitations: [
      "Only geometric edges with UV endpoint discontinuity are pixel-sampled.",
      "No candidate detected is not proof of visual correctness; rendered review remains necessary.",
    ] };
  }
  if (!pixelDataIsValid(input.pixelData)) {
    return {
      ...base,
      status: "pixel-analysis-unavailable",
      warnings: ["embedded-pixel-data-unavailable-or-unsupported"],
      limitations: ["Pixel seam checks require a decoded, bounded 8-bit non-interlaced PNG texture."],
    };
  }
  const pixelData = input.pixelData;
  if (Math.min(pixelData.width, pixelData.height) < minRecommendedDimension) {
    return {
      ...base,
      width: pixelData.width,
      height: pixelData.height,
      status: "insufficient-resolution",
      warnings: ["texture-too-small-for-reliable-pixel-seam-analysis"],
      limitations: [
        "Texture edges are not assigned a clean result when the embedded image is too small for useful sampling.",
        "Increase texture resolution and review the rendered model before publication.",
      ],
    };
  }

  const candidates = uvReport.candidates.slice(0, maxCandidates);
  const analysisTruncated = uvReport.candidates.length > candidates.length;
  const findings = [];
  for (const candidate of candidates) {
    const [leftTriangleIndex, rightTriangleIndex] = candidate.triangleIndices;
    const leftTriangle = input.indices.slice(leftTriangleIndex * 3, leftTriangleIndex * 3 + 3);
    const rightTriangle = input.indices.slice(rightTriangleIndex * 3, rightTriangleIndex * 3 + 3);
    const endpointLeftIndices = candidate.endpoints.map((endpoint) => endpoint.leftVertexIndex);
    const endpointRightIndices = candidate.endpoints.map((endpoint) => endpoint.rightVertexIndex);
    const leftThirdIndex = leftTriangle.find((index) => !endpointLeftIndices.includes(index));
    const rightThirdIndex = rightTriangle.find((index) => !endpointRightIndices.includes(index));
    if (leftThirdIndex === undefined || rightThirdIndex === undefined) continue;

    const endpoints = candidate.endpoints;
    const leftEdgeUv = [endpoints[0].leftUv, endpoints[1].leftUv];
    const rightEdgeUv = [endpoints[0].rightUv, endpoints[1].rightUv];
    const leftThirdUv = input.uvs[leftThirdIndex], rightThirdUv = input.uvs[rightThirdIndex];
    const samples = [];
    for (const t of sampleFractions) {
      const leftUv = lerp2(leftEdgeUv[0], leftEdgeUv[1], t);
      const rightUv = lerp2(rightEdgeUv[0], rightEdgeUv[1], t);
      const leftEdgePixel = uvToPixel(leftUv, pixelData);
      const rightEdgePixel = uvToPixel(rightUv, pixelData);
      const leftInnerPixel = insetPointOnTriangleEdge(leftEdgeUv[0], leftEdgeUv[1], leftThirdUv, t, pixelData, insetPixels);
      const rightInnerPixel = insetPointOnTriangleEdge(rightEdgeUv[0], rightEdgeUv[1], rightThirdUv, t, pixelData, insetPixels);
      const leftEdge = sampleBilinear(pixelData, leftEdgePixel);
      const rightEdge = sampleBilinear(pixelData, rightEdgePixel);
      const leftInner = sampleBilinear(pixelData, leftInnerPixel);
      const rightInner = sampleBilinear(pixelData, rightInnerPixel);
      samples.push({
        t,
        edgeRgbDelta: meanRgbDelta(leftEdge, rightEdge),
        insetRgbDelta: meanRgbDelta(leftInner, rightInner),
        leftEdgeToInsetRgbDelta: meanRgbDelta(leftEdge, leftInner),
        rightEdgeToInsetRgbDelta: meanRgbDelta(rightEdge, rightInner),
        edgeAlphaDelta: Math.abs(leftEdge[3] - rightEdge[3]),
      });
    }
    if (!samples.length) continue;
    const meanEdgeRgbDelta = samples.reduce((sum, sample) => sum + sample.edgeRgbDelta, 0) / samples.length;
    const sortedDeltas = samples.map((sample) => sample.edgeRgbDelta).sort((a, b) => a - b);
    const p95Index = Math.min(sortedDeltas.length - 1, Math.ceil(sortedDeltas.length * 0.95) - 1);
    const maxEdgeRgbDelta = sortedDeltas[sortedDeltas.length - 1];
    const meanInsetRgbDelta = samples.reduce((sum, sample) => sum + sample.insetRgbDelta, 0) / samples.length;
    const meanEdgeToInsetRgbDelta = samples.reduce((sum, sample) =>
      sum + sample.leftEdgeToInsetRgbDelta + sample.rightEdgeToInsetRgbDelta, 0) / (samples.length * 2);
    const classification = meanEdgeRgbDelta >= pixelDifferenceThreshold
      ? "high-discontinuity-review"
      : meanEdgeRgbDelta >= pixelDifferenceThreshold * 0.5
        ? "moderate-discontinuity-review"
        : "low-discontinuity-signal";
    findings.push({
      edgeKey: candidate.edgeKey,
      triangleIndices: candidate.triangleIndices,
      classification,
      meanEdgeRgbDelta: Number(meanEdgeRgbDelta.toFixed(3)),
      p95EdgeRgbDelta: Number(sortedDeltas[p95Index].toFixed(3)),
      maxEdgeRgbDelta: Number(maxEdgeRgbDelta.toFixed(3)),
      meanInsetRgbDelta: Number(meanInsetRgbDelta.toFixed(3)),
      meanEdgeToInsetRgbDelta: Number(meanEdgeToInsetRgbDelta.toFixed(3)),
      threshold: pixelDifferenceThreshold,
      samples,
      interpretation: "Pixel discontinuity is a review signal, not proof of an incorrect texture: real adjacent surfaces may differ in color, lighting or camera exposure.",
    });
  }

  const high = findings.filter((item) => item.classification === "high-discontinuity-review").length;
  const moderate = findings.filter((item) => item.classification === "moderate-discontinuity-review").length;
  const warnings = [];
  if (high) warnings.push("high-pixel-discontinuity-review-required");
  if (moderate) warnings.push("moderate-pixel-discontinuity-review-required");
  if (analysisTruncated) warnings.push("pixel-seam-candidate-analysis-truncated");
  return {
    ...base,
    width: pixelData.width,
    height: pixelData.height,
    status: analysisTruncated ? "analysis-truncated" : high || moderate ? "review-required" : "low-discontinuity-signals-detected",
    analyzedSeamCount: findings.length,
    pixelSampleCount: findings.length * sampleFractions.length,
    highDiscontinuityCount: high,
    moderateDiscontinuityCount: moderate,
    maxMeanEdgeRgbDelta: findings.length ? Math.max(...findings.map((item) => item.meanEdgeRgbDelta)) : null,
    meanEdgeRgbDelta: findings.length ? Number((findings.reduce((sum, item) => sum + item.meanEdgeRgbDelta, 0) / findings.length).toFixed(3)) : null,
    candidates: findings,
    warnings,
    analysisTruncated,
    limitations: [
      "RGB edge deltas are heuristic discontinuity measures; intentional UV islands and real facade color changes can be flagged.",
      "Sampling uses a bounded set of points along each candidate edge and cannot guarantee the absence of sub-pixel artifacts.",
      "This checks image pixels at existing UVs only. It does not repaint gutters, blend seams, change UVs or render the GLB.",
      "Publication eligibility remains false until visual review and independent geometry/geospatial checks pass.",
    ],
  };
}
