import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import {
  parseTrustedReconstructionReviewerKeys,
  prepareSourceBoundGeometryReview,
  recordSourceBoundAuthenticatedReview,
} from "@/core/building-generation/source-bound-authenticated-review.mjs";

type RouteContext = {
  params: Promise<{ buildingId: string; handoffJobId: string }>;
};
const MAX_REVIEW_BODY_BYTES = 64 * 1024;

function authorize(request: Request) {
  const result = authorizeGenerationApiRequest(request, process.env, {
    tokenEnvName: "GENERATION_EVIDENCE_REVIEW_API_TOKEN",
    serviceName: "Source-bound reconstruction evidence review API",
  });
  if (!result.allowed) {
    return {
      response: NextResponse.json({ error: result.error }, { status: result.status }),
      workspaceRoot: null,
      reviewerKeys: null,
    };
  }

  const registry = process.env.RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON;
  if (!registry?.trim()) {
    return {
      response: NextResponse.json(
        { error: "Trusted reconstruction reviewer keys are not configured." },
        { status: 503 },
      ),
      workspaceRoot: null,
      reviewerKeys: null,
    };
  }

  let workspaceRoot: string;
  let reviewerKeys;
  try {
    workspaceRoot = getGenerationWorkspaceRoot();
    reviewerKeys = parseTrustedReconstructionReviewerKeys(registry);
  } catch (error) {
    return {
      response: NextResponse.json(
        { error: error instanceof Error ? error.message : "Review service configuration is invalid." },
        { status: 503 },
      ),
      workspaceRoot: null,
      reviewerKeys: null,
    };
  }
  return { response: null, workspaceRoot, reviewerKeys };
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REVIEW_BODY_BYTES) {
    throw new RangeError("Review request exceeds the 64 KiB limit.");
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
        throw new RangeError("Review request exceeds the 64 KiB limit.");
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

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/not found|does not exist/i.test(message)) return 404;
  if (/already being recorded|immutable|already exists|different source\/config/i.test(message)) return 409;
  if (/continue-to-independent-validation requires|is blocked because|signature is invalid|must bind the exact/i.test(message)) return 422;
  if (error instanceof RangeError) return 413;
  if (error instanceof TypeError) return 400;
  return 422;
}

/** Returns the exact candidate-bound geometry QA report and unsigned review template. */
export async function GET(request: Request, context: RouteContext) {
  const auth = authorize(request);
  if (auth.response) return auth.response;
  const { buildingId, handoffJobId } = await context.params;
  try {
    const result = await prepareSourceBoundGeometryReview({
      workspaceRoot: auth.workspaceRoot!,
      buildingId,
      handoffJobId,
    });
    return NextResponse.json({
      handoffJobId: result.handoffJobId,
      handoffArtifactSha256: result.handoffArtifactSha256,
      candidateSha256: result.candidateSha256,
      candidateByteLength: result.candidateByteLength,
      geometryReport: result.geometryReport,
      geometryReportSha256: result.geometryReportSha256,
      submissionTemplate: result.submissionTemplate,
      signingInstructions: result.signingInstructions,
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not prepare candidate geometry review." },
      { status: errorStatus(error), headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

/** Records only a payload signed by a key in the server-controlled reviewer registry. */
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

  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["submission", "signatureBase64"].includes(key)) ||
      typeof (input as { signatureBase64?: unknown }).signatureBase64 !== "string" ||
      !("submission" in input)) {
    return NextResponse.json({
      error: "Request must contain only submission and signatureBase64. Trusted public keys are server-configured and must not be sent by the caller.",
    }, { status: 400 });
  }

  const { buildingId, handoffJobId } = await context.params;
  try {
    const result = await recordSourceBoundAuthenticatedReview({
      workspaceRoot: auth.workspaceRoot!,
      buildingId,
      handoffJobId,
      submission: (input as { submission: unknown }).submission,
      signatureBase64: (input as { signatureBase64: string }).signatureBase64,
      trustedReviewerKeys: auth.reviewerKeys!,
    });
    return NextResponse.json({
      reviewJobId: result.reviewJobId,
      decision: result.decision,
      signatureVerified: result.signatureVerified,
      reviewerId: result.reviewerId,
      reviewerPublicKeyFingerprintSha256: result.reviewerPublicKeyFingerprintSha256,
      geometryReportSha256: result.geometryReportSha256,
      reused: result.reused,
      decisionRecord: result.decisionRecord,
      policy: result.decisionRecord.policy,
    }, {
      status: result.reused ? 200 : 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not record authenticated reconstruction review." },
      { status: errorStatus(error), headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
