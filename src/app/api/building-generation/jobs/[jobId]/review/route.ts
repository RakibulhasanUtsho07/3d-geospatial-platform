import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import { reviewGenerationJob } from "@/core/building-generation/generation-job-review.mjs";

type RouteContext = { params: Promise<{ jobId: string }> };
const MAX_REVIEW_BODY_BYTES = 32 * 1024;

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/not found/i.test(message)) return 404;
  if (/already being recorded|immutable|Only completed|changed status/i.test(message)) return 409;
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  if (/requires every review check|checksum mismatch|does not match|reviewable model|must be a structurally plausible/i.test(message)) return 422;
  return 400;
}

export async function POST(request: Request, context: RouteContext) {
  const auth = authorizeGenerationApiRequest(request, process.env, {
    tokenEnvName: "GENERATION_REVIEW_API_TOKEN",
    serviceName: "Generation review API",
  });
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
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REVIEW_BODY_BYTES) {
    return NextResponse.json({ error: "Review request exceeds the 32 KiB limit." }, { status: 413 });
  }

  let input: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_REVIEW_BODY_BYTES) {
      return NextResponse.json({ error: "Review request exceeds the 32 KiB limit." }, { status: 413 });
    }
    input = JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json({ error: "Review request must be valid JSON." }, { status: 400 });
  }

  const { jobId } = await context.params;
  try {
    const result = await reviewGenerationJob({ workspaceRoot, jobId, input });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not record generation review." },
      { status: errorStatus(error) },
    );
  }
}
