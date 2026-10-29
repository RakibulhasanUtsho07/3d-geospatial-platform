import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const REVIEW_URL = "/experimental/dhaka-3d-tiles-multibuilding-review.html";
const OUTPUT_DIRECTORY = path.resolve(
  process.env.P3_6_MULTITILE_EVIDENCE_DIR ?? "artifacts/p3.6-multitile-browser",
);

type MultiTileReview = {
  schemaVersion: number;
  evidenceType: string;
  status: "pass" | "error";
  error?: string;
  runtime?: {
    cesiumVersion: string;
    userAgent: string;
    viewport: { width: number; height: number; cssWidth: number; cssHeight: number };
  };
  input?: {
    sourceSha256: string;
    tilesetSha256: string;
    buildManifestSha256: string;
    contentCount: number;
    hierarchyChildCount: number;
  };
  targetPair?: {
    distanceMeters: number;
    first: { featureId: string; contentUri: string; center: { longitude: number; latitude: number }; cameraAltitudeMeters: number };
    second: { featureId: string; contentUri: string; center: { longitude: number; latitude: number }; cameraAltitudeMeters: number };
  };
  viewportRequests?: {
    firstViewContentUris: string[];
    secondViewNewContentUris: string[];
    cumulativeUniqueContentUris: string[];
    firstViewSelectedSubset: boolean;
    secondViewLoadedNewContent: boolean;
    fullPackageFetched: boolean;
  };
  runtimeDiagnostics?: {
    tileLoadEventCount: number;
    tileVisibleEventCount: number;
    tileFailedCount: number;
    tileFailed: Array<{ url: string | null; message: string }>;
    tilesLoadedAtCapture: boolean;
  };
  limitations?: string[];
  releaseFlags?: {
    acceptanceEligible: false;
    publicationEligible: false;
    mapReady: false;
    automaticApproval: false;
  };
};

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readReview(page: Page): Promise<MultiTileReview> {
  const text = await page.locator("#review-result").textContent();
  assert.ok(text, "The browser review did not publish machine-readable evidence.");
  return JSON.parse(text) as MultiTileReview;
}

test("loads distinct child GLBs across two viewports without eagerly fetching the full package", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 950 });

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto(`${REVIEW_URL}?pauseAfterFirstViewport=1`, { waitUntil: "load", timeout: 60_000 });
  assert.equal(response?.status(), 200, "The experimental multi-tile review page must be served.");

  // Capture a real fixed-camera frame for the initial viewport before the page
  // moves to the second target. The query flag pauses only this review run.
  await expect.poll(
    () => page.locator("html").getAttribute("data-review-stage"),
    { timeout: 120_000, intervals: [250, 500, 1000] },
  ).toMatch(/^(first-view-ready|error)$/);
  const firstStage = await page.locator("html").getAttribute("data-review-stage");
  if (firstStage === "error") {
    const failedReview = await readReview(page);
    throw new Error("Multi-tile browser review failed before first-view capture: " + JSON.stringify(failedReview));
  }

  const firstScreenshotName = "multitile-first-viewport-review.png";
  const firstScreenshotPath = path.join(OUTPUT_DIRECTORY, firstScreenshotName);
  await page.screenshot({ path: firstScreenshotPath, fullPage: false, animations: "disabled" });
  const firstScreenshotBytes = await readFile(firstScreenshotPath);
  assert.ok(firstScreenshotBytes.length > 1000, "The first viewport evidence screenshot should contain a real render.");

  // Resume the same live Cesium session and let it pan to the second target.
  await page.evaluate(() => window.dispatchEvent(new Event("p36-continue-after-first-view")));
  await expect.poll(
    () => page.locator("html").getAttribute("data-review-stage"),
    { timeout: 120_000, intervals: [250, 500, 1000] },
  ).toMatch(/^(second-view-ready|error)$/);

  const review = await readReview(page);
  assert.equal(review.status, "pass", "Multi-tile browser review failed: " + JSON.stringify(review));
  assert.equal(review.evidenceType, "p3.6-live-cesium-multitile-selective-viewport");
  assert.match(review.input?.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(review.input?.tilesetSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(review.input?.buildManifestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok((review.input?.contentCount ?? 0) >= 2, "The source package must have multiple child contents.");
  assert.equal(review.input?.contentCount, review.input?.hierarchyChildCount);
  assert.ok((review.runtime?.viewport.width ?? 0) >= 640);
  assert.ok((review.runtime?.viewport.height ?? 0) >= 400);
  assert.ok((review.runtime?.viewport.cssWidth ?? 0) >= 640);
  assert.ok((review.runtime?.viewport.cssHeight ?? 0) >= 400);

  const requests = review.viewportRequests;
  assert.ok(requests, "The review must report requested content URIs.");
  assert.ok(requests.firstViewContentUris.length > 0, "The first viewport must request at least one child content GLB.");
  assert.ok(requests.firstViewContentUris.length < (review.input?.contentCount ?? 0), "The first viewport must not fetch the full package.");
  assert.ok(requests.firstViewSelectedSubset, "Selective loading must be explicitly reported.");
  const targetPair = review.targetPair;
  assert.ok(targetPair, "The review must report two selected footprint targets.");
  assert.ok(targetPair.distanceMeters >= 20, "The test must pan between separated footprint targets.");
  assert.ok(!requests.firstViewContentUris.includes(targetPair.second.contentUri), "The second target must not be prefetched before the pan.");
  assert.ok(requests.secondViewNewContentUris.includes(targetPair.second.contentUri), "The camera pan must request new content for the second target.");
  assert.ok(requests.secondViewLoadedNewContent, "The second viewport must cause at least one new content request.");
  assert.ok(requests.cumulativeUniqueContentUris.length < (review.input?.contentCount ?? 0), "The two-view sample must remain a subset of package content.");
  assert.equal(requests.fullPackageFetched, false);
  assert.ok((review.runtimeDiagnostics?.tileLoadEventCount ?? 0) > 0, "Cesium must emit tileLoad events.");
  assert.ok((review.runtimeDiagnostics?.tileVisibleEventCount ?? 0) > 0, "Cesium must emit tileVisible events.");
  assert.equal(review.runtimeDiagnostics?.tileFailedCount, 0, "Cesium must not report failed child tiles.");
  assert.equal(review.runtimeDiagnostics?.tilesLoadedAtCapture, true);
  assert.equal(pageErrors.length, 0, "Browser page errors were observed: " + pageErrors.join("; "));
  assert.deepEqual(review.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });

  const screenshotName = "multitile-second-viewport-review.png";
  const screenshotPath = path.join(OUTPUT_DIRECTORY, screenshotName);
  await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
  const screenshotBytes = await readFile(screenshotPath);
  assert.ok(screenshotBytes.length > 1000, "The second viewport evidence screenshot should contain a real render.");

  const reportText = JSON.stringify(review, null, 2) + "\n";
  const reportPath = path.join(OUTPUT_DIRECTORY, "multitile-browser-review.json");
  await writeFile(reportPath, reportText, "utf8");
  const evidenceManifest = {
    schemaVersion: 2,
    evidenceType: "p3.6-multitile-browser-evidence-manifest",
    status: "pass",
    commit: process.env.P3_6_SOURCE_HEAD_SHA ?? process.env.GITHUB_SHA ?? null,
    sourceHeadSha: process.env.P3_6_SOURCE_HEAD_SHA ?? process.env.GITHUB_SHA ?? null,
    workflowSha: process.env.GITHUB_SHA ?? null,
    eventName: process.env.GITHUB_EVENT_NAME ?? null,
    browser: {
      name: "Chromium",
      version: browser.version(),
      userAgent: review.runtime?.userAgent ?? null,
      viewport: { width: 1600, height: 950 },
      cesiumVersion: review.runtime?.cesiumVersion ?? null,
    },
    inputs: review.input,
    selectiveFetch: review.viewportRequests,
    runtimeDiagnostics: review.runtimeDiagnostics,
    screenshots: [
      {
        stage: "first-viewport",
        path: firstScreenshotName,
        bytes: firstScreenshotBytes.length,
        sha256: sha256(firstScreenshotBytes),
      },
      {
        stage: "second-viewport",
        path: screenshotName,
        bytes: screenshotBytes.length,
        sha256: sha256(screenshotBytes),
      },
    ],
    // Retain the previous field name for consumers that only display one frame.
    screenshot: { path: screenshotName, bytes: screenshotBytes.length, sha256: sha256(screenshotBytes) },
    reviewReport: { path: "multitile-browser-review.json", bytes: Buffer.byteLength(reportText), sha256: sha256(reportText) },
    limitations: review.limitations,
    releaseFlags: review.releaseFlags,
  };
  await writeFile(path.join(OUTPUT_DIRECTORY, "evidence-manifest.json"), JSON.stringify(evidenceManifest, null, 2) + "\n", "utf8");
});
