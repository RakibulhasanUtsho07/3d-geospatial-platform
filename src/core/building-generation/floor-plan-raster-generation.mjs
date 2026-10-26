import { loadFloorPlanRasterTrace } from "./floor-plan-raster-trace-job.mjs";
import { convertFloorPlanTraceToVectorPlan } from "./floor-plan-trace-to-vector.mjs";
import { createFloorPlanModelCandidate } from "./floor-plan-model-job.mjs";

export async function generateFloorPlanCandidateFromRasterTrace({
  workspaceRoot,
  buildingId,
  traceId,
  conversion,
}) {
  const trace = await loadFloorPlanRasterTrace({ workspaceRoot, buildingId, traceId });
  if (trace.traceId !== traceId || trace.buildingId !== buildingId) {
    throw new TypeError("Loaded trace identity does not match the requested building and trace.");
  }
  const converted = convertFloorPlanTraceToVectorPlan({
    ...conversion,
    trace,
  });
  const candidate = await createFloorPlanModelCandidate({
    workspaceRoot,
    floorPlan: converted.floorPlan,
    traceEvidence: {
      traceId: trace.traceId,
      traceSha256: trace.artifactSha256,
      transformation: converted.transformation,
    },
  });
  return {
    ...candidate,
    traceId: trace.traceId,
    traceSha256: trace.artifactSha256,
    transformationAudit: converted.transformation,
  };
}
