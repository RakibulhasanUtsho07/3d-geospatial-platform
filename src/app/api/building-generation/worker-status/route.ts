import { NextResponse } from "next/server";

import {
  authorizeGenerationApiRequest,
  getGenerationWorkspaceRoot,
} from "@/core/building-generation/generation-api-auth.mjs";
import { getGenerationWorkerStatus } from "@/core/building-generation/generation-worker-status.mjs";

export async function GET(request: Request) {
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

  try {
    const status = await getGenerationWorkerStatus({ workspaceRoot });
    return NextResponse.json(status, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Could not read generation worker status." },
      { status: 500 },
    );
  }
}
