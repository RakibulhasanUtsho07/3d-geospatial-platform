import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const guardPath = resolve(
  process.cwd(),
  process.env.P2_13_GUARD_REPORT ?? "test-results/p2-12-cold-warm-regression-guard.json",
);
const browserPath = resolve(
  process.cwd(),
  process.env.P2_13_BROWSER_REPORT ?? "test-results/multi-tile-viewport-workload.json",
);
const outputPath = resolve(
  process.cwd(),
  process.env.P2_13_TREND_REPORT ?? "test-results/p2-13-viewport-performance-trend.json",
);

async function readReport(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("Could not read " + label + " JSON at " + path + ": " + String(error));
  }
  assert.ok(parsed && typeof parsed === "object", label + " must contain a JSON object");
  return parsed;
}

function requireNumber(value, label, minimum = 0) {
  assert.equal(typeof value, "number", label + " must be numeric");
  assert.ok(Number.isFinite(value) && value >= minimum, label + " must be finite and >= " + minimum);
  return value;
}

function requireFlag(value, label) {
  assert.equal(value, true, label + " must be true");
}

function buildTrend(guard, browser) {
  assert.equal(guard.benchmark, "p2.12-cross-process-viewport-regression-guard");
  assert.equal(browser.benchmark, "p2.6-real-multi-tile-viewport-workload");

  for (const field of [
    "sameSpatialTileManifest",
    "sameOrderedFeatureHash",
    "deterministicMetricsMatch",
    "coldIndexReadsVerifiedOnBothProcesses",
    "zeroWarmIndexReadsVerifiedOnBothProcesses",
    "featureBudgetVerifiedOnBothProcesses",
  ]) {
    requireFlag(guard[field], "P2.12 guard." + field);
  }

  const manifestSha256 = guard.evidence?.runA?.spatialTileManifestSha256;
  assert.match(manifestSha256 ?? "", /^[a-f0-9]{64}$/i, "P2.12 evidence must include a SHA-256 manifest hash");
  assert.equal(
    guard.evidence?.runB?.spatialTileManifestSha256,
    manifestSha256,
    "P2.12 process A and B must use the same spatial tile manifest",
  );
  assert.equal(
    browser.dataset?.spatialTileManifestSha256,
    manifestSha256,
    "browser workload and cross-process benchmark must use the same spatial tile manifest",
  );

  const guardSha = guard.candidateSha;
  const browserSha = browser.candidateSha;
  if (guardSha && browserSha) {
    assert.equal(browserSha, guardSha, "browser workload and API benchmarks must describe the same candidate SHA");
  }

  const firstBuilding = browser.readiness?.firstBuilding;
  assert.ok(firstBuilding && typeof firstBuilding === "object", "first-building readiness evidence is required");
  requireNumber(firstBuilding.requestStartToRenderedBuildingStageMs, "request start to building stage (ms)");
  requireNumber(firstBuilding.responseBodyEndToRenderedBuildingStageMs, "response end to building stage (ms)");
  requireNumber(firstBuilding.buildingStageToPostRenderFrameMs, "building stage to postRender frame (ms)");
  requireNumber(firstBuilding.returnedFeatures, "first building stage returned feature count", 1);
  requireNumber(firstBuilding.renderedBuildings, "first building stage rendered building count", 1);
  requireNumber(firstBuilding.postRenderFrameSequence, "first building postRender frame sequence", 0);

  requireFlag(browser.readiness.finalViewportStaged, "browser readiness.finalViewportStaged");
  requireFlag(browser.readiness.staleDelayedResponseNotStaged, "browser readiness.staleDelayedResponseNotStaged");
  requireFlag(browser.readiness.stageToNextPostRenderFrameMs?.allStagesHaveFollowingFrame,
    "every committed building stage must have a following Cesium postRender frame");
  requireFlag(browser.workload?.staleDelayedFetchSignalAborted, "stale delayed viewport cancellation observation");
  requireFlag(browser.workload?.staleDelayedResponseNotStaged, "stale delayed response must not be staged");
  requireFlag(browser.memory?.guardPassed, "browser memory guard");

  const cost = browser.workload?.generatedSpatialTiles?.fetchCostEvidence;
  assert.ok(cost && typeof cost === "object", "browser viewport fetch-cost evidence is required");
  requireNumber(cost.measuredRequestCount, "browser measured fetch-cost request count", 1);
  requireNumber(cost.fullSelectedTilePayloadBaselineBytes, "browser full selected-tile payload baseline bytes", 1);
  requireNumber(cost.indexBytesReadDuringWorkload, "browser index bytes read");
  requireNumber(cost.selectedFeatureGeometryReadBytes, "browser selected feature geometry bytes", 1);
  requireNumber(cost.combinedIndexAndGeometryReadBytes, "browser combined read bytes", 1);
  requireNumber(cost.geometryPayloadReductionRatio, "browser geometry payload reduction ratio");
  requireNumber(cost.combinedReadReductionRatio, "browser combined read reduction ratio");
  assert.equal(cost.geometryFetchBudgetViolations, 0, "browser geometry fetch budget must have no violations");

  for (const [label, report] of [["process A", guard.evidence.runA], ["process B", guard.evidence.runB]]) {
    requireNumber(report.cold?.candidatePayloadBytes, label + " cold candidate payload bytes", 1);
    requireNumber(report.cold?.indexReadBytes, label + " cold index bytes", 1);
    requireNumber(report.cold?.featureReadBytes, label + " cold geometry bytes", 1);
    requireNumber(report.warm?.totalIndexReadBytes, label + " warm index bytes");
    requireNumber(report.warm?.totalGeometryReadBytes, label + " warm geometry bytes");
    requireNumber(report.warm?.meanGeometryPayloadReductionRatio, label + " warm geometry reduction ratio");
  }

  const memory = browser.memory;
  requireNumber(memory.retainedHeapGrowthBytes, "retained JS heap growth bytes", Number.MIN_SAFE_INTEGER);
  requireNumber(memory.domNodeGrowth, "DOM node growth", Number.MIN_SAFE_INTEGER);

  return {
    benchmark: "p2.13-viewport-performance-trend",
    generatedAt: new Date().toISOString(),
    candidateSha: browserSha ?? guardSha ?? null,
    spatialTileManifestSha256: manifestSha256,
    sourceReports: {
      crossProcessGuard: basename(guardPath),
      browserWorkload: basename(browserPath),
    },
    crossProcess: {
      deterministicMetricsMatch: guard.deterministicMetricsMatch,
      sameOrderedFeatureHash: guard.sameOrderedFeatureHash,
      coldIndexReadsVerifiedOnBothProcesses: guard.coldIndexReadsVerifiedOnBothProcesses,
      zeroWarmIndexReadsVerifiedOnBothProcesses: guard.zeroWarmIndexReadsVerifiedOnBothProcesses,
      processA: {
        coldMs: guard.latency?.runA?.coldMs,
        warmMedianMs: guard.latency?.runA?.warmMedianMs,
        warmP95Ms: guard.latency?.runA?.warmP95Ms,
        coldIndexReadBytes: guard.evidence.runA.cold.indexReadBytes,
        coldGeometryReadBytes: guard.evidence.runA.cold.featureReadBytes,
        coldCombinedReadReductionRatio: guard.evidence.runA.cold.combinedReadReductionRatio,
        warmIndexReadBytes: guard.evidence.runA.warm.totalIndexReadBytes,
        warmGeometryReadBytes: guard.evidence.runA.warm.totalGeometryReadBytes,
        warmGeometryPayloadReductionRatio: guard.evidence.runA.warm.meanGeometryPayloadReductionRatio,
      },
      processB: {
        coldMs: guard.latency?.runB?.coldMs,
        warmMedianMs: guard.latency?.runB?.warmMedianMs,
        warmP95Ms: guard.latency?.runB?.warmP95Ms,
        coldIndexReadBytes: guard.evidence.runB.cold.indexReadBytes,
        coldGeometryReadBytes: guard.evidence.runB.cold.featureReadBytes,
        coldCombinedReadReductionRatio: guard.evidence.runB.cold.combinedReadReductionRatio,
        warmIndexReadBytes: guard.evidence.runB.warm.totalIndexReadBytes,
        warmGeometryReadBytes: guard.evidence.runB.warm.totalGeometryReadBytes,
        warmGeometryPayloadReductionRatio: guard.evidence.runB.warm.meanGeometryPayloadReductionRatio,
      },
      latencyDifferencesMs: {
        cold: guard.latency?.coldDifferenceMs,
        warmMedian: guard.latency?.warmMedianDifferenceMs,
      },
    },
    browserWorkload: {
      viewportRequestCount: browser.workload.viewportRequestCount,
      deliveredRequestCount: browser.workload.deliveredRequestCount,
      cancelledRequestCount: browser.workload.browserCancelledRequestCount,
      failedRequestCount: browser.workload.failedRequestCount,
      fetchAbortSignalCount: browser.workload.fetchAbortSignalCount,
      staleDelayedFetchSignalAborted: browser.workload.staleDelayedFetchSignalAborted,
      staleDelayedResponseNotStaged: browser.workload.staleDelayedResponseNotStaged,
      latestViewportStaged: browser.readiness.finalViewportStaged,
      selectedTileLoads: browser.workload.generatedSpatialTiles.totalSelectedTileLoads,
      availableSpatialTileCount: browser.workload.generatedSpatialTiles.availableTileCount,
      fetchCost: {
        measuredRequestCount: cost.measuredRequestCount,
        fullSelectedTilePayloadBaselineBytes: cost.fullSelectedTilePayloadBaselineBytes,
        indexBytesReadDuringWorkload: cost.indexBytesReadDuringWorkload,
        selectedFeatureGeometryReadBytes: cost.selectedFeatureGeometryReadBytes,
        combinedIndexAndGeometryReadBytes: cost.combinedIndexAndGeometryReadBytes,
        geometryPayloadReductionRatio: cost.geometryPayloadReductionRatio,
        combinedReadReductionRatio: cost.combinedReadReductionRatio,
        geometryFetchBudgetViolations: cost.geometryFetchBudgetViolations,
      },
    },
    firstBuildingReadiness: {
      viewportHash: firstBuilding.viewportHash,
      requestStartToRenderedBuildingStageMs: firstBuilding.requestStartToRenderedBuildingStageMs,
      responseBodyEndToRenderedBuildingStageMs: firstBuilding.responseBodyEndToRenderedBuildingStageMs,
      buildingStageToPostRenderFrameMs: firstBuilding.buildingStageToPostRenderFrameMs,
      returnedFeatures: firstBuilding.returnedFeatures,
      renderedBuildings: firstBuilding.renderedBuildings,
      postRenderFrameSequence: firstBuilding.postRenderFrameSequence,
      allStagesHaveFollowingFrame: browser.readiness.stageToNextPostRenderFrameMs.allStagesHaveFollowingFrame,
    },
    memory: {
      measurement: browser.memory.measurement,
      retainedHeapGrowthBytes: memory.retainedHeapGrowthBytes,
      transientPeakGrowthBytes: memory.transientPeakGrowthBytes,
      heapTrendBytesPerMovementSample: memory.heapTrendBytesPerMovementSample,
      domNodeGrowth: memory.domNodeGrowth,
      sampleCount: Array.isArray(memory.samples) ? memory.samples.length : null,
      guardPassed: memory.guardPassed,
    },
    interpretation: {
      scope: "One CI-run snapshot joining the two-process API benchmark with the real multi-tile browser workload.",
      latency: "Cold/warm latency and building readiness timings are recorded for comparison across CI artifacts, not hard-gated against brittle time thresholds.",
      bytes: "Fetch byte counters and whole-tile baseline are application-level metrics, not physical disk I/O.",
      memory: "JS heap and DOM counters exclude GPU/native Cesium allocations and operating-system process memory.",
    },
  };
}

const [guard, browser] = await Promise.all([
  readReport(guardPath, "P2.12 cross-process guard"),
  readReport(browserPath, "multi-tile browser workload"),
]);
const result = buildTrend(guard, browser);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log("[P2.13 viewport performance trend]", JSON.stringify(result));
