import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import { createFloorPlanModelCandidate } from "@/core/building-generation/floor-plan-model-job.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RangeError("Floor-plan JSON exceeds the 2 MiB request limit.");
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
        throw new RangeError("Floor-plan JSON exceeds the 2 MiB request limit.");
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

function errorResponse(error: unknown) {
  if (error instanceof RangeError) {
    return NextResponse.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof TypeError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (code === "ENOENT") {
      return NextResponse.json({ error: "Uploaded floor-plan source was not found in the private workspace." }, { status: 404 });
    }
    if (code === "SOURCE_KIND_MISMATCH" || code === "SOURCE_CHECKSUM_MISMATCH") {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Source evidence did not match." }, { status: 422 });
    }
  }
  const message = error instanceof Error ? error.message : "";
  if (/checksum does not match|does not match the verified uploaded source/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 422 });
  }
  if (/not found|does not exist/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 404 });
  }
  return NextResponse.json({ error: "Could not generate the private floor-plan candidate." }, { status: 500 });
}

export async function POST(request: Request) {
  const auth = authorizeGenerationApiRequest(request);
  if (!auth.allowed) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

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
    return errorResponse(error);
  }
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !("floorPlan" in input) || !input.floorPlan ||
      typeof input.floorPlan !== "object" || Array.isArray(input.floorPlan)) {
    return NextResponse.json({ error: "Request body must contain a floorPlan object." }, { status: 400 });
  }

  try {
    const result = await createFloorPlanModelCandidate({
      workspaceRoot,
      floorPlan: input.floorPlan,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
