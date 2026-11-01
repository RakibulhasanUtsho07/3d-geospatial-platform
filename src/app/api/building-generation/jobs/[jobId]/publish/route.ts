import { NextResponse } from "next/server";

import {
  authorizeGenerationApiRequest,
  getGenerationWorkspaceRoot,
} from "@/core/building-generation/generation-api-auth.mjs";
import { publishApprovedGenerationJob } from "@/core/building-generation/publish-approved-generation-job.mjs";

type RouteContext = { params: Promise<{ jobId: string }> };
const MAX_BODY_BYTES = 16 * 1024;

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/not found/i.test(message)) return 404;
  if (/already in progress|already being published/i.test(message)) return 409;
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  if (/Only completed|approved review|required review check|checksum mismatch|changed after approval|does not match|invalid or does not match|refusing publication/i.test(message)) return 422;
  return 500;
}

export async function POST(request: Request, context: RouteContext) {
  const auth = authorizeGenerationApiRequest(request, process.env, {
    tokenEnvName: "GENERATION_PUBLISH_API_TOKEN",
    serviceName: "Generation publication API",
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
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Publication request exceeds the 16 KiB limit." }, { status: 413 });
  }

  let input: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Publication request exceeds the 16 KiB limit." }, { status: 413 });
    }
    input = JSON.parse(text) as unknown;
  } catch {
    return NextResponse.json({ error: "Publication request must be valid JSON." }, { status: 400 });
  }

  if (!input || typeof input !== "object" || Array.isArray(input) ||
      !("placement" in input) || !input.placement || typeof input.placement !== "object" ||
      Array.isArray(input.placement)) {
    return NextResponse.json({ error: "A placement object is required." }, { status: 400 });
  }

  const { jobId } = await context.params;
  try {
    // Candidate files remain in the private generation workspace. Only the
    // validated content-addressed asset and public catalog are written to the
    // application's public root.
    const result = await publishApprovedGenerationJob({
      workspaceRoot,
      publicRoot: process.cwd(),
      jobId,
      placement: input.placement,
    });

    return NextResponse.json({
      jobId: result.jobId,
      reviewId: result.reviewId,
      modelId: result.modelId,
      versionId: result.versionId,
      assetUrl: result.assetUrl,
      modelSha256: result.modelSha256,
      reportSha256: result.reportSha256,
      placement: result.placement,
      mapReady: false,
      publicationEligible: false,
      note: result.note,
    }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = errorStatus(error);
    const message = status === 400 || status === 404 || status === 409 || status === 422
      ? (error instanceof Error ? error.message : "Publication request was rejected.")
      : "Could not publish the approved generation job.";
    return NextResponse.json({ error: message }, { status });
  }
}
