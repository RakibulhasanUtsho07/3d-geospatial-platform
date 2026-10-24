import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const baselinePath = resolve(
  process.cwd(),
  process.env.P2_14_BASELINE_PATH ?? "benchmarks/viewport-performance-baseline-p2-13.json",
);
const currentPath = resolve(
  process.cwd(),
  process.env.P2_14_CURRENT_REPORT ?? "test-results/p2-13-viewport-performance-trend.json",
);
const outputPath = resolve(
  process.cwd(),
  process.env.P2_14_COMPARISON_REPORT ?? "test-results/p2-14-viewport-performance-comparison.json",
);
const MAX_BYTE_MULTIPLIER = Number(process.env.P2_14_MAX_BYTE_MULTIPLIER ?? "1.15");
const MAX_REDUCTION_LOSS = Number(process.env.P2_14_MAX_REDUCTION_LOSS ?? "0.05");

assert.ok(Number.isFinite(MAX_BYTE_MULTIPLIER) && MAX_BYTE_MULTIPLIER >= 1,
  "P2_14_MAX_BYTE_MULTIPLIER must be a finite number >= 1");
assert.ok(Number.isFinite(MAX_REDUCTION_LOSS) && MAX_REDUCTION_LOSS >= 0 && MAX_REDUCTION_LOSS < 1,
  "P2_14_MAX_REDUCTION_LOSS must be in [0, 1)");

async function readJson(path, label) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), label + " must be a JSON object");
    return parsed;
  } catch (error) {
    throw new Error("Could not read " + label + " at " + path + ": " + String(error));
  }
}

function finiteNumber(value, label, { allowNegative = false } = {}) {
  assert.equal(typeof value, "number", label + " must be numeric");
  assert.ok(Number.isFinite(value), label + " must be finite");
  if (!allowNegative) assert.ok(value >= 0, label + " must be nonnegative");
  return value;
}

function requireTrue(value, label) {
  assert.equal(value, true, label + " must be true");
}

function compareByteMetric(name, current, baseline, maximumMultiplier = MAX_BYTE_MULTIPLIER) {
  finiteNumber(current, name + " current", { allowNegative: false });
  finiteNumber(baseline, name + " baseline", { allowNegative: false });
  const maximumAllowed = Number((baseline * maximumMultiplier).toFixed(2));
  const passed = current <= maximumAllowed;
  return {
    name,
    unit: "bytes",
    baseline,
    current,
    delta: current - baseline,
    deltaPercent: baseline === 0 ? null : Number(((current - baseline) / baseline * 100).toFixed(2)),
    maximumAllowed,
    status: passed ? "within-budget" : "regression",
  };
}

function compareReduction(name, current, baseline, maximumLoss = MAX_REDUCTION_LOSS) {
  finiteNumber(current, name + " current");
  finiteNumber(baseline, name + " baseline");
  const minimumAllowed = Number((baseline - maximumLoss).toFixed(4));
  const passed = current >= minimumAllowed;
  return {
    name,
    unit: "ratio",
    baseline,
    current,
    delta: Number((current - baseline).toFixed(4)),
    minimumAllowed,
    status: passed ? "within-budget" : "regression",
  };
}

function compareLatency(name, current, baseline) {
  finiteNumber(current, name + " current");
  finiteNumber(baseline, name + " baseline");
  return {
    name,
    unit: "ms",
    baseline,
    current,
    delta: Number((current - baseline).toFixed(2)),
    deltaPercent: baseline === 0 ? null : Number(((current - baseline) / baseline * 100).toFixed(2)),
    status: "informational-only",
  };
}

const [baseline, current] = await Promise.all([
  readJson(baselinePath, "versioned viewport baseline"),
  readJson(currentPath, "current P2.13 trend report"),
]);
assert.equal(baseline.schemaVersion, 1);
assert.equal(baseline.benchmark, "p2.13-viewport-performance-baseline");
assert.equal(current.benchmark, "p2.13-viewport-performance-trend");

const baselineManifest = baseline.spatialTileManifestSha256;
assert.match(baselineManifest ?? "", /^[a-f0-9]{64}$/i, "baseline must include a SHA-256 manifest hash");
assert.equal(
  current.spatialTileManifestSha256,
  baselineManifest,
  "Cannot compare across a different spatial-tile manifest. Review and explicitly refresh the versioned baseline first.",
);
for (const key of [
  "deterministicMetricsMatch",
  "sameOrderedFeatureHash",
  "coldIndexReadsVerifiedOnBothProcesses",
  "zeroWarmIndexReadsVerifiedOnBothProcesses",
]) requireTrue(current.crossProcess?.[key], "current cross-process." + key);
requireTrue(current.browserWorkload?.staleDelayedFetchSignalAborted, "stale delayed viewport cancellation");
requireTrue(current.browserWorkload?.staleDelayedResponseNotStaged, "stale delayed response staging guard");
requireTrue(current.browserWorkload?.latestViewportStaged, "latest viewport staged");
requireTrue(current.firstBuildingReadiness?.allStagesHaveFollowingFrame, "following Cesium postRender frame guard");
requireTrue(current.memory?.guardPassed, "existing browser memory guard");
assert.equal(current.browserWorkload?.fetchCost?.geometryFetchBudgetViolations, 0,
  "browser geometry fetch budget must have zero violations");

const byteComparisons = [
  compareByteMetric("processA.coldIndexReadBytes", current.crossProcess.processA.coldIndexReadBytes, baseline.crossProcess.processA.coldIndexReadBytes, 1.0),
  compareByteMetric("processB.coldIndexReadBytes", current.crossProcess.processB.coldIndexReadBytes, baseline.crossProcess.processB.coldIndexReadBytes, 1.0),
  compareByteMetric("processA.coldGeometryReadBytes", current.crossProcess.processA.coldGeometryReadBytes, baseline.crossProcess.processA.coldGeometryReadBytes),
  compareByteMetric("processB.coldGeometryReadBytes", current.crossProcess.processB.coldGeometryReadBytes, baseline.crossProcess.processB.coldGeometryReadBytes),
  compareByteMetric("processA.warmGeometryReadBytes", current.crossProcess.processA.warmGeometryReadBytes, baseline.crossProcess.processA.warmGeometryReadBytes),
  compareByteMetric("processB.warmGeometryReadBytes", current.crossProcess.processB.warmGeometryReadBytes, baseline.crossProcess.processB.warmGeometryReadBytes),
  compareByteMetric("browser.fullSelectedTilePayloadBaselineBytes", current.browserWorkload.fetchCost.fullSelectedTilePayloadBaselineBytes, baseline.browserWorkload.fetchCost.fullSelectedTilePayloadBaselineBytes),
  compareByteMetric("browser.selectedFeatureGeometryReadBytes", current.browserWorkload.fetchCost.selectedFeatureGeometryReadBytes, baseline.browserWorkload.fetchCost.selectedFeatureGeometryReadBytes),
];
const reductionComparisons = [
  compareReduction("processA.coldCombinedReadReductionRatio", current.crossProcess.processA.coldCombinedReadReductionRatio, baseline.crossProcess.processA.coldCombinedReadReductionRatio),
  compareReduction("processB.coldCombinedReadReductionRatio", current.crossProcess.processB.coldCombinedReadReductionRatio, baseline.crossProcess.processB.coldCombinedReadReductionRatio),
  compareReduction("browser.geometryPayloadReductionRatio", current.browserWorkload.fetchCost.geometryPayloadReductionRatio, baseline.browserWorkload.fetchCost.geometryPayloadReductionRatio),
  compareReduction("browser.combinedReadReductionRatio", current.browserWorkload.fetchCost.combinedReadReductionRatio, baseline.browserWorkload.fetchCost.combinedReadReductionRatio),
];
const latencyComparisons = [
  compareLatency("processA.coldMs", current.crossProcess.processA.coldMs, baseline.crossProcess.processA.coldMs),
  compareLatency("processA.warmMedianMs", current.crossProcess.processA.warmMedianMs, baseline.crossProcess.processA.warmMedianMs),
  compareLatency("processA.warmP95Ms", current.crossProcess.processA.warmP95Ms, baseline.crossProcess.processA.warmP95Ms),
  compareLatency("processB.coldMs", current.crossProcess.processB.coldMs, baseline.crossProcess.processB.coldMs),
  compareLatency("processB.warmMedianMs", current.crossProcess.processB.warmMedianMs, baseline.crossProcess.processB.warmMedianMs),
  compareLatency("processB.warmP95Ms", current.crossProcess.processB.warmP95Ms, baseline.crossProcess.processB.warmP95Ms),
  compareLatency("firstBuilding.requestStartToStageMs",
    current.firstBuildingReadiness.requestStartToRenderedBuildingStageMs,
    baseline.firstBuildingReadiness.requestStartToRenderedBuildingStageMs),
  compareLatency("firstBuilding.responseEndToStageMs",
    current.firstBuildingReadiness.responseBodyEndToRenderedBuildingStageMs,
    baseline.firstBuildingReadiness.responseBodyEndToRenderedBuildingStageMs),
  compareLatency("firstBuilding.stageToPostRenderMs",
    current.firstBuildingReadiness.buildingStageToPostRenderFrameMs,
    baseline.firstBuildingReadiness.buildingStageToPostRenderFrameMs),
];

const memoryComparisons = {
  retainedHeapGrowthBytes: {
    baseline: baseline.memory.retainedHeapGrowthBytes,
    current: current.memory.retainedHeapGrowthBytes,
    delta: current.memory.retainedHeapGrowthBytes - baseline.memory.retainedHeapGrowthBytes,
    guardPassed: current.memory.guardPassed,
  },
  transientPeakGrowthBytes: {
    baseline: baseline.memory.transientPeakGrowthBytes,
    current: current.memory.transientPeakGrowthBytes,
    delta: current.memory.transientPeakGrowthBytes - baseline.memory.transientPeakGrowthBytes,
  },
  domNodeGrowth: {
    baseline: baseline.memory.domNodeGrowth,
    current: current.memory.domNodeGrowth,
    delta: current.memory.domNodeGrowth - baseline.memory.domNodeGrowth,
  },
  heapTrendBytesPerMovementSample: {
    baseline: baseline.memory.heapTrendBytesPerMovementSample,
    current: current.memory.heapTrendBytesPerMovementSample,
    delta: Number((current.memory.heapTrendBytesPerMovementSample - baseline.memory.heapTrendBytesPerMovementSample).toFixed(2)),
  },
};

const regressions = [...byteComparisons, ...reductionComparisons]
  .filter((item) => item.status === "regression");

const result = {
  benchmark: "p2.14-cross-commit-viewport-performance-comparison",
  generatedAt: new Date().toISOString(),
  candidateSha: current.candidateSha ?? null,
  spatialTileManifestSha256: baselineManifest,
  comparisonStatus: regressions.length === 0 ? "within-budget" : "regression",
  baseline: {
    name: baseline.benchmark,
    capturedAt: baseline.capturedAt,
    workflowRunId: baseline.source.workflowRunId,
    workflowRunUrl: baseline.source.workflowRunUrl,
    sourcePullRequest: baseline.source.sourcePullRequest,
    pullRequestHeadSha: baseline.source.pullRequestHeadSha,
    ciCandidateSha: baseline.source.ciCandidateSha,
  },
  current: {
    report: currentPath.split(/[\\/]/).at(-1),
    candidateSha: current.candidateSha ?? null,
  },
  policy: {
    maximumByteMultiplier: MAX_BYTE_MULTIPLIER,
    maximumReductionRatioLoss: MAX_REDUCTION_LOSS,
    coldIndexReads: "Exact baseline match required while spatial-tile manifest matches.",
    latency: "Informational only; no hard milliseconds threshold.",
    memory: "Existing browser memory guard is required; numeric deltas are informational.",
  },
  byteComparisons,
  reductionComparisons,
  latencyComparisons,
  memoryComparisons,
  invariantChecks: {
    sameManifest: true,
    deterministicCrossProcessMetrics: current.crossProcess.deterministicMetricsMatch,
    sameOrderedFeatureHash: current.crossProcess.sameOrderedFeatureHash,
    coldIndexReadVerifiedOnBothProcesses: current.crossProcess.coldIndexReadsVerifiedOnBothProcesses,
    zeroWarmIndexReadsVerifiedOnBothProcesses: current.crossProcess.zeroWarmIndexReadsVerifiedOnBothProcesses,
    latestViewportStaged: current.browserWorkload.latestViewportStaged,
    staleViewportCancelledAndNotStaged: current.browserWorkload.staleDelayedFetchSignalAborted &&
      current.browserWorkload.staleDelayedResponseNotStaged,
    memoryGuardPassed: current.memory.guardPassed,
  },
  regressions,
  limitations: [
    "The baseline is a versioned snapshot from one successful CI run, not a multi-run statistical distribution.",
    "Latency differences are informational because shared CI runner load and OS caches cause noise.",
    "Application byte counters do not measure physical disk I/O.",
    "JS heap and DOM metrics exclude GPU/native Cesium allocations and operating-system process memory.",
    "If the generated spatial-tile manifest changes, baseline comparison is intentionally blocked until the new dataset is reviewed and a new baseline is explicitly committed.",
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log("[P2.14 cross-commit viewport comparison]", JSON.stringify(result));
if (regressions.length > 0) {
  console.error("[P2.14 regression budget exceeded]", JSON.stringify(regressions));
  process.exitCode = 1;
}
