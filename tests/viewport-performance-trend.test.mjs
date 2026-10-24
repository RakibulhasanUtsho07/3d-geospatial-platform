import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = resolve("scripts/build-viewport-performance-trend.mjs");
const manifestSha = "9a5c59a08b37c3661a2c31a250c168e7f9d87d200bb0d9b316a4aa1939cd6e63";

function createGuard() {
  const cold = {
    candidatePayloadBytes: 9007328,
    indexReadBytes: 4442393,
    featureReadBytes: 2532626,
    combinedReadReductionRatio: 0.2256,
  };
  const warm = {
    totalIndexReadBytes: 0,
    totalGeometryReadBytes: 12663130,
    meanGeometryPayloadReductionRatio: 0.7188,
  };
  return {
    benchmark: "p2.12-cross-process-viewport-regression-guard",
    candidateSha: "test-sha",
    sameSpatialTileManifest: true,
    sameOrderedFeatureHash: true,
    deterministicMetricsMatch: true,
    coldIndexReadsVerifiedOnBothProcesses: true,
    zeroWarmIndexReadsVerifiedOnBothProcesses: true,
    featureBudgetVerifiedOnBothProcesses: true,
    latency: {
      runA: { coldMs: 155, warmMedianMs: 60, warmP95Ms: 80 },
      runB: { coldMs: 165, warmMedianMs: 65, warmP95Ms: 82 },
      coldDifferenceMs: 10,
      warmMedianDifferenceMs: 5,
    },
    evidence: {
      runA: { spatialTileManifestSha256: manifestSha, cold, warm },
      runB: { spatialTileManifestSha256: manifestSha, cold, warm },
    },
  };
}

function createBrowser() {
  return {
    benchmark: "p2.6-real-multi-tile-viewport-workload",
    candidateSha: "test-sha",
    dataset: { spatialTileManifestSha256: manifestSha },
    workload: {
      viewportRequestCount: 10,
      deliveredRequestCount: 9,
      browserCancelledRequestCount: 1,
      failedRequestCount: 0,
      fetchAbortSignalCount: 1,
      staleDelayedFetchSignalAborted: true,
      staleDelayedResponseNotStaged: true,
      generatedSpatialTiles: {
        totalSelectedTileLoads: 32,
        availableTileCount: 47,
        fetchCostEvidence: {
          measuredRequestCount: 9,
          fullSelectedTilePayloadBaselineBytes: 9000000,
          indexBytesReadDuringWorkload: 0,
          selectedFeatureGeometryReadBytes: 2500000,
          combinedIndexAndGeometryReadBytes: 2500000,
          geometryPayloadReductionRatio: 0.72,
          combinedReadReductionRatio: 0.72,
          geometryFetchBudgetViolations: 0,
        },
      },
    },
    readiness: {
      firstBuilding: {
        viewportHash: "abc123",
        requestStartToRenderedBuildingStageMs: 3300,
        responseBodyEndToRenderedBuildingStageMs: 3050,
        buildingStageToPostRenderFrameMs: 500,
        returnedFeatures: 2500,
        renderedBuildings: 3000,
        postRenderFrameSequence: 12,
      },
      finalViewportStaged: true,
      staleDelayedResponseNotStaged: true,
      stageToNextPostRenderFrameMs: { allStagesHaveFollowingFrame: true },
    },
    memory: {
      measurement: "Chromium CDP JS heap and DOM counters",
      retainedHeapGrowthBytes: -1000,
      observedHeapPeakBytes: 12000000,
      transientPeakGrowthBytes: 2000,
      heapTrendBytesPerMovementSample: -100,
      domNodeGrowth: 4,
      samples: [{}, {}, {}, {}, {}],
      guardPassed: true,
    },
  };
}

async function runBuilder({ guard, browser }) {
  const directory = await mkdtemp(join(tmpdir(), "p2-13-trend-"));
  try {
    const guardPath = join(directory, "guard.json");
    const browserPath = join(directory, "browser.json");
    const outputPath = join(directory, "trend.json");
    await writeFile(guardPath, JSON.stringify(guard));
    await writeFile(browserPath, JSON.stringify(browser));
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        P2_13_GUARD_REPORT: guardPath,
        P2_13_BROWSER_REPORT: browserPath,
        P2_13_TREND_REPORT: outputPath,
      },
    });
    const output = result.status === 0 ? JSON.parse(await readFile(outputPath, "utf8")) : null;
    return { result, output };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("builds a joined trend snapshot when API and browser evidence match", async () => {
  const { result, output } = await runBuilder({ guard: createGuard(), browser: createBrowser() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.benchmark, "p2.13-viewport-performance-trend");
  assert.equal(output.spatialTileManifestSha256, manifestSha);
  assert.equal(output.crossProcess.processA.coldIndexReadBytes, 4442393);
  assert.equal(output.crossProcess.processA.warmIndexReadBytes, 0);
  assert.equal(output.firstBuildingReadiness.renderedBuildings, 3000);
  assert.equal(output.memory.guardPassed, true);
});

test("rejects trend evidence generated from different tile manifests", async () => {
  const browser = createBrowser();
  browser.dataset.spatialTileManifestSha256 = "0".repeat(64);
  const { result } = await runBuilder({ guard: createGuard(), browser });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /same spatial tile manifest/);
});

test("rejects a browser run that did not stage the final viewport", async () => {
  const browser = createBrowser();
  browser.readiness.finalViewportStaged = false;
  const { result } = await runBuilder({ guard: createGuard(), browser });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /browser readiness.finalViewportStaged/);
});
