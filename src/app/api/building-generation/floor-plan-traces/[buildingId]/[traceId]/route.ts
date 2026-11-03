import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import { loadFloorPlanRasterTrace } from "@/core/building-generation/floor-plan-raster-trace-job.mjs";

type RouteContext = { params: Promise<{ buildingId: string; traceId: string }> };

function statusFor(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") return 404;
  if (code === "SOURCE_CHECKSUM_MISMATCH" || code === "TRACE_CHECKSUM_MISMATCH") return 409;
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  return 500;
}

export async function GET(request: Request, context: RouteContext) {
  const auth = authorizeGenerationApiRequest(request);
  if (!auth.allowed) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let workspaceRoot: string;
  try {
    workspaceRoot = getGenerationWorkspaceRoot();
  } catch {
    return NextResponse.json({ error: "Generation workspace is not configured on this server." }, { status: 503 });
  }

  const { buildingId, traceId } = await context.params;
  try {
    const trace = await loadFloorPlanRasterTrace({ workspaceRoot, buildingId, traceId });
    return NextResponse.json(trace, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load floor-plan trace." },
      { status: statusFor(error) },
    );
  }
}
