import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import {
  getFloorPlanModelReviewStatus,
  reviewFloorPlanModelCandidate,
} from "@/core/building-generation/floor-plan-model-review.mjs";

type RouteContext = { params: Promise<{ buildingId: string; candidateId: string }> };
const MAX_REVIEW_BODY_BYTES = 32 * 1024;

function errorStatus(error: unknown): number {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "ENOENT") return 404;
  if ([
    "REVIEW_ALREADY_RECORDED",
    "REVIEW_IN_PROGRESS",
    "CANDIDATE_CHECKSUM_MISMATCH",
    "REVIEW_NOT_APPROVED_OR_STALE",
    "ATTESTATION_MISMATCH",
    "CANDIDATE_SOURCE_REVIEW_STALE",
    "SOURCE_RIGHTS_CHANGED",
  ].includes(code)) return 409;
  if ([
    "SOURCE_CHECKSUM_MISMATCH",
    "SOURCE_RIGHTS_NOT_APPROVED",
    "REVIEW_EVIDENCE_CHECKSUM_MISMATCH",
    "REVIEW_CHECK_MISSING",
    "PUBLICATION_RECEIPT_MISMATCH",
  ].includes(code)) return 422;
  if (/not found/i.test(message)) return 404;
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  return 400;
}

function authorize(request: Request) {
  const result = authorizeGenerationApiRequest(request, process.env, {
    tokenEnvName: "GENERATION_REVIEW_API_TOKEN",
    serviceName: "Floor-plan review API",
  });
  if (!result.allowed) {
    return {
      response: NextResponse.json({ error: result.error }, { status: result.status }),
      workspaceRoot: null,
    };
  }
  try {
    return { response: null, workspaceRoot: getGenerationWorkspaceRoot() };
  } catch {
    return {
      response: NextResponse.json(
        { error: "Generation workspace is not configured on this server." },
        { status: 503 },
      ),
      workspaceRoot: null,
    };
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REVIEW_BODY_BYTES) {
    throw new RangeError("Review request exceeds the 32 KiB limit.");
  }
  if (!request.body) throw new TypeError("Review request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_REVIEW_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RangeError("Review request exceeds the 32 KiB limit.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new TypeError("Review request must be valid JSON.");
  }
}

export async function GET(request: Request, context: RouteContext) {
  const auth = authorize(request);
  if (auth.response) return auth.response;
  const { buildingId, candidateId } = await context.params;
  try {
    const result = await getFloorPlanModelReviewStatus({
      workspaceRoot: auth.workspaceRoot!,
      buildingId,
      candidateId,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read floor-plan review state." },
      { status: errorStatus(error) },
    );
  }
}

export async function POST(request: Request, context: RouteContext) {
  const auth = authorize(request);
  if (auth.response) return auth.response;
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  let input: unknown;
  try {
    input = await readBoundedJson(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid review request." },
      { status: error instanceof RangeError ? 413 : 400 },
    );
  }

  const { buildingId, candidateId } = await context.params;
  try {
    const result = await reviewFloorPlanModelCandidate({
      workspaceRoot: auth.workspaceRoot!,
      buildingId,
      candidateId,
      input,
    });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not record floor-plan review." },
      { status: errorStatus(error) },
    );
  }
}
