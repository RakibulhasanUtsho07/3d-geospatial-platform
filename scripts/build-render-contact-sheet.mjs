import path from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

export const REVIEW_VIEW_IDS = [
  "front", "back", "left", "right", "top",
  ...Array.from({ length: 8 }, (_, index) => `turntable-${String(index * 45).padStart(3, "0")}`),
];

function makeLabelSvg(label, width, height) {
  const fontSize = Math.min(14, Math.max(10, Math.floor(height * 0.48)));
  const baseline = Math.floor((height + fontSize) / 2) - 1;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f2efe8"/><text x="8" y="${baseline}" font-family="Arial, sans-serif" font-size="${fontSize}" fill="#1e1e1e">${label}</text></svg>`,
  );
}

/**
 * Builds a contact sheet only when every expected review image exists and has
 * the declared square resolution. Missing or partial renders fail closed.
 */
export async function buildRenderContactSheet(inputDir, outputPath, options = {}) {
  const resolution = Number(options.resolution ?? 1024);
  const thumbSize = Number(options.thumbSize ?? 256);
  const labelHeight = Number(options.labelHeight ?? 28);
  const columns = Number(options.columns ?? 4);

  for (const [name, value] of Object.entries({ resolution, thumbSize, labelHeight, columns })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }

  const layers = [];
  for (const [index, id] of REVIEW_VIEW_IDS.entries()) {
    const imagePath = path.join(inputDir, `${id}.png`);
    const image = sharp(imagePath, { failOn: "error" });
    const metadata = await image.metadata().catch((error) => {
      throw new Error(`Missing or invalid review image '${imagePath}': ${error.message}`);
    });
    if (metadata.width !== resolution || metadata.height !== resolution) {
      throw new Error(
        `Review image '${id}.png' must be ${resolution}×${resolution}; got ${metadata.width}×${metadata.height}`,
      );
    }

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

  return { outputPath, width, height, viewCount: REVIEW_VIEW_IDS.length };
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
