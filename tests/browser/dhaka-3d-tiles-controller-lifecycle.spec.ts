import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const REVIEW_URL = "/experimental/dhaka-3d-tiles-controller-lifecycle-review.html";
const OUTPUT_DIRECTORY = path.resolve(
  process.env.P3_6_CONTROLLER_EVIDENCE_DIR ?? "artifacts/p3.6-controller-browser",
);

type LifecycleReport = {
  schemaVersion: number;
  evidenceType: string;
  status: "pass" | "error";
  error?: string;
  runtime?: {
    cesiumVersion: string;
    userAgent: string;
    viewport: { width: number; height: number };
  };
  input?: {
    controllerModuleSha256: string;
    tilesetSha256: string;
    buildManifestSha256: string;
  };
  scenarios?: {
    fallbackAndTeardown: {
      resultStatus: string;
      fallbackUsed: boolean;
      loadedUrl: string;
      fallbackWasReported: boolean;
      primaryFailureObserved: boolean;
      duplicateStatus: string;
      attachedBeforeDisable: boolean;
      primitiveDeltaWhileAttached: number;
      destroyedAfterDisable: boolean;
      primitiveDeltaAfterDisable: number;
      attachedAfterDisable: boolean;
      runtimeFlagResultStatus: string;
    };
    terminalFailure: {
      rejected: boolean;
      errorMessage: string | null;
      errorEventCount: number;
      attached: boolean;
      loading: boolean;
      primitiveDelta: number;
    };
    lateResultAfterDisable: {
      requestStarted: boolean;
      resultStatus: string;
      lateTilesetReturned: boolean;
      lateTilesetDestroyed: boolean;
      attached: boolean;
      loading: boolean;
      primitiveDelta: number;
      staleErrorEventEmitted: boolean;
    };
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

test("live Cesium controller handles fallback, terminal failure and late completion after disable", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto(REVIEW_URL, { waitUntil: "load", timeout: 60_000 });
  assert.equal(response?.status(), 200, "The controller lifecycle browser page must be served.");

  await expect.poll(
    () => page.locator("html").getAttribute("data-review-status"),
    { timeout: 200_000, intervals: [250, 500, 1000, 2000] },
  ).toMatch(/^(ready|error)$/);

  const rawReport = await page.locator("#review-result").textContent();
  assert.ok(rawReport, "The browser did not publish lifecycle evidence.");
  const report = JSON.parse(rawReport) as LifecycleReport;
  assert.equal(report.status, "pass", "Controller lifecycle review failed: " + JSON.stringify(report));
  assert.equal(report.evidenceType, "p3.6-live-cesium-controller-lifecycle");
  assert.equal(report.schemaVersion, 1);
  assert.match(report.input?.controllerModuleSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(report.input?.tilesetSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(report.input?.buildManifestSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok((report.runtime?.viewport.width ?? 0) >= 640);
  assert.ok((report.runtime?.viewport.height ?? 0) >= 400);

  const scenarios = report.scenarios;
  assert.ok(scenarios, "All three browser lifecycle scenarios must be reported.");

  const fallback = scenarios.fallbackAndTeardown;
  assert.equal(fallback.resultStatus, "loaded");
  assert.equal(fallback.fallbackUsed, true);
  assert.equal(fallback.primaryFailureObserved, true);
  assert.equal(fallback.fallbackWasReported, true);
  assert.match(fallback.loadedUrl, /dhaka-3d-tiles-multibuilding-pilot\/tileset\.json$/);
  assert.equal(fallback.duplicateStatus, "already-loaded");
  assert.equal(fallback.attachedBeforeDisable, true);
  assert.equal(fallback.primitiveDeltaWhileAttached, 1);
  assert.equal(fallback.destroyedAfterDisable, true);
  assert.equal(fallback.primitiveDeltaAfterDisable, 0);
  assert.equal(fallback.attachedAfterDisable, false);
  assert.equal(fallback.runtimeFlagResultStatus, "disabled");

  const failure = scenarios.terminalFailure;
  assert.equal(failure.rejected, true);
  assert.ok(failure.errorMessage, "Terminal failure should be returned to the caller.");
  assert.equal(failure.errorEventCount, 1);
  assert.equal(failure.attached, false);
  assert.equal(failure.loading, false);
  assert.equal(failure.primitiveDelta, 0);

  const late = scenarios.lateResultAfterDisable;
  assert.equal(late.requestStarted, true);
  assert.equal(late.resultStatus, "cancelled");
  assert.equal(late.lateTilesetReturned, true);
  assert.equal(late.lateTilesetDestroyed, true);
  assert.equal(late.attached, false);
  assert.equal(late.loading, false);
  assert.equal(late.primitiveDelta, 0);
  assert.equal(late.staleErrorEventEmitted, false);

  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
  assert.equal(pageErrors.length, 0, "Browser page errors were observed: " + pageErrors.join("; "));

  const screenshotName = "controller-lifecycle-review.png";
  const screenshotPath = path.join(OUTPUT_DIRECTORY, screenshotName);
  await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
  const screenshotBytes = await readFile(screenshotPath);
  assert.ok(screenshotBytes.length > 1000, "The evidence screenshot must contain a real browser page.");

  const reportText = JSON.stringify(report, null, 2) + "\n";
  await writeFile(path.join(OUTPUT_DIRECTORY, "controller-lifecycle-review.json"), reportText, "utf8");
  const evidenceManifest = {
    schemaVersion: 1,
    evidenceType: "p3.6-controller-browser-evidence-manifest",
    status: "pass",
    commit: process.env.GITHUB_SHA ?? null,
    browser: {
      name: "Chromium",
      version: browser.version(),
      userAgent: report.runtime?.userAgent ?? null,
      viewport: report.runtime?.viewport ?? null,
      cesiumVersion: report.runtime?.cesiumVersion ?? null,
    },
    inputs: report.input,
    scenarios,
    screenshot: {
      path: screenshotName,
      bytes: screenshotBytes.length,
      sha256: sha256(screenshotBytes),
    },
    report: {
      path: "controller-lifecycle-review.json",
      bytes: Buffer.byteLength(reportText),
      sha256: sha256(reportText),
    },
    limitations: report.limitations,
    releaseFlags: report.releaseFlags,
  };
  await writeFile(
    path.join(OUTPUT_DIRECTORY, "evidence-manifest.json"),
    JSON.stringify(evidenceManifest, null, 2) + "\n",
    "utf8",
  );
});
