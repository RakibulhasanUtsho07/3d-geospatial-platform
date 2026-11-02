import { probeGenerationWorkerCapabilities } from "./generation-worker-capabilities.mjs";

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
  const blockers = Array.isArray(singleImage?.blockers)
    ? singleImage.blockers.filter((item) => typeof item === "string")
    : ["Single-image worker capability result is missing or malformed."];
  const tripoModelWeights = singleImage?.modelWeights ?? "unknown";
  const backgroundRemovalWeights = singleImage?.backgroundRemovalWeights ?? "unknown";
  const ready = singleImage?.status === "ready" &&
    tripoModelWeights === "cached" &&
    backgroundRemovalWeights === "cached" &&
    blockers.length === 0;
  return {
    schemaVersion: SINGLE_IMAGE_WORKER_PREFLIGHT_SCHEMA_VERSION,
    checkedAt: capabilities?.checkedAt ?? checkedAt,
    status: ready ? "ready" : "blocked",
    strategy: "single-image-ai",
    model: {
      tripoModelWeights,
      backgroundRemovalWeights,
      ...(typeof singleImage?.backgroundRemovalModel === "string"
        ? { backgroundRemovalModel: singleImage.backgroundRemovalModel }
        : {}),
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
