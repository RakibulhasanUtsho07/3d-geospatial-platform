import { planGeneration, generateBuildingModel } from "./generation-engine.mjs";
import { runColmapReconstruction } from "./colmap-worker.mjs";
import { runSingleImage3D } from "./single-image-3d-worker.mjs";

function executionReport({requestedStrategy,actualStrategy,worker,workerReport,selectedSourceIds=[],decisionReason,fallbackReason=null}) {
  const report = workerReport ?? {};
  const evidence = report.executionEvidence ?? {};
  const sourceSha256 = actualStrategy === "photogrammetry"
    ? (report.sourceSha256 ?? []).map(source => ({id:source.id,sha256:source.sha256}))
    : actualStrategy === "single-image-ai" && report.source?.sha256
      ? [{id:selectedSourceIds[0],sha256:report.source.sha256}]
      : [];
  const commands = Array.isArray(evidence.commands) ? evidence.commands : [];
  return {
    requestedStrategy,
    actualStrategy,
    worker,
    workerStarted: evidence.workerStarted ?? true,
    workerStatus: report.status ?? "completed-without-worker-status",
    workerExitCode: evidence.workerExitCode ?? evidence.lastExitCode ?? (commands.length ? commands[commands.length-1].exitCode ?? null : null),
    processAdapter: evidence.processAdapter ?? "not-reported",
    workerVersion: evidence.workerVersion ?? "not-queried",
    actualInferenceVerified: evidence.actualInferenceVerified ?? false,
    selectedSourceIds,
    selectedSourceSha256: sourceSha256,
    decisionReason,
    fallbackReason
  };
}

export async function generateBuildingAsset(rawSpec, options = {}) {
  const strategy = options.strategy ?? "auto";
  if (!["auto", "procedural", "photogrammetry", "single-image-ai"].includes(strategy)) {
    throw new TypeError("strategy must be auto, procedural, photogrammetry or single-image-ai");
  }
  const plan = planGeneration(rawSpec);
  const approvedImageIds = new Set(plan.visualReferences.approvedImageSourceIds ?? []);
  const autoPhotogrammetryRequested = strategy === "auto" && options.enablePhotogrammetry === true;
  const shouldRunPhotogrammetry = strategy === "photogrammetry"
    || (autoPhotogrammetryRequested && plan.sourceRoute === "multiview-photogrammetry-candidate");
  const selectedViews = options.reconstruction?.sourceIds;

  if (autoPhotogrammetryRequested && plan.sourceRoute !== "multiview-photogrammetry-candidate") {
    throw new TypeError(
      "strategy=auto has enablePhotogrammetry=true, but the source planner found no eligible set of at least three approved image/video-frame views; refusing silent procedural fallback (route: "
      + plan.sourceRoute + ")"
    );
  }

  if (strategy === "photogrammetry" || autoPhotogrammetryRequested) {
    if (plan.visualReferences.approvedImageCount < 3 || !Array.isArray(selectedViews) || selectedViews.length < 3) {
      throw new TypeError(
        "photogrammetry requires at least three selected, approved image/video-frame sources with known licences; source planner route is "
        + plan.sourceRoute
      );
    }
    if (new Set(selectedViews).size !== selectedViews.length) {
      throw new TypeError("photogrammetry selected sourceIds must be unique");
    }
    const ineligible = selectedViews.filter(id => typeof id !== "string" || !approvedImageIds.has(id));
    if (ineligible.length) {
      throw new TypeError("photogrammetry selected sourceIds are not approved image/video-frame sources in the BuildingSpec: " + ineligible.join(", "));
    }
  }

  if (shouldRunPhotogrammetry) {
    const result = await runColmapReconstruction({
      ...options.reconstruction,
      buildingId: plan.buildingId,
      buildingSpec: rawSpec
    });
    return {
      mode: "photogrammetry",
      plan,
      ...result,
      warning: "This GLB is a reconstructed candidate, not yet registered to ground-control coordinates or approved for public map placement.",
      report: {
        ...(result.report ?? {}),
        strategyExecution: executionReport({
          requestedStrategy: strategy,
          actualStrategy: "photogrammetry",
          worker: "colmap-multiview-worker",
          workerReport: result.report,
          selectedSourceIds: selectedViews,
          decisionReason: strategy === "photogrammetry"
            ? "photogrammetry was explicitly requested and passed source-selection preflight"
            : "auto photogrammetry was explicitly enabled and eligible source views passed preflight"
        })
      }
    };
  }

  if (strategy === "single-image-ai") {
    const sourceId = options.singleImage?.sourceId;
    if (typeof sourceId !== "string" || !sourceId) {
      throw new TypeError("single-image-ai requires singleImage.sourceId");
    }
    if (!approvedImageIds.has(sourceId)) {
      throw new TypeError("single-image-ai sourceId must identify an approved image/video-frame with a known licence in the BuildingSpec");
    }
    const result = await runSingleImage3D({
      ...options.singleImage,
      buildingId: plan.buildingId,
      buildingSpec: rawSpec
    });
    return {
      mode: "single-image-ai",
      plan,
      ...result,
      warning: "This is a single-view mesh output; hidden surfaces, metric scale and WGS84 placement are not proven by the input image.",
      report: {
        ...(result.report ?? {}),
        strategyExecution: executionReport({
          requestedStrategy: strategy,
          actualStrategy: "single-image-ai",
          worker: "single-image-3d-worker",
          workerReport: result.report,
          selectedSourceIds: [sourceId],
          decisionReason: "single-image AI was explicitly requested and its source passed licence/identity preflight"
        })
      }
    };
  }

  const procedural = generateBuildingModel(rawSpec);
  const fallbackReason = strategy !== "auto"
    ? null
    : plan.sourceRoute === "multiview-photogrammetry-candidate"
      ? "auto defaults to procedural; set enablePhotogrammetry=true and supply reviewed sourceIds to run COLMAP"
      : "auto found no eligible multiview candidate; procedural output is the selected default route";
  return {
    mode: "procedural",
    plan,
    ...procedural,
    report: {
      ...procedural.report,
      strategyRequested: strategy,
      photogrammetryCandidateNotRun: plan.sourceRoute === "multiview-photogrammetry-candidate",
      strategyExecution: executionReport({
        requestedStrategy: strategy,
        actualStrategy: "procedural",
        worker: "procedural-glb-generator",
        workerReport: procedural.report,
        selectedSourceIds: [],
        decisionReason: strategy === "procedural" ? "procedural route was explicitly requested" : "auto selected the procedural default",
        fallbackReason
      }),
      warnings: [...new Set([
        ...procedural.report.warnings,
        ...(plan.sourceRoute === "multiview-photogrammetry-candidate" && !shouldRunPhotogrammetry
          ? ["Eligible multi-view sources are present, but photogrammetry was not run. Request strategy=photogrammetry or set enablePhotogrammetry=true under strategy=auto, and explicitly confirm identity, overlap and source up-axis."]
          : [])
      ])]
    }
  };
}
