import assert from "node:assert/strict";
import test from "node:test";

import { validateRealDhakaBaselineReport } from "../scripts/validate-real-dhaka-baseline.mjs";

const commitSha = "a".repeat(40);
const screenshotSha = "b".repeat(64);
const roadSha = "c".repeat(64);

function createReport() {
  const runs = [];
  for (const mode of ["cold", "warm"]) {
    for (let index = 1; index <= 3; index += 1) {
      const label = mode + "-" + String(index).padStart(2, "0");
      runs.push({
        mode,
        index,
        status: "ok",
        readiness: { canvasCount: 1, viewportStageSuccessCount: 1, stagedFeatureCount: 120 },
        imageryReadiness: { viewerAvailable: true, imageryLayerCount: 1, imageryTilesLoaded: true, stableForMs: 750 },
        imageryTileErrors: { total: 0, recent: [] },
        visualRedPixelSignal: { width: 1280, height: 800, sampledPixels: 150000, redPixelSamples: 240, redPixelRatio: 0.0016 },
        visualAnomalyReview: { flagged: false, threshold: 0.005, peerMedianRatio: 0.0016, reason: "no-red-pixel-outlier-detected" },
        roadReadiness: { status: "rendered", renderedFeatureCount: 28 },
        network: {
          roadApi: {
            pendingRequestsAtCapture: 0,
            detailLevelResponses: { offline: 1 },
            sourceResponses: { "local-extract": 1 },
            upstreamAttempts: { sampleCount: 1, total: 0, max: 0 },
          },
        },
        screenshot: {
          path: "artifacts/real-dhaka-baseline/" + commitSha + "/" + label + ".png",
          bytes: 1024,
          sha256: screenshotSha,
        },
      });
    }
  }
  return {
    schemaVersion: 1,
    benchmark: "real-dhaka-map-performance-baseline",
    candidate: {
      gitCommitSha: commitSha,
      dataInputs: [
        { path: "data/overture/spatial-tiles/manifest.json", exists: true, bytes: 300, sha256: "d".repeat(64) },
        { path: "data/overture/dhaka-buildings-3d-pilot.geojson", exists: true, bytes: 400, sha256: "e".repeat(64) },
        { path: "public/data/roads/dhaka-road-network-v1.json", exists: true, bytes: 500, sha256: roadSha },
      ],
    },
    summary: {
      cold: { totalRuns: 3, successfulRuns: 3, failedRuns: 0, roadReadinessCounts: { rendered: 3 } },
      warm: { totalRuns: 3, successfulRuns: 3, failedRuns: 0, roadReadinessCounts: { rendered: 3 } },
    },
    runs,
  };
}

function screenshotDigests(report, digest = screenshotSha) {
  return Object.fromEntries(report.runs.map((run) => [run.screenshot.path, digest]));
}

test("accepts six cold/warm samples with real building readiness, offline road render and screenshot hashes", () => {
  const report = createReport();
  assert.deepEqual(
    validateRealDhakaBaselineReport(report, { expectedCommitSha: commitSha, screenshotShaByPath: screenshotDigests(report) }),
    [],
  );
});

test("rejects a candidate report generated for another commit", () => {
  const report = createReport();
  const errors = validateRealDhakaBaselineReport(report, {
    expectedCommitSha: "f".repeat(40),
    screenshotShaByPath: screenshotDigests(report),
  });
  assert.ok(errors.some((error) => /candidate SHA/.test(error)));
});

test("rejects missing samples and canvas-only readiness", () => {
  const report = createReport();
  report.runs.pop();
  report.runs[0].readiness.stagedFeatureCount = 0;
  const errors = validateRealDhakaBaselineReport(report, {
    expectedCommitSha: commitSha,
    screenshotShaByPath: screenshotDigests(report),
  });
  assert.ok(errors.some((error) => /Exactly six/.test(error)));
  assert.ok(errors.some((error) => /viewport stage with real building features/.test(error)));
});

test("rejects a fetch success without an actual rendered road layer", () => {
  const report = createReport();
  report.runs[2].roadReadiness = { status: "fetch-error", renderedFeatureCount: 0 };
  report.runs[3].network.roadApi.pendingRequestsAtCapture = 1;
  report.runs[4].network.roadApi.upstreamAttempts.total = 2;
  const errors = validateRealDhakaBaselineReport(report, {
    expectedCommitSha: commitSha,
    screenshotShaByPath: screenshotDigests(report),
  });
  assert.ok(errors.some((error) => /non-empty road layer rendered/.test(error)));
  assert.ok(errors.some((error) => /pending road requests/.test(error)));
  assert.ok(errors.some((error) => /upstream Overpass request/.test(error)));
});

test("requires stable imagery readiness, privacy-safe tile errors, and a canvas anomaly assessment", () => {
  const report = createReport();
  report.runs[0].imageryReadiness.imageryTilesLoaded = false;
  report.runs[1].imageryTileErrors = {
    total: 1,
    recent: [{
      message: "Failed to load https://tile.example/12/123/456.png?token=secret",
      x: 123, y: 456, level: 12, timesRetried: 0, retryWasRequested: false,
    }],
  };
  report.runs[2].visualRedPixelSignal.redPixelRatio = 0.9;
  report.runs[3].visualAnomalyReview = { flagged: "yes", threshold: 0.005, peerMedianRatio: 0.0016, reason: "no-red-pixel-outlier-detected" };

  const errors = validateRealDhakaBaselineReport(report, {
    expectedCommitSha: commitSha,
    screenshotShaByPath: screenshotDigests(report),
  });
  assert.ok(errors.some((error) => /stable Cesium base-imagery readiness/.test(error)));
  assert.ok(errors.some((error) => /non-redacted imagery tile-error details/.test(error)));
  assert.ok(errors.some((error) => /invalid Cesium-canvas red-pixel signal/.test(error)));
  assert.ok(errors.some((error) => /visual-anomaly review assessment/.test(error)));
});

test("preserves flagged red-pixel outliers as review-required rather than declaring them fixed", () => {
  const report = createReport();
  report.runs[0].visualAnomalyReview = {
    flagged: true,
    threshold: 0.005,
    peerMedianRatio: 0.0016,
    reason: "red-pixel-signal-outlier-review-required",
  };
  assert.deepEqual(
    validateRealDhakaBaselineReport(report, {
      expectedCommitSha: commitSha,
      screenshotShaByPath: screenshotDigests(report),
    }),
    [],
  );
});

test("rejects unavailable offline road data and invalid source hashes", () => {
  const report = createReport();
  const roadInput = report.candidate.dataInputs.find((entry) => entry.path === "public/data/roads/dhaka-road-network-v1.json");
  roadInput.exists = false;
  roadInput.bytes = null;
  roadInput.sha256 = null;
  const errors = validateRealDhakaBaselineReport(report, {
    expectedCommitSha: commitSha,
    screenshotShaByPath: screenshotDigests(report),
  });
  assert.ok(errors.some((error) => /Bundled Dhaka road extract must exist/.test(error)));
});

test("requires actual PNG bytes to match each recorded screenshot digest", () => {
  const report = createReport();
  const errors = validateRealDhakaBaselineReport(report, {
    expectedCommitSha: commitSha,
    screenshotShaByPath: screenshotDigests(report, "f".repeat(64)),
  });
  assert.ok(errors.some((error) => /screenshot SHA-256 does not match/.test(error)));
});

test("requires explicit missing markers or complete hashes for optional Overture inputs", () => {
  const report = createReport();
  report.candidate.dataInputs[0] = {
    path: "data/overture/spatial-tiles/manifest.json",
    exists: false,
    bytes: null,
    sha256: null,
  };
  assert.deepEqual(
    validateRealDhakaBaselineReport(report, { expectedCommitSha: commitSha, screenshotShaByPath: screenshotDigests(report) }),
    [],
  );
  report.candidate.dataInputs[0].sha256 = "not-a-hash";
  const errors = validateRealDhakaBaselineReport(report, {
    expectedCommitSha: commitSha,
    screenshotShaByPath: screenshotDigests(report),
  });
  assert.ok(errors.some((error) => /explicit missing-input marker/.test(error)));
});
