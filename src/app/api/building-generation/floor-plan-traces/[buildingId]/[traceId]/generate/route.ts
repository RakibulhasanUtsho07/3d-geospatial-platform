import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import { generateFloorPlanCandidateFromRasterTrace } from "@/core/building-generation/floor-plan-raster-generation.mjs";

type RouteContext = { params: Promise<{ buildingId: string; traceId: string }> };
const MAX_BODY_BYTES = 128 * 1024;
const ALLOWED_KEYS = new Set([
  "confirmTraceReview", "planId", "name", "reviewNotes", "origin", "originPixel",
  "calibration", "level", "confirmedLineIds", "confirmedRoomIds",
]);

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new RangeError("Trace-to-model request exceeds the 128 KiB limit.");
  }
  if (!request.body) throw new TypeError("Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RangeError("Trace-to-model request exceeds the 128 KiB limit.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new TypeError("Request body must be valid JSON.");
  }
}

function statusFor(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") return 404;
  if (["SOURCE_CHECKSUM_MISMATCH", "TRACE_CHECKSUM_MISMATCH"].includes(code)) return 409;
  if (["SOURCE_KIND_MISMATCH", "UNSUPPORTED_SOURCE_MEDIA"].includes(code)) return 422;
  if (error instanceof RangeError || code === "TRACE_OUTPUT_TOO_LARGE") return 422;
  if (error instanceof TypeError) return 422;
  return 500;
}

export async function POST(request: Request, context: RouteContext) {
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
    body = await readBoundedJson(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid conversion request." },
      { status: error instanceof RangeError ? 413 : 400 },
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an object." }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) return NextResponse.json({ error: "Unsupported conversion field: " + key }, { status: 400 });
  }

  const { buildingId, traceId } = await context.params;
  try {
    const result = await generateFloorPlanCandidateFromRasterTrace({
      workspaceRoot,
      buildingId,
      traceId,
      conversion: input,
    });
    return NextResponse.json(result, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not generate a model from this trace." },
      { status: statusFor(error) },
    );
  }
}
