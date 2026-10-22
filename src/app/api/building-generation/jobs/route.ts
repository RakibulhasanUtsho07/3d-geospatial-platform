import { NextResponse } from "next/server";

import {
  enqueueGenerationJob,
  listGenerationJobs,
} from "@/core/building-generation/generation-job-queue.mjs";
import {
  authorizeGenerationApiRequest,
  getGenerationWorkspaceRoot,
} from "@/core/building-generation/generation-api-auth.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

function authorize(request: Request) {
  const result = authorizeGenerationApiRequest(request);
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

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RangeError("Request body exceeds the 1 MiB limit.");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new RangeError("Request body exceeds the 1 MiB limit.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new TypeError("Request body must be valid JSON.");
  }
}

export async function GET(request: Request) {
  const auth = authorize(request);
  if (auth.response) return auth.response;

  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: "limit must be an integer from 1 to 100." }, { status: 400 });
  }

  try {
    const jobs = await listGenerationJobs({ workspaceRoot: auth.workspaceRoot!, limit });
    return NextResponse.json({ jobs });
  } catch {
    return NextResponse.json({ error: "Could not read generation jobs." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = authorize(request);
  if (auth.response) return auth.response;

  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json." }, { status: 415 });
  }

  let input: unknown;
  try {
    input = await readJsonBody(request);
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request body." },
      { status },
    );
  }

  try {
    const job = await enqueueGenerationJob({
      workspaceRoot: auth.workspaceRoot!,
      input,
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid generation job." },
      { status: 400 },
    );
  }
}
