import { GENERATION_WORKER_CAPABILITY_SCHEMA_VERSION, probeGenerationWorkerCapabilities } from "./generation-worker-capabilities.mjs";

export const SINGLE_IMAGE_WORKER_PREFLIGHT_SCHEMA_VERSION = "1.0.0";

export async function runSingleImageWorkerPreflight({
  env = process.env,
  probe = probeGenerationWorkerCapabilities,
  now = new Date(),
  commandTimeoutMs = 10_000,
} = {}) {
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError("now must be a valid timestamp.");
  }
  const checkedAt = timestamp.toISOString();
  const capabilities = await probe({ env, now: checkedAt, commandTimeoutMs, strategies: ["single-image-ai"] });
  const singleImage = capabilities?.strategies?.["single-image-ai"];
  const schemaValid = capabilities?.schemaVersion === GENERATION_WORKER_CAPABILITY_SCHEMA_VERSION;
  const reportedTimestamp = capabilities?.checkedAt;
  const parsedReportedTimestamp = typeof reportedTimestamp === "string"
    ? new Date(reportedTimestamp)
    : null;
  const capabilityTimestampValid = parsedReportedTimestamp !== null &&
    Number.isFinite(parsedReportedTimestamp.getTime()) &&
    parsedReportedTimestamp.toISOString() === reportedTimestamp &&
    reportedTimestamp === checkedAt;
  const rawBlockers = singleImage?.blockers;
  const blockersValid = Array.isArray(rawBlockers) &&
    rawBlockers.every((item) => typeof item === "string" && item.length <= 500);
  const blockers = blockersValid
    ? rawBlockers.filter(Boolean)
    : ["Single-image worker capability result is missing or malformed."];
  if (!schemaValid) blockers.push("Worker capability result has a missing or unsupported schema version.");
  if (!capabilityTimestampValid) blockers.push("Worker capability result timestamp is missing, invalid, non-canonical, or stale.");
  const supportedStatuses = new Set(["ready", "configured", "blocked"]);
  const supportedModelStates = new Set(["cached", "missing", "unknown"]);
  const capabilityStatusValid = supportedStatuses.has(singleImage?.status);
  const tripoModelWeights = supportedModelStates.has(singleImage?.modelWeights)
    ? singleImage.modelWeights
    : "unknown";
  const backgroundRemovalWeights = supportedModelStates.has(singleImage?.backgroundRemovalWeights)
    ? singleImage.backgroundRemovalWeights
    : "unknown";
  if (!capabilityStatusValid) blockers.push("Worker capability result has a missing or unsupported strategy status.");
  if (tripoModelWeights !== singleImage?.modelWeights ||
      backgroundRemovalWeights !== singleImage?.backgroundRemovalWeights) {
    blockers.push("Worker capability result has an unsupported model-cache state.");
  }
  if (tripoModelWeights !== "cached") blockers.push("TripoSR model weights are not verified as cached.");
  if (backgroundRemovalWeights !== "cached") blockers.push("rembg model weights are not verified as cached.");
  const backgroundRemovalModel = typeof singleImage?.backgroundRemovalModel === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(singleImage.backgroundRemovalModel)
    ? singleImage.backgroundRemovalModel
    : null;
  if (backgroundRemovalWeights === "cached" && !backgroundRemovalModel) {
    blockers.push("Cached rembg weights have no verified model identifier.");
  }
  if (capabilityStatusValid && singleImage.status !== "ready" && blockers.length === 0) {
    blockers.push("Single-image worker strategy is not ready.");
  }
  const ready = schemaValid &&
    capabilityTimestampValid &&
    capabilityStatusValid &&
    singleImage?.status === "ready" &&
    tripoModelWeights === "cached" &&
    backgroundRemovalWeights === "cached" &&
    blockers.length === 0;
  return {
    schemaVersion: SINGLE_IMAGE_WORKER_PREFLIGHT_SCHEMA_VERSION,
    checkedAt: capabilityTimestampValid ? reportedTimestamp : checkedAt,
    status: ready ? "ready" : "blocked",
    strategy: "single-image-ai",
    model: {
      tripoModelWeights,
      backgroundRemovalWeights,
      ...(backgroundRemovalModel ? { backgroundRemovalModel } : {}),
    },
    blockers: ready ? [] : blockers.length ? blockers : [
      "TripoSR and rembg model caches must both be verified as cached before a real smoke run.",
    ],
    caveats: [
      "This is a non-inference package, device and local-cache check. It does not invoke a model-download API or execute the configured TripoSR runner.",
      "The configured TripoSR run.py is syntax-compiled in memory but never executed; its --help handler is intentionally not invoked.",
      "Python package imports still execute installed package initialization code and may have package-specific side effects; this is not a hermetic or OS-sandboxed read-only guarantee.",
      "A ready result does not establish model licence compliance, GPU memory sufficiency, building accuracy or map readiness.",
      "Only a fresh D3M-05 smoke followed by independent GLB verification and human inspection can validate an actual inference run.",
    ],
    mapReady: false,
    publicationEligible: false,
    automaticApproval: false,
  };
}
