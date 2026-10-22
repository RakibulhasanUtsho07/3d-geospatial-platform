import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import { traceFloorPlanImageSource } from "@/core/building-generation/floor-plan-raster-trace-job.mjs";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16 * 1024;
const ALLOWED_OPTIONS = new Set([
  "maxEdge", "threshold", "maxGapPx", "lineMergeTolerancePx",
  "minLineLengthPx", "minRoomSidePx", "maxLinesPerOrientation", "maxRoomCandidates",
]);

async function boundedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new RangeError("Trace request exceeds the 16 KiB limit.");
  }
  if (!request.body) throw new TypeError("Trace request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RangeError("Trace request exceeds the 16 KiB limit.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(data)) as unknown;
  } catch {
    throw new TypeError("Trace request must be valid JSON.");
  }
}

function errorStatus(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") return 404;
  if (code === "UNSUPPORTED_SOURCE_MEDIA") return 415;
  if (["SOURCE_CHECKSUM_MISMATCH", "TRACE_CHECKSUM_MISMATCH"].includes(code)) return 409;
  if (code === "INVALID_RASTER_IMAGE") return 422;
  if (error instanceof RangeError || code === "TRACE_OUTPUT_TOO_LARGE") return 413;
  if (error instanceof TypeError) return 400;
  return 500;
}

export async function POST(request: Request) {
  const auth = authorizeGenerationApiRequest(request);
  if (!auth.allowed) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = getGenerationWorkspaceRoot();
  } catch {
    return NextResponse.json({ error: "Generation workspace is not configured on this server." }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await boundedJson(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid trace request." },
      { status: error instanceof RangeError ? 413 : 400 },
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  if (typeof input.buildingId !== "string" || typeof input.sourceId !== "string") {
    return NextResponse.json({ error: "buildingId and sourceId are required." }, { status: 400 });
  }
  const options = input.options ?? {};
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return NextResponse.json({ error: "options must be an object." }, { status: 400 });
  }
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) {
      return NextResponse.json({ error: "Unsupported trace option: " + key }, { status: 400 });
    }
  }
  if (options.maxEdge !== undefined &&
      (typeof options.maxEdge !== "number" || !Number.isSafeInteger(options.maxEdge) || options.maxEdge < 256 || options.maxEdge > 4096)) {
    return NextResponse.json({ error: "maxEdge must be an integer between 256 and 4096." }, { status: 400 });
  }

  try {
    const result = await traceFloorPlanImageSource({
      workspaceRoot,
      buildingId: input.buildingId,
      sourceId: input.sourceId,
      options: options as Record<string, number>,
    });
    return NextResponse.json(result, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not trace source image." },
      { status: errorStatus(error) },
    );
  }
}
