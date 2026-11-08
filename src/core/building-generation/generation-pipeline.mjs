import { planGeneration, generateBuildingModel } from "./generation-engine.mjs";
import { runColmapReconstruction } from "./colmap-worker.mjs";
import { runSingleImage3D } from "./single-image-3d-worker.mjs";
import { runTripoTextGeneration } from "./tripo-v3-text-generation.mjs";
import { runTripoImageGeneration } from "./tripo-v3-image-generation.mjs";

export async function generateBuildingAsset(rawSpec, options = {}) {
  const strategy = options.strategy ?? "auto";
  if (!["auto", "procedural", "photogrammetry", "single-image-ai", "tripo-text", "tripo-image"].includes(strategy)) throw new TypeError("strategy must be auto, procedural, photogrammetry, single-image-ai, tripo-text or tripo-image");
  const plan = planGeneration(rawSpec);
  const shouldRunPhotogrammetry = strategy === "photogrammetry" || (strategy === "auto" && options.enablePhotogrammetry === true && plan.sourceRoute === "multiview-photogrammetry-candidate");
  const selectedViews = options.reconstruction?.sourceIds;
  if (strategy === "photogrammetry" && (plan.visualReferences.licenceApproved < 3 || !Array.isArray(selectedViews) || selectedViews.length < 3)) {
    throw new TypeError("photogrammetry strategy requires at least three selected image/video-frame sources with known licences and approved reuse status; source planner route is " + plan.sourceRoute);
  }
  if (shouldRunPhotogrammetry) {
    const result = await runColmapReconstruction({ ...options.reconstruction, buildingId: plan.buildingId, buildingSpec: rawSpec });
    return { mode: "photogrammetry", plan, ...result, warning: "This GLB is a reconstructed candidate, not yet registered to ground-control coordinates or approved for public map placement." };
  }
  if (strategy === "single-image-ai") {
    const result = await runSingleImage3D({ ...options.singleImage, buildingId: plan.buildingId, buildingSpec: rawSpec });
    return { mode: "single-image-ai", plan, ...result, warning: "This is an AI-proposed single-view mesh. Hidden surfaces, metric scale and WGS84 placement are unknown; it is not map-ready." };
  }
  if (strategy === "tripo-image") {
    const result = await runTripoImageGeneration({ ...options.tripoImage, buildingId: plan.buildingId, buildingSpec: rawSpec });
    return { mode: "tripo-image-ai", plan, ...result, warning: "This paid external-provider image/multiview output is an AI-proposed visual candidate; unseen geometry, metric scale, georeference and north alignment remain unverified." };
  }
  if (strategy === "tripo-text") {
    const result = await runTripoTextGeneration({ ...options.tripo, buildingId: plan.buildingId, buildingSpec: rawSpec });
    return { mode: "tripo-text-ai", plan, ...result, warning: "This paid external-provider output is an AI-proposed visual candidate; it is not metric-aligned, georeferenced, accepted or map-ready." };
  }
  const procedural = generateBuildingModel(rawSpec);
  return {
    mode: "procedural", plan, ...procedural,
    report: {
      ...procedural.report,
      strategyRequested: strategy,
      photogrammetryCandidateNotRun: plan.sourceRoute === "multiview-photogrammetry-candidate",
      warnings: [...new Set([
        ...procedural.report.warnings,
        ...(plan.sourceRoute === "multiview-photogrammetry-candidate" && !shouldRunPhotogrammetry
          ? ["Eligible multi-view sources are present, but photogrammetry was not run. Request strategy=photogrammetry and explicitly confirm identity, overlap and source up-axis to run COLMAP."]
          : []),
      ])],
    },
  };
}