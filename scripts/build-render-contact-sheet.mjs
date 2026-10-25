import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

export const REVIEW_VIEW_IDS = [
  "front", "back", "left", "right", "top",
  ...Array.from({ length: 8 }, (_, index) => \`turntable-\${String(index * 45).padStart(3, "0")}\`),
];

function makeLabelSvg(label, width, height) {
  const fontSize = Math.min(14, Math.max(10, Math.floor(height * 0.48)));
  const baseline = Math.floor((height + fontSize) / 2) - 1;
  return Buffer.from(
    \`<svg xmlns="http://www.w3.org/2000/svg" width="\${width}" height="\${height}"><rect width="100%" height="100%" fill="#f2efe8"/><text x="8" y="\${baseline}" font-family="Arial, sans-serif" font-size="\${fontSize}" fill="#1e1e1e">\${label}</text></svg>\`,
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measureForeground(imagePath, resolution, threshold) {
  const imageBytes = await readFile(imagePath);
  const imageHash = createHash("sha256").update(imageBytes).digest("hex");
  const decoded = await sharp(imageBytes, { failOn: "error" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = decoded;
  if (info.width !== resolution || info.height !== resolution || info.channels !== 3) {
    throw new Error(\`Unexpected decoded PNG layout for \${path.basename(imagePath)}\`);
  }

  const sampleOffsets = [
    0,
    (info.width - 1) * 3,
    (info.height - 1) * info.width * 3,
    ((info.height - 1) * info.width + info.width - 1) * 3,
  ];
  const background = [0, 1, 2].map((channel) =>
    median(sampleOffsets.map((offset) => data[offset + channel])),
  );

  let minX = info.width, minY = info.height, maxX = -1, maxY = -1, foregroundPixels = 0;
  for (let y = 0; y < info.height; y++) {
    const rowOffset = y * info.width * 3;
    for (let x = 0; x < info.width; x++) {
      const offset = rowOffset + x * 3;
      const difference = Math.max(
        Math.abs(data[offset] - background[0]),
        Math.abs(data[offset + 1] - background[1]),
        Math.abs(data[offset + 2] - background[2]),
      );
      if (difference < threshold) continue;
      foregroundPixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (foregroundPixels === 0) {
    return {
      filename: path.basename(imagePath),
      sha256: imageHash,
      width: info.width,
      height: info.height,
      backgroundRgb: background,
      foregroundPixels: 0,
      foregroundPixelRatio: 0,
      foregroundBounds: null,
      widthFillRatio: 0,
      heightFillRatio: 0,
      maxAxisFillRatio: 0,
      status: "failed",
      reason: "no-foreground-detected",
    };
  }

  const foregroundWidth = maxX - minX + 1;
  const foregroundHeight = maxY - minY + 1;
  const widthFillRatio = foregroundWidth / info.width;
  const heightFillRatio = foregroundHeight / info.height;
  const maxAxisFillRatio = Math.max(widthFillRatio, heightFillRatio);
  return {
    filename: path.basename(imagePath),
    sha256: imageHash,
    width: info.width,
    height: info.height,
    backgroundRgb: background,
    foregroundPixels,
    foregroundPixelRatio: Number((foregroundPixels / (info.width * info.height)).toFixed(6)),
    foregroundBounds: { x: minX, y: minY, width: foregroundWidth, height: foregroundHeight },
    widthFillRatio: Number(widthFillRatio.toFixed(6)),
    heightFillRatio: Number(heightFillRatio.toFixed(6)),
    maxAxisFillRatio: Number(maxAxisFillRatio.toFixed(6)),
    status: maxAxisFillRatio >= 0.70 && maxAxisFillRatio <= 0.97 ? "passed" : "failed",
    reason: maxAxisFillRatio < 0.70
      ? "foreground-underfills-frame"
      : maxAxisFillRatio > 0.97
        ? "foreground-too-close-to-frame-edge"
        : null,
  };
}

/**
 * Builds a contact sheet only when all fixed images have the expected size,
 * pixel-visible foreground, and sensible image-space occupancy. This catches
 * render outputs that exist and hash correctly but frame the model too small.
 */
export async function buildRenderContactSheet(inputDir, outputPath, options = {}) {
  const resolution = Number(options.resolution ?? 1024);
  const thumbSize = Number(options.thumbSize ?? 256);
  const labelHeight = Number(options.labelHeight ?? 28);
  const columns = Number(options.columns ?? 4);
  const foregroundThreshold = Number(options.foregroundThreshold ?? 28);
  const minAxisFillRatio = Number(options.minAxisFillRatio ?? 0.70);
  const maxAxisFillRatio = Number(options.maxAxisFillRatio ?? 0.97);

  for (const [name, value] of Object.entries({ resolution, thumbSize, labelHeight, columns })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(\`\${name} must be a positive integer\`);
    }
  }
  if (!Number.isInteger(foregroundThreshold) || foregroundThreshold < 1 || foregroundThreshold > 255) {
    throw new Error("foregroundThreshold must be an integer between 1 and 255");
  }
  if (!Number.isFinite(minAxisFillRatio) || !Number.isFinite(maxAxisFillRatio) ||
      minAxisFillRatio <= 0 || maxAxisFillRatio > 1 || minAxisFillRatio >= maxAxisFillRatio) {
    throw new Error("foreground occupancy limits must satisfy 0 < min < max <= 1");
  }

  const renderManifest = JSON.parse(await readFile(path.join(inputDir, "render-review-manifest.json"), "utf8"));
  if (renderManifest.valid !== true || renderManifest.views?.length !== REVIEW_VIEW_IDS.length ||
      !/^[a-f0-9]{64}$/i.test(renderManifest.modelSha256 ?? "")) {
    throw new Error("render-review-manifest.json must be valid, hash-pinned and contain all 13 required views");
  }
  const manifestById = new Map(renderManifest.views.map((view) => [view.id, view]));
  const layers = [];
  const visibilityViews = [];

  for (const [index, id] of REVIEW_VIEW_IDS.entries()) {
    const imagePath = path.join(inputDir, \`\${id}.png\`);
    const image = sharp(imagePath, { failOn: "error" });
    const metadata = await image.metadata().catch((error) => {
      throw new Error(\`Missing or invalid review image '\${imagePath}': \${error.message}\`);
    });
    if (metadata.width !== resolution || metadata.height !== resolution) {
      throw new Error(
        \`Review image '\${id}.png' must be \${resolution}×\${resolution}; got \${metadata.width}×\${metadata.height}\`,
      );
    }

    const measured = await measureForeground(imagePath, resolution, foregroundThreshold);
    const manifestView = manifestById.get(id);
    if (!manifestView || manifestView.filename !== measured.filename || manifestView.sha256 !== measured.sha256) {
      throw new Error(\`Foreground visibility audit does not match manifest-pinned image: \${id}\`);
    }
    measured.id = id;
    measured.renderManifestSha256 = createHash("sha256")
      .update(await readFile(path.join(inputDir, "render-review-manifest.json")))
      .digest("hex");
    if (measured.status === "passed") {
      measured.status = measured.maxAxisFillRatio >= minAxisFillRatio &&
        measured.maxAxisFillRatio <= maxAxisFillRatio ? "passed" : "failed";
      if (measured.status === "failed") {
        measured.reason = measured.maxAxisFillRatio < minAxisFillRatio
          ? "foreground-underfills-frame"
          : "foreground-too-close-to-frame-edge";
      }
    }
    visibilityViews.push(measured);

    const thumb = await image
      .resize(thumbSize, thumbSize, { fit: "contain", background: "#f2efe8" })
      .png()
      .toBuffer();
    const x = (index % columns) * thumbSize;
    const row = Math.floor(index / columns);
    const y = row * (thumbSize + labelHeight);
    layers.push({ input: thumb, left: x, top: y });
    layers.push({
      input: makeLabelSvg(id, thumbSize, labelHeight),
      left: x,
      top: y + thumbSize,
    });
  }

  const failedViews = visibilityViews.filter((view) => view.status !== "passed");
  const visibilityReport = {
    schemaVersion: "1.0.0",
    candidateModelSha256: renderManifest.modelSha256,
    renderManifestSha256: createHash("sha256")
      .update(await readFile(path.join(inputDir, "render-review-manifest.json")))
      .digest("hex"),
    imageSpaceForegroundThresholdRgb: foregroundThreshold,
    requiredViewCount: REVIEW_VIEW_IDS.length,
    limits: { minMaxAxisFillRatio: minAxisFillRatio, maxAxisFillRatio: maxAxisFillRatio },
    summary: {
      viewCount: visibilityViews.length,
      passedViews: visibilityViews.length - failedViews.length,
      failedViews: failedViews.length,
      status: failedViews.length === 0 ? "passed" : "failed",
    },
    views: visibilityViews,
  };
  const visibilityReportPath = path.join(inputDir, "foreground-visibility-report.json");
  await writeFile(visibilityReportPath, JSON.stringify(visibilityReport, null, 2) + "\n", { flag: "wx" });
  if (failedViews.length) {
    throw new Error(
      "Foreground visibility gate failed: " + failedViews.map((view) =>
        \`\${view.id}=\${view.maxAxisFillRatio} (\${view.reason})\`,
      ).join(", ") + \`; see \${visibilityReportPath}\`,
    );
  }

  const rows = Math.ceil(REVIEW_VIEW_IDS.length / columns);
  const width = columns * thumbSize;
  const height = rows * (thumbSize + labelHeight);
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 242, g: 239, b: 232 },
    },
  })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toFile(outputPath);

  return {
    outputPath,
    width,
    height,
    viewCount: REVIEW_VIEW_IDS.length,
    visibilityReportPath,
    visibilitySummary: visibilityReport.summary,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [inputDir, outputPath, resolutionArg] = process.argv.slice(2);
  if (!inputDir || !outputPath) {
    console.error("Usage: node scripts/build-render-contact-sheet.mjs <render-dir> <output.png> [resolution]");
    process.exitCode = 2;
  } else {
    try {
      const result = await buildRenderContactSheet(inputDir, outputPath, {
        resolution: Number(resolutionArg ?? 1024),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
