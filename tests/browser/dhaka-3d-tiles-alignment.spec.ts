import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const VIEW_IDS = ["north", "east", "south", "west", "oblique"] as const;
const OUTPUT_DIRECTORY = path.resolve(
  process.env.P2_3_EVIDENCE_DIR ?? "artifacts/p2.3-camera-alignment",
);

type ProjectedCorner = {
  id: string;
  baseline: { expected: { x: number; y: number } | null; transformed: { x: number; y: number } | null; residualPixels: number | null };
  tiles: { expected: { x: number; y: number } | null; transformed: { x: number; y: number } | null; residualPixels: number | null };
};

type BrowserReview = {
  schemaVersion: number;
  evidenceType: string;
  status: "pass" | "fail" | "error";
  view: { id: string; requestedCamera: Record<string, number>; target: Record<string, number>; rangeMeters: number };
  source: { sha256: string; featureSha256: string; previewSha256: string | null; featureId: string };
  fixture: { fixtureId: string; tilesetSha256: string; glbSha256: string; syntheticFixtureGeometry: boolean };
  runtime: {
    cesiumVersion: string;
    browserUserAgent: string;
    viewport: {
      baseline: { buffer: { width: number; height: number }; css: { width: number; height: number }; container: { width: number; height: number } };
      tiles: { buffer: { width: number; height: number }; css: { width: number; height: number }; container: { width: number; height: number } };
    };
  };
  baseline: { loaded: boolean; camera: Record<string, number> };
  tiles: {
    loaded: boolean;
    viewReady: boolean;
    readinessStrategy: string;
    runtimeDiagnostics: {
      tileLoadCount: number;
      tileVisibleCount: number;
      tileFailedCount: number;
      tileFailed: Array<{ url: string | null; message: string }>;
    };
    camera: Record<string, number>;
  };
  cameraAlignment: { status: string; maximumAbsolutePoseDelta: number; deltaByField: Record<string, number>; tolerance: number };
  runtimePlacement: { status: string; reference: string; maximumDistanceMeters: number | null; toleranceMeters: number };
  projectedFootprintAlignment: { status: string; tolerancePixels: number; maximumResidualPixels: number | null; visibleProjectionCount: number; corners: ProjectedCorner[] };
  disclaimer: string;
};

type CaptureEntry = {
  viewId: string;
  screenshot: string;
  screenshotSha256: string;
  browserReportSha256: string;
  requestedCamera: Record<string, number>;
  cameraPoseDelta: number;
  tileLoadCount: number;
  visibleTileCount: number;
  tileFailedCount: number;
  runtimePlacementDistanceMeters: number;
  maximumProjectedFootprintResidualPixels: number;
  visibleProjectionCount: number;
  sourceSha256: string;
  sourceFeatureSha256: string;
  sourcePreviewSha256: string | null;
  tilesetSha256: string;
  glbSha256: string;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBrowserReview(page: Page): Promise<BrowserReview> {
  const serialized = await page.locator("#review-result").textContent();
  assert.ok(serialized, "The visual review did not publish its machine-readable result.");
  return JSON.parse(serialized) as BrowserReview;
}

test("captures five repeatable GeoJSON-vs-3D-Tiles camera views with hash-bound evidence", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 950 });

  const manifestPath = path.join(OUTPUT_DIRECTORY, "camera-alignment-review.json");
  const captures: CaptureEntry[] = [];
  const manifest = {
    schemaVersion: 1,
    evidenceType: "p2.3-fixed-camera-geojson-vs-3d-tiles-capture-manifest",
    status: "running" as "running" | "pass" | "fail",
    viewIds: [...VIEW_IDS],
    runtime: {
      browserName: "chromium",
      browserVersion: browser.version(),
      viewport: { width: 1600, height: 950 },
      renderBackend: "Playwright Chromium with SwiftShader configuration from playwright.config.ts",
    },
    comparison: "GeoJSON footprint extrusion and synthetic OGC 3D Tiles GLB fixture rendered in separate Cesium viewers with the same fixed camera preset.",
    tolerances: { cameraPoseAbsoluteDelta: 1e-8, projectedFootprintResidualPixels: 8 },
    captures,
    limitations: [
      "The GLB fixture is a synthetic rectangular prism derived from the source feature bounds.",
      "This verifies runtime load, camera reproducibility, and projected footprint-envelope placement, not facade accuracy, source polygon-shape reconstruction, survey-grade height, or photogrammetric fidelity.",
      "PNG hashes bind the captured evidence to this run; renderer/version differences can legitimately change image hashes across platforms.",
    ],
    failure: null as null | {
      viewId: string;
      pageStatus: string | null;
      browserReview: unknown;
      screenshot: string;
      screenshotSha256: string;
    },
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  for (const viewId of VIEW_IDS) {
    await page.goto("/experimental/dhaka-3d-tiles-alignment-review.html?view=" + viewId, {
      waitUntil: "load",
      timeout: 60_000,
    });
    await expect.poll(
      () => page.locator("html").getAttribute("data-review-status"),
      { timeout: 60_000 },
    ).toMatch(/^(ready|error)$/);

    const pageStatus = await page.locator("html").getAttribute("data-review-status");
    const review = await readBrowserReview(page);
    if (pageStatus !== "ready") {
      const failureScreenshot = "failure-view-" + viewId + ".png";
      const failureScreenshotPath = path.join(OUTPUT_DIRECTORY, failureScreenshot);
      await page.screenshot({ path: failureScreenshotPath, fullPage: false, animations: "disabled" });
      const failureScreenshotBytes = await readFile(failureScreenshotPath);
      manifest.status = "fail";
      manifest.failure = {
        viewId,
        pageStatus,
        browserReview: review,
        screenshot: failureScreenshot,
        screenshotSha256: sha256(failureScreenshotBytes),
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    }
    assert.equal(pageStatus, "ready", "Browser review failed for camera preset " + viewId + ": " + JSON.stringify(review));
    assert.equal(review.status, "pass", "Browser review failed for camera preset " + viewId + ": " + JSON.stringify(review));
    assert.equal(review.evidenceType, "p2.3-fixed-camera-geojson-vs-3d-tiles-render-review");
    assert.equal(review.view.id, viewId);
    for (const [label, viewport] of Object.entries(review.runtime.viewport)) {
      assert.ok(viewport.buffer.width >= 640, label + " Cesium drawing buffer width must match the fixed capture viewport");
      assert.ok(viewport.buffer.height >= 400, label + " Cesium drawing buffer height must match the fixed capture viewport");
      assert.ok(viewport.css.width >= 640, label + " Cesium canvas CSS width must fill its panel");
      assert.ok(viewport.css.height >= 400, label + " Cesium canvas CSS height must fill its panel");
    }
    assert.equal(review.baseline.loaded, true, "GeoJSON baseline was not rendered for " + viewId);
    assert.equal(review.tiles.loaded, true, "3D Tiles fixture was not ready for " + viewId);
    assert.equal(review.tiles.viewReady, true, "The current camera view did not become render-ready for " + viewId);
    assert.equal(review.tiles.readinessStrategy, "postRender-tilesLoaded-two-consecutive-frames");
    assert.ok(review.tiles.runtimeDiagnostics.tileLoadCount > 0, "At least one tile content load must be observed for " + viewId);
    assert.ok(review.tiles.runtimeDiagnostics.tileVisibleCount > 0, "At least one rendered visible tile must be observed for " + viewId);
    assert.equal(review.tiles.runtimeDiagnostics.tileFailedCount, 0, "No tile requests may fail for " + viewId);
    assert.equal(review.cameraAlignment.status, "pass");
    assert.ok(review.cameraAlignment.maximumAbsolutePoseDelta <= 1e-8);
    assert.equal(review.runtimePlacement.status, "pass", "runtime tileset centre must match the fixed target for " + viewId);
    assert.ok(review.runtimePlacement.maximumDistanceMeters !== null);
    assert.ok(review.runtimePlacement.maximumDistanceMeters <= 1);
    assert.equal(review.projectedFootprintAlignment.status, "pass");
    assert.ok(review.projectedFootprintAlignment.maximumResidualPixels !== null);
    assert.ok(review.projectedFootprintAlignment.maximumResidualPixels <= 8);
    assert.equal(review.projectedFootprintAlignment.visibleProjectionCount, 8);
    assert.match(review.source.sha256, /^[a-f0-9]{64}$/);
    assert.match(review.source.featureSha256, /^[a-f0-9]{64}$/);
    assert.match(review.fixture.tilesetSha256, /^[a-f0-9]{64}$/);
    assert.match(review.fixture.glbSha256, /^[a-f0-9]{64}$/);
    assert.equal(review.fixture.syntheticFixtureGeometry, true);

    for (const corner of review.projectedFootprintAlignment.corners) {
      assert.ok(corner.baseline.expected && corner.baseline.transformed, viewId + "/" + corner.id + " baseline corners must project into the frame");
      assert.ok(corner.tiles.expected && corner.tiles.transformed, viewId + "/" + corner.id + " tile corners must project into the frame");
      assert.ok(corner.baseline.residualPixels !== null && corner.baseline.residualPixels <= 8, viewId + "/" + corner.id + " baseline projected residual");
      assert.ok(corner.tiles.residualPixels !== null && corner.tiles.residualPixels <= 8, viewId + "/" + corner.id + " tile projected residual");
    }

    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));

    const screenshotName = "view-" + viewId + ".png";
    const screenshotPath = path.join(OUTPUT_DIRECTORY, screenshotName);
    await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
    const screenshotBytes = await readFile(screenshotPath);
    const entry: CaptureEntry = {
      viewId,
      screenshot: screenshotName,
      screenshotSha256: sha256(screenshotBytes),
      browserReportSha256: sha256(Buffer.from(JSON.stringify(review))),
      requestedCamera: review.view.requestedCamera,
      cameraPoseDelta: review.cameraAlignment.maximumAbsolutePoseDelta,
      tileLoadCount: review.tiles.runtimeDiagnostics.tileLoadCount,
      visibleTileCount: review.tiles.runtimeDiagnostics.tileVisibleCount,
      tileFailedCount: review.tiles.runtimeDiagnostics.tileFailedCount,
      runtimePlacementDistanceMeters: review.runtimePlacement.maximumDistanceMeters!,
      maximumProjectedFootprintResidualPixels: review.projectedFootprintAlignment.maximumResidualPixels!,
      visibleProjectionCount: review.projectedFootprintAlignment.visibleProjectionCount,
      sourceSha256: review.source.sha256,
      sourceFeatureSha256: review.source.featureSha256,
      sourcePreviewSha256: review.source.previewSha256,
      tilesetSha256: review.fixture.tilesetSha256,
      glbSha256: review.fixture.glbSha256,
    };
    captures.push(entry);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }

  assert.deepEqual(captures.map((capture) => capture.viewId), VIEW_IDS);
  assert.equal(new Set(captures.map((capture) => capture.sourceSha256)).size, 1, "source dataset hash must remain fixed across views");
  assert.equal(new Set(captures.map((capture) => capture.tilesetSha256)).size, 1, "tileset hash must remain fixed across views");
  assert.equal(new Set(captures.map((capture) => capture.glbSha256)).size, 1, "GLB hash must remain fixed across views");

  manifest.status = "pass";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.info("[P2.3] Camera alignment evidence captured.", {
    outputDirectory: OUTPUT_DIRECTORY,
    manifestPath,
    views: captures.length,
    maxProjectedResidualPixels: Math.max(...captures.map((capture) => capture.maximumProjectedFootprintResidualPixels)),
    screenshots: captures.map(({ viewId, screenshotSha256 }) => ({ viewId, screenshotSha256 })),
  });
});
