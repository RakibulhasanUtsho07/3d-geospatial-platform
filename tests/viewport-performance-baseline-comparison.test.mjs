import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = resolve("scripts/compare-viewport-performance-baseline.mjs");
const manifestSha = "9a5c59a08b37c3661a2c31a250c168e7f9d87d200bb0d9b316a4aa1939cd6e63";

function processMetrics() {
  return {
    coldMs: 168.94,
    warmMedianMs: 66.28,
    warmP95Ms: 88.49,
    coldIndexReadBytes: 4442393,
    coldGeometryReadBytes: 2532626,
    coldCombinedReadReductionRatio: 0.2256,
    warmIndexReadBytes: 0,
    warmGeometryReadBytes: 12663130,
    warmGeometryPayloadReductionRatio: 0.7188,
  };
}

function createBaseline() {
  return {
    schemaVersion: 1,
    benchmark: "p2.13-viewport-performance-baseline",
    capturedAt: "2026-10-24T14:55:37.302Z",
    source: { workflowRunId: 123, workflowRunUrl: "https://example.com/run/123", sourcePullRequest: 142, pullRequestHeadSha: "base-sha", ciCandidateSha: "ci-sha" },
    spatialTileManifestSha256: manifestSha,
    crossProcess: {
      deterministicMetricsMatch: true,
      sameOrderedFeatureHash: true,
      coldIndexReadsVerifiedOnBothProcesses: true,
      zeroWarmIndexReadsVerifiedOnBothProcesses: true,
      processA: processMetrics(),
      processB: { ...processMetrics(), coldMs: 171.49, warmMedianMs: 57.96, warmP95Ms: 72.59 },
      latencyDifferencesMs: { cold: 2.55, warmMedian: -8.32 },
    },
    browserWorkload: {
      viewportRequestCount: 11,
      deliveredRequestCount: 10,
      cancelledRequestCount: 1,
      failedRequestCount: 0,
      fetchAbortSignalCount: 1,
      staleDelayedFetchSignalAborted: true,
      staleDelayedResponseNotStaged: true,
      latestViewportStaged: true,
      selectedTileLoads: 8,
      availableSpatialTileCount: 21,
      fetchCost: {
        measuredRequestCount: 11,
        fullSelectedTilePayloadBaselineBytes: 9111152,
        indexBytesReadDuringWorkload: 0,
        selectedFeatureGeometryReadBytes: 2971816,
        combinedIndexAndGeometryReadBytes: 2971816,
        geometryPayloadReductionRatio: 0.6738,
        combinedReadReductionRatio: 0.6738,
        geometryFetchBudgetViolations: 0,
      },
    },
    firstBuildingReadiness: {
      requestStartToRenderedBuildingStageMs: 3299,
      responseBodyEndToRenderedBuildingStageMs: 3070.5,
      buildingStageToPostRenderFrameMs: 535.7,
      returnedFeatures: 3000,
      renderedBuildings: 3000,
      postRenderFrameSequence: 20,
      allStagesHaveFollowingFrame: true,
    },
    memory: {
      retainedHeapGrowthBytes: -551996,
      transientPeakGrowthBytes: 4364576,
      heapTrendBytesPerMovementSample: -618853.57,
      domNodeGrowth: 8,
      sampleCount: 11,
      guardPassed: true,
    },
  };
}

function createCurrent() {
  const p = processMetrics();
  return {
    benchmark: "p2.13-viewport-performance-trend",
    candidateSha: "new-ci-sha",
    spatialTileManifestSha256: manifestSha,
    crossProcess: {
      deterministicMetricsMatch: true,
      sameOrderedFeatureHash: true,
      coldIndexReadsVerifiedOnBothProcesses: true,
      zeroWarmIndexReadsVerifiedOnBothProcesses: true,
      processA: p,
      processB: { ...p, coldMs: 174, warmMedianMs: 62, warmP95Ms: 90 },
      latencyDifferencesMs: { cold: 5.06, warmMedian: -4.28 },
    },
    browserWorkload: {
      viewportRequestCount: 11,
      deliveredRequestCount: 10,
      cancelledRequestCount: 1,
      failedRequestCount: 0,
      fetchAbortSignalCount: 1,
      staleDelayedFetchSignalAborted: true,
      staleDelayedResponseNotStaged: true,
      latestViewportStaged: true,
      selectedTileLoads: 8,
      availableSpatialTileCount: 21,
      fetchCost: {
        measuredRequestCount: 11,
        fullSelectedTilePayloadBaselineBytes: 9111152,
        indexBytesReadDuringWorkload: 0,
        selectedFeatureGeometryReadBytes: 2971816,
        combinedIndexAndGeometryReadBytes: 2971816,
        geometryPayloadReductionRatio: 0.6738,
        combinedReadReductionRatio: 0.6738,
        geometryFetchBudgetViolations: 0,
      },
    },
    firstBuildingReadiness: {
      requestStartToRenderedBuildingStageMs: 3600,
      responseBodyEndToRenderedBuildingStageMs: 3250,
      buildingStageToPostRenderFrameMs: 550,
      returnedFeatures: 3000,
      renderedBuildings: 3000,
      postRenderFrameSequence: 25,
      allStagesHaveFollowingFrame: true,
    },
    memory: {
      retainedHeapGrowthBytes: -500000,
      transientPeakGrowthBytes: 5000000,
      heapTrendBytesPerMovementSample: -200000,
      domNodeGrowth: 9,
      sampleCount: 11,
      guardPassed: true,
    },
  };
}

async function runComparison({ baseline, current, env = {} }) {
  const directory = await mkdtemp(join(tmpdir(), "p2-14-compare-"));
  try {
    const baselinePath = join(directory, "baseline.json");
    const currentPath = join(directory, "current.json");
    const outputPath = join(directory, "comparison.json");
    await writeFile(baselinePath, JSON.stringify(baseline));
    await writeFile(currentPath, JSON.stringify(current));
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        P2_14_BASELINE_PATH: baselinePath,
        P2_14_CURRENT_REPORT: currentPath,
        P2_14_COMPARISON_REPORT: outputPath,
        ...env,
      },
    });
    let output = null;
    try { output = JSON.parse(await readFile(outputPath, "utf8")); } catch {}
    return { result, output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("compares same-dataset metrics and does not fail on noisy latency changes", async () => {
  const { result, output } = await runComparison({ baseline: createBaseline(), current: createCurrent() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.comparisonStatus, "within-budget");
  assert.ok(output.latencyComparisons.every((metric) => metric.status === "informational-only"));
  assert.equal(output.invariantChecks.memoryGuardPassed, true);
});

test("blocks comparison when spatial-tile manifest changed", async () => {
  const current = createCurrent();
  current.spatialTileManifestSha256 = "0".repeat(64);
  const { result } = await runComparison({ baseline: createBaseline(), current });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different spatial-tile manifest/);
});

test("fails and writes a report when byte cost exceeds the regression budget", async () => {
  const current = createCurrent();
  current.browserWorkload.fetchCost.selectedFeatureGeometryReadBytes = 4000000;
  const { result, output } = await runComparison({ baseline: createBaseline(), current });
  assert.notEqual(result.status, 0);
  assert.equal(output.comparisonStatus, "regression");
  assert.ok(output.regressions.some((item) => item.name === "browser.selectedFeatureGeometryReadBytes"));
});

test("requires the existing memory and stale-request guards to pass", async () => {
  const current = createCurrent();
  current.memory.guardPassed = false;
  const { result } = await runComparison({ baseline: createBaseline(), current });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /browser memory guard must be true/);
});
