import { NextResponse } from "next/server";

import { authorizeGenerationApiRequest, getGenerationWorkspaceRoot } from "@/core/building-generation/generation-api-auth.mjs";
import { loadFloorPlanModelCandidate } from "@/core/building-generation/floor-plan-model-job.mjs";

type RouteContext = { params: Promise<{ buildingId: string; candidateId: string }> };

function errorResponse(error: unknown) {
  if (error instanceof TypeError || error instanceof RangeError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "ENOENT") {
    return NextResponse.json({ error: "Floor-plan candidate not found." }, { status: 404 });
  }
  if (code === "CANDIDATE_CHECKSUM_MISMATCH") {
    return NextResponse.json({ error: "Stored candidate integrity check failed." }, { status: 409 });
  }
  return NextResponse.json({ error: "Could not load floor-plan GLB." }, { status: 500 });
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

  const { buildingId, candidateId } = await context.params;
  try {
    const candidate = await loadFloorPlanModelCandidate({ workspaceRoot, buildingId, candidateId });
    const body = new ArrayBuffer(candidate.modelBytes.byteLength);
    new Uint8Array(body).set(candidate.modelBytes);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "model/gltf-binary",
        "Content-Length": String(candidate.modelBytes.byteLength),
        "Content-Disposition": "attachment; filename=\"" + candidate.candidateId + ".glb\"",
        "Cache-Control": "private, no-store",
        "ETag": "\"" + candidate.modelSha256 + "\"",
        "X-Content-Type-Options": "nosniff",
        "X-Map-Ready": "false",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
