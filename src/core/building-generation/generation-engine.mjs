import { normalizeBuildingSpec } from "./building-spec.mjs";
import { generateProceduralGlb } from "./procedural-glb.mjs";
const VISUAL = new Set(["image","video","video-frame"]);
export function planGeneration(rawSpec) {
  const {spec}=normalizeBuildingSpec(rawSpec), visual=spec.sources.filter(s=>VISUAL.has(s.kind)), approved=visual.filter(s=>s.licence&&s.licence.toLowerCase()!=="unknown"&&s.usageStatus==="approved"), located=visual.filter(s=>s.location).length;
  const bim=spec.sources.filter(s=>s.kind==="bim"),cad=spec.sources.filter(s=>s.kind==="cad"||s.kind==="floor-plan");
  let sourceRoute="structured-spec";const requiredWorkers=[],warnings=[];
  if(bim.length){sourceRoute="bim-import-candidate";requiredWorkers.push("ifc-or-bim-importer");warnings.push("BIM/IFC sources are recorded, but the repository does not yet parse them into geometry.");}
  else if(cad.length){sourceRoute="cad-or-floor-plan-candidate";requiredWorkers.push("floor-plan-vectorizer-or-cad-importer");warnings.push("CAD/floor-plan parsing is not configured; explicit measurements can still feed the procedural generator.");}
  else if(visual.length>=3&&approved.length>=3){sourceRoute="multiview-photogrammetry-candidate";requiredWorkers.push("colmap-multiview-reconstruction","mesh-quality-and-georeference-review");warnings.push("Multiview references are only a photogrammetry candidate; view overlap, camera calibration, same-building identity and surface quality still need review.");if(located<3)warnings.push("Fewer than three visual sources have capture coordinates; image geometry can still be reconstructed, but precise WGS84 placement needs ground-control registration.");}
  else if(visual.length){sourceRoute="reference-assisted-procedural";warnings.push("The procedural preview uses explicit BuildingSpec values; it does not infer facade geometry from the visual media.");if(approved.length!==visual.length)warnings.push("Some visual references lack a known licence and explicit approved reuse status; do not use them for reconstruction until reviewed.");}
  if(visual.length)warnings.push("The procedural preview does not run image understanding; visual media do not alter geometry unless an explicit reconstruction strategy runs. Video frame extraction, photogrammetry and single-image AI are separate optional routes, and selecting a route does not prove that a reconstruction worker ran successfully.");
  const unknown=spec.evidence.filter(e=>e.confidence==="unknown").map(e=>e.field), estimated=spec.evidence.filter(e=>e.confidence==="estimated"||e.confidence==="ai-proposed").map(e=>e.field);
  if(unknown.length)warnings.push("Unknown properties need research/review: "+[...new Set(unknown)].join(", ")+".");
  if(estimated.length)warnings.push("Estimated or AI-proposed properties need review before they are treated as verified: "+[...new Set(estimated)].join(", ")+".");
  return {buildingId:spec.id,sourceRoute,executableStrategy:"procedural-from-building-spec",generationEngineAvailable:true,additionalWorkersConfigured:false,requiredWorkers,visualReferences:{total:visual.length,licenceApproved:approved.length,withCaptureLocation:located},reviewRequired:warnings.length>0||spec.sources.some(s=>s.usageStatus!=="approved"),warnings,nextAction:requiredWorkers.length?"generate-procedural-preview-and-queue-specialist-route-for-future-implementation":"generate-procedural-preview"};
}
export function generateBuildingModel(rawSpec) {
  const plan=planGeneration(rawSpec), generated=generateProceduralGlb(rawSpec);
  return {...generated,report:{...generated.report,sourceRoute:plan.sourceRoute,strategyPlan:plan,warnings:[...new Set([...plan.warnings,...generated.report.warnings])],reviewRequired:plan.reviewRequired||generated.report.reviewRequired}};
}