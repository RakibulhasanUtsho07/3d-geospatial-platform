import { normalizeBuildingSpec } from "./building-spec.mjs";
import { generateProceduralGlb } from "./procedural-glb.mjs";
const VISUAL = new Set(["image","video","video-frame"]);
export function planGeneration(rawSpec) {
  const {spec}=normalizeBuildingSpec(rawSpec), visual=spec.sources.filter(s=>VISUAL.has(s.kind)), approved=visual.filter(s=>s.licence&&s.usageStatus==="approved"), located=visual.filter(s=>s.location).length;
  const bim=spec.sources.filter(s=>s.kind==="bim"),cad=spec.sources.filter(s=>s.kind==="cad"||s.kind==="floor-plan");
  let sourceRoute="structured-spec";const requiredWorkers=[],warnings=[];
  if(bim.length){sourceRoute="bim-import-candidate";requiredWorkers.push("ifc-or-bim-importer");warnings.push("BIM/IFC sources are recorded, but the repository does not yet parse them into geometry.");}
  else if(cad.length){sourceRoute="cad-or-floor-plan-candidate";requiredWorkers.push("floor-plan-vectorizer-or-cad-importer");warnings.push("CAD/floor-plan parsing is not configured; explicit measurements can still feed the procedural generator.");}
  else if(visual.length>=3&&approved.length>=3&&located>=3){sourceRoute="multiview-photogrammetry-candidate";requiredWorkers.push("media-frame-validation","photogrammetry-worker","mesh-cleanup-and-scale-validation");warnings.push("Multiview references are only a photogrammetry candidate; view overlap, camera calibration and same-building identity still need review.");}
  else if(visual.length){sourceRoute="reference-assisted-procedural";warnings.push("This version does not run image understanding or video-frame extraction; geometry is driven by the validated BuildingSpec.");if(approved.length!==visual.length)warnings.push("Some visual references lack approved reuse status or a recorded licence.");}
  if(visual.length&&!warnings.some(w=>w.includes("does not run image understanding")))warnings.push("This version does not run image understanding or video-frame extraction; visual media remain provenance only.");
  const unknown=spec.evidence.filter(e=>e.confidence==="unknown").map(e=>e.field), estimated=spec.evidence.filter(e=>e.confidence==="estimated"||e.confidence==="ai-proposed").map(e=>e.field);
  if(unknown.length)warnings.push("Unknown properties need research/review: "+[...new Set(unknown)].join(", ")+".");
  if(estimated.length)warnings.push("Estimated or AI-proposed properties need review before they are treated as verified: "+[...new Set(estimated)].join(", ")+".");
  return {buildingId:spec.id,sourceRoute,executableStrategy:"procedural-from-building-spec",generationEngineAvailable:true,additionalWorkersConfigured:false,requiredWorkers,visualReferences:{total:visual.length,licenceApproved:approved.length,withCaptureLocation:located},reviewRequired:warnings.length>0||spec.sources.some(s=>s.usageStatus!=="approved"),warnings,nextAction:requiredWorkers.length?"generate-procedural-preview-and-queue-specialist-route-for-future-implementation":"generate-procedural-preview"};
}
export function generateBuildingModel(rawSpec) {
  const plan=planGeneration(rawSpec), generated=generateProceduralGlb(rawSpec);
  return {...generated,report:{...generated.report,sourceRoute:plan.sourceRoute,strategyPlan:plan,warnings:[...new Set([...plan.warnings,...generated.report.warnings])],reviewRequired:plan.reviewRequired||generated.report.reviewRequired}};
}