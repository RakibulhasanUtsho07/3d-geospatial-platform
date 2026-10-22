import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import { createFloorPlanRasterLineProposal } from "@/core/building-generation/floor-plan-raster-line-job.mjs";

const MAX_REQUEST_BYTES = 16 * 1024;

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new RangeError("Raster line proposal request exceeds the 16 KiB limit.");
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
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RangeError("Raster line proposal request exceeds the 16 KiB limit.");
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

function errorResponse(error: unknown, bodyPhase = false) {
  if (error instanceof RangeError) {
    return NextResponse.json({ error: error.message }, { status: bodyPhase ? 413 : 422 });
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") {
    return NextResponse.json({ error: "Uploaded source or saved proposal was not found." }, { status: 404 });
  }
  if (code === "UNSUPPORTED_RASTER_SOURCE") {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Raster source type is not supported." }, { status: 415 });
  }
  if (code === "SOURCE_CHECKSUM_MISMATCH") {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Source checksum mismatch." }, { status: 422 });
  }
  if (error instanceof TypeError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ error: "Could not create the private raster line proposal." }, { status: 500 });
}

export async function POST(request: Request) {
  const auth = authorizeGenerationApiRequest(request);
  if (!auth.allowed) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let workspaceRoot: string;
  try {
    workspaceRoot = getGenerationWorkspaceRoot();
  } catch {
    return NextResponse.json({ error: "Generation workspace is not configured on this server." }, { status: 503 });
  }

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  let input: unknown;
  try {
    input = await readJsonBody(request);
  } catch (error) {
    return errorResponse(error, true);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return NextResponse.json({ error: "Request must be a JSON object." }, { status: 400 });
  }
  const value = input as Record<string, unknown>;
  if (typeof value.buildingId !== "string" || typeof value.sourceId !== "string") {
    return NextResponse.json({ error: "buildingId and sourceId are required strings." }, { status: 400 });
  }
  if (value.options !== undefined && (!value.options || typeof value.options !== "object" || Array.isArray(value.options))) {
    return NextResponse.json({ error: "options must be an object when supplied." }, { status: 400 });
  }

  try {
    const result = await createFloorPlanRasterLineProposal({
      workspaceRoot,
      buildingId: value.buildingId,
      sourceId: value.sourceId,
      options: (value.options ?? {}) as Record<string, unknown>,
    });
    return NextResponse.json(result, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
