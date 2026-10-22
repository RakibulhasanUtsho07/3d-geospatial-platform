import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import { loadFloorPlanRasterLineProposal } from "@/core/building-generation/floor-plan-raster-line-job.mjs";

type RouteContext = { params: Promise<{ buildingId: string; proposalId: string }> };

function errorResponse(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") {
    return NextResponse.json({ error: "Saved raster line proposal was not found." }, { status: 404 });
  }
  if (code === "SOURCE_CHECKSUM_MISMATCH") {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Source integrity check failed." }, { status: 409 });
  }
  if (error instanceof TypeError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof RangeError) {
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  return NextResponse.json({ error: "Could not load the saved raster line proposal." }, { status: 500 });
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

  const { buildingId, proposalId } = await context.params;
  try {
    const result = await loadFloorPlanRasterLineProposal({ workspaceRoot, buildingId, proposalId });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
