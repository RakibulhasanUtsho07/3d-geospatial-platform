import { planGeneration, generateBuildingModel } from "./generation-engine.mjs";
import { runColmapReconstruction } from "./colmap-worker.mjs";

export async function generateBuildingAsset(rawSpec, options = {}) {
  const strategy = options.strategy ?? "auto";
  if (!["auto", "procedural", "photogrammetry"].includes(strategy)) throw new TypeError("strategy must be auto, procedural or photogrammetry");
  const plan = planGeneration(rawSpec);
  const shouldRunPhotogrammetry = strategy === "photogrammetry" || (strategy === "auto" && options.enablePhotogrammetry === true && plan.sourceRoute === "multiview-photogrammetry-candidate");
  if (strategy === "photogrammetry" && plan.sourceRoute !== "multiview-photogrammetry-candidate") throw new TypeError("photogrammetry strategy requires at least three licence-approved, geolocated visual references; current route is " + plan.sourceRoute);
  if (shouldRunPhotogrammetry) {
    const result = await runColmapReconstruction({ ...options.reconstruction, buildingId: plan.buildingId, buildingSpec: rawSpec });
    return { mode: "photogrammetry", plan, ...result, warning: "This GLB is a reconstructed candidate, not yet registered to ground-control coordinates or approved for public map placement." };
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