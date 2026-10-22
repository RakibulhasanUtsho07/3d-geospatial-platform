import { NextResponse } from "next/server";

import { getGenerationJob } from "@/core/building-generation/generation-job-queue.mjs";
import {
  authorizeGenerationApiRequest,
  getGenerationWorkspaceRoot,
} from "@/core/building-generation/generation-api-auth.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = authorizeGenerationApiRequest(request);
  if (!auth.allowed) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = getGenerationWorkspaceRoot();
  } catch {
    return NextResponse.json(
      { error: "Generation workspace is not configured on this server." },
      { status: 503 },
    );
  }

  const { jobId } = await context.params;
  try {
    const job = await getGenerationJob({ workspaceRoot, jobId });
    return NextResponse.json({ job });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return NextResponse.json({ error: "Generation job not found." }, { status: 404 });
    }
    if (error instanceof TypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Could not read generation job." }, { status: 500 });
  }
}
