import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const CHANNELS = { 0:1, 2:3, 4:2, 6:4 };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Performs bounded approximate pixel statistics on non-interlaced 8-bit PNG.
 * Other formats/layouts get metadata-only review rather than a false clean result.
 */
export function reviewTextureImageContent(bytes, mimeType, options = {}) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("image bytes must be a Buffer");
  const minRecommendedDimension = options.minRecommendedDimension ?? 512;
  const maxPixels = options.maxPixels ?? 16_777_216;
  if (!Number.isSafeInteger(minRecommendedDimension) || minRecommendedDimension < 1) {
    throw new RangeError("minRecommendedDimension must be a positive integer");
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new RangeError("maxPixels must be a positive integer");
  const result = { format: null, width: null, height: null, pixelAnalysis: "not-available", risks: [] };
  if (mimeType !== "image/png" || bytes.length < 24 || !bytes.subarray(0,8).equals(PNG_SIGNATURE)) {
    result.risks.push("pixel-content-not-analysed-for-this-image-format");
    return result;
  }
  let offset = 8, width, height, bitDepth, colorType, interlace, totalIdat = 0;
  const idatChunks = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8, end = start + length;
    if (length > bytes.length || end + 4 > bytes.length) {
      result.risks.push("png-chunk-truncated");
      return result;
    }
    if (type === "IHDR") {
      if (length !== 13 || width !== undefined) { result.risks.push("png-ihdr-invalid"); return result; }
      width = bytes.readUInt32BE(start); height = bytes.readUInt32BE(start + 4);
      bitDepth = bytes[start + 8]; colorType = bytes[start + 9]; interlace = bytes[start + 12];
    } else if (type === "IDAT") {
      totalIdat += length;
      if (totalIdat <= maxPixels * 5) idatChunks.push(bytes.subarray(start, end));
      else { result.risks.push("png-compressed-data-exceeds-analysis-budget"); return result; }
    } else if (type === "IEND") break;
    offset = end + 4;
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    result.risks.push("png-dimensions-unavailable");
    return result;
  }
  result.format = "png";
  result.width = width;
  result.height = height;
  if (Math.max(width, height) < minRecommendedDimension) result.risks.push("low-resolution-texture-review");
  if (width * height > maxPixels) {
    result.risks.push("png-pixel-analysis-skipped-size-budget");
    return result;
  }
  if (bitDepth !== 8 || !Object.hasOwn(CHANNELS, colorType) || interlace !== 0) {
    result.pixelAnalysis = "unsupported-png-layout";
    result.risks.push("png-pixel-analysis-layout-unsupported");
    return result;
  }
  const channels = CHANNELS[colorType], rowBytes = width * channels, expectedLength = height * (rowBytes + 1);
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedLength + 1 });
  } catch {
    result.pixelAnalysis = "invalid-png-data";
    result.risks.push("png-idat-inflate-failed");
    return result;
  }
  if (raw.length !== expectedLength) {
    result.pixelAnalysis = "invalid-png-data";
    result.risks.push("png-decompressed-length-mismatch");
    return result;
  }
  const pixels = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    const rowStart = y * (rowBytes + 1) + 1, outStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const value = raw[rowStart + x];
      const a = x >= channels ? pixels[outStart + x - channels] : 0;
      const b = y > 0 ? pixels[outStart + x - rowBytes] : 0;
      const c = y > 0 && x >= channels ? pixels[outStart + x - rowBytes - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = Math.floor((a + b) / 2);
      else if (filter === 4) predictor = paeth(a, b, c);
      else if (filter !== 0) {
        result.pixelAnalysis = "invalid-png-data";
        result.risks.push("png-unknown-filter");
        return result;
      }
      pixels[outStart + x] = (value + predictor) & 255;
    }
  }
  const sampleBudget = 1_000_000, stride = Math.max(1, Math.ceil((width * height) / sampleBudget));
  let count = 0, mean = 0, m2 = 0, opaque = 0, transparent = 0;
  const luminanceBuckets = new Set();
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += stride) {
    const base = pixelIndex * channels;
    let r, g, b, alpha = 255;
    if (colorType === 0) { r = g = b = pixels[base]; }
    else if (colorType === 2 || colorType === 3) { r = pixels[base]; g = pixels[base+1]; b = pixels[base+2]; }
    else if (colorType === 4) { r = g = b = pixels[base]; alpha = pixels[base+1]; }
    else { r = pixels[base]; g = pixels[base+1]; b = pixels[base+2]; alpha = pixels[base+3]; }
    if (alpha === 0) { transparent++; continue; }
    opaque++;
    const luminance = 0.2126*r + 0.7152*g + 0.0722*b;
    count++;
    const delta = luminance - mean;
    mean += delta / count;
    m2 += delta * (luminance - mean);
    luminanceBuckets.add(Math.round(luminance / 4));
  }
  const standardDeviation = count ? Math.sqrt(m2 / count) : 0;
  const opaquePixelRatio = (opaque + transparent) ? opaque / (opaque + transparent) : 0;
  result.pixelAnalysis = "sampled-8bit-png";
  result.sampledPixels = opaque + transparent;
  result.luminanceMean = Number(mean.toFixed(3));
  result.luminanceStandardDeviation = Number(standardDeviation.toFixed(3));
  result.luminanceBucketCount = luminanceBuckets.size;
  result.opaquePixelRatio = Number(opaquePixelRatio.toFixed(5));
  if (count === 0 || opaquePixelRatio < 0.01) result.risks.push("mostly-transparent-or-empty-texture-review");
  else if (standardDeviation < 1 && luminanceBuckets.size <= 1) result.risks.push("near-uniform-texture-review");
  return result;
}
