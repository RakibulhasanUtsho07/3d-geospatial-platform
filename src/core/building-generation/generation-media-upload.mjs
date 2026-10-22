import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { ingestMediaFile } from "./media-intake.mjs";

export const MAX_GENERATION_MEDIA_UPLOAD_BYTES = 50 * 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const KINDS = new Set(["auto", "image", "video", "floor-plan"]);

function safeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier of at most 80 characters.");
  }
  return value;
}

/**
 * Store an authenticated API upload through the same signature-checking,
 * content-addressed intake path used by local media ingestion.
 *
 * Rights are never auto-approved. A later generation request must provide a
 * known licence and an explicit rights attestation; the source record remains
 * unreviewed until that workflow actually performs the source review.
 */
export async function ingestUploadedGenerationMedia(options) {
  if (!options || typeof options !== "object") throw new TypeError("upload options are required.");
  const buildingId = safeId(options.buildingId, "buildingId");
  const sourceId = safeId(options.sourceId, "sourceId");
  const kind = options.kind ?? "auto";
  if (!KINDS.has(kind)) throw new TypeError("kind must be auto, image, video or floor-plan.");

  const bytes = Buffer.isBuffer(options.bytes)
    ? options.bytes
    : options.bytes instanceof Uint8Array
      ? Buffer.from(options.bytes)
      : null;
  if (!bytes) throw new TypeError("bytes must be a Buffer or Uint8Array.");
  if (bytes.length === 0) throw new RangeError("uploaded media file is empty.");
  if (bytes.length > MAX_GENERATION_MEDIA_UPLOAD_BYTES) {
    throw new RangeError("uploaded media exceeds the 50 MiB API upload limit.");
  }

  const root = await realpath(path.resolve(options.workspaceRoot));
  const stagingDirectory = await mkdtemp(path.join(root, ".generation-upload-"));
  const stagingFile = path.join(stagingDirectory, "payload.bin");
  try {
    await writeFile(stagingFile, bytes, { flag: "wx", mode: 0o600 });
    const sourcePath = path.relative(root, stagingFile).split(path.sep).join("/");
    const result = await ingestMediaFile({
      workspaceRoot: root,
      sourcePath,
      buildingId,
      sourceId,
      kind,
      title: options.title,
      licence: options.licence ?? "unknown",
      usageStatus: "unreviewed",
      author: options.author,
      attribution: options.attribution,
      sourceUrl: options.sourceUrl,
      capturedAt: options.capturedAt,
      description: options.description,
    });
    return { record: result.record };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
