import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const OUTPUT_DIRECTORY = path.resolve(
  process.env.P2_4_EVIDENCE_DIR ?? "artifacts/p2.4-dhaka-render-performance",
);
const REVIEW_URL = "/experimental/dhaka-3d-tiles-alignment-review.html?view=north";

type MiniReport = {
  tiles?: { runtimeDiagnostics?: { tileLoadCount?: number; tileVisibleCount?: number; tileFailedCount?: number } };
  source?: { sha256?: string };
  fixture?: { tilesetSha256?: string; glbSha256?: string };
};

type RuntimeSample = {
  sampledAt: string;
  jsHeapUsedBytes: number | null;
  jsHeapTotalBytes: number | null;
  jsHeapLimitBytes: number | null;
  resourceCount: number;
  resourceTransferBytes: number;
  resourceEncodedBytes: number;
  cachedResourceCount: number;
  cesiumCanvas: { width: number; height: number; cssWidth: number; cssHeight: number };
  reviewStatus: string | null;
  cesiumVersion: string | null;
  tileLoadCount: number | null;
  tileVisibleCount: number | null;
  tileFailedCount: number | null;
  sourceSha256: string | null;
  tilesetSha256: string | null;
  glbSha256: string | null;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sampleRuntime(page: Page): Promise<RuntimeSample> {
  return page.evaluate(() => {
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    }).memory;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const reportText = document.querySelector("#review-result")?.textContent ?? "";
    let report: MiniReport = {};
    try { report = JSON.parse(reportText) as MiniReport; } catch { /* captured as null in the evidence */ }
    const baselineCanvas = document.querySelector("#baseline-viewer canvas") as HTMLCanvasElement | null;
    const tilesCanvas = document.querySelector("#tiles-viewer canvas") as HTMLCanvasElement | null;
    const canvas = tilesCanvas ?? baselineCanvas;
    const rect = canvas?.getBoundingClientRect();
    return {
      sampledAt: new Date().toISOString(),
      jsHeapUsedBytes: Number.isFinite(memory?.usedJSHeapSize) ? memory!.usedJSHeapSize! : null,
      jsHeapTotalBytes: Number.isFinite(memory?.totalJSHeapSize) ? memory!.totalJSHeapSize! : null,
      jsHeapLimitBytes: Number.isFinite(memory?.jsHeapSizeLimit) ? memory!.jsHeapSizeLimit! : null,
      resourceCount: resources.length,
      resourceTransferBytes: resources.reduce((sum, item) => sum + (item.transferSize || 0), 0),
      resourceEncodedBytes: resources.reduce((sum, item) => sum + (item.encodedBodySize || 0), 0),
      cachedResourceCount: resources.filter((item) => item.transferSize === 0 && item.encodedBodySize > 0).length,
      cesiumCanvas: {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        cssWidth: rect?.width ?? 0,
        cssHeight: rect?.height ?? 0,
      },
      reviewStatus: document.documentElement.getAttribute("data-review-status"),
      cesiumVersion: typeof (window as Window & { Cesium?: { VERSION?: string } }).Cesium?.VERSION === "string"
        ? (window as Window & { Cesium?: { VERSION?: string } }).Cesium?.VERSION ?? null : null,
      tileLoadCount: typeof report.tiles?.runtimeDiagnostics?.tileLoadCount === "number" ? report.tiles.runtimeDiagnostics.tileLoadCount : null,
      tileVisibleCount: typeof report.tiles?.runtimeDiagnostics?.tileVisibleCount === "number" ? report.tiles.runtimeDiagnostics.tileVisibleCount : null,
      tileFailedCount: typeof report.tiles?.runtimeDiagnostics?.tileFailedCount === "number" ? report.tiles.runtimeDiagnostics.tileFailedCount : null,
      sourceSha256: typeof report.source?.sha256 === "string" ? report.source.sha256 : null,
      tilesetSha256: typeof report.fixture?.tilesetSha256 === "string" ? report.fixture.tilesetSha256 : null,
      glbSha256: typeof report.fixture?.glbSha256 === "string" ? report.fixture.glbSha256 : null,
    };
  });
}

async function waitForReady(page: Page): Promise<void> {
  await expect.poll(
    () => page.locator("html").getAttribute("data-review-status"),
    { timeout: 60_000 },
  ).toBe("ready");
  await expect.poll(
    async () => (await sampleRuntime(page)).tileVisibleCount ?? 0,
    { timeout: 15_000 },
  ).toBeGreaterThan(0);
}

test("records cold and warm 3D Tiles render readiness and browser memory", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 950 });

  const run = async (phase: "cold" | "warm", navigate: () => Promise<unknown>) => {
    const started = performance.now();
    await navigate();
    await waitForReady(page);
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const elapsedMs = Number((performance.now() - started).toFixed(3));
    const runtime = await sampleRuntime(page);
    assert.equal(runtime.reviewStatus, "ready", phase + " render must reach the alignment page's ready state");
    assert.ok(runtime.cesiumCanvas.width >= 640 && runtime.cesiumCanvas.height >= 400, phase + " Cesium canvas must have a real viewport");
    assert.ok((runtime.tileLoadCount ?? 0) > 0, phase + " render must load tile content");
    assert.ok((runtime.tileVisibleCount ?? 0) > 0, phase + " render must display tile content");
    assert.equal(runtime.tileFailedCount, 0, phase + " render must not have tile failures");
    assert.match(runtime.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(runtime.tilesetSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.match(runtime.glbSha256 ?? "", /^[a-f0-9]{64}$/);
    return { phase, elapsedMs, runtime };
  };

  const cold = await run("cold", () => page.goto(REVIEW_URL, { waitUntil: "load", timeout: 60_000 }));
  const warm = await run("warm", () => page.reload({ waitUntil: "load", timeout: 60_000 }));

  assert.equal(cold.runtime.sourceSha256, warm.runtime.sourceSha256, "cold/warm runs must use the same source input");
  assert.equal(cold.runtime.tilesetSha256, warm.runtime.tilesetSha256, "cold/warm runs must use the same tileset");
  assert.equal(cold.runtime.glbSha256, warm.runtime.glbSha256, "cold/warm runs must use the same GLB fixture");

  const report = {
    schemaVersion: 1,
    evidenceType: "p2.4-dhaka-3d-tiles-cold-warm-performance",
    status: "pass",
    createdAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    runtime: {
      browserName: "chromium",
      browserVersion: browser.version(),
      userAgent: await page.evaluate(() => navigator.userAgent),
      viewport: { width: 1600, height: 950 },
      renderBackend: "Playwright Chromium with SwiftShader; results are comparative CI measurements, not physical GPU benchmarks",
    },
    methodology: {
      cold: "First navigation in a fresh Playwright page/context for this test; measures navigation start until the page reports ready, tiles are visible, and two extra animation frames pass.",
      warm: "Reload the same page in the same browser context; HTTP cache may be reused. Cesium viewer state is recreated by page reload, so this is a warm-resource-cache render, not an in-memory scene reuse test.",
      memory: "Chromium performance.memory JS heap snapshot only. GPU/driver memory is not exposed by this portable browser harness and is not claimed.",
      caveat: "Timing and JS heap are environment-sensitive; use repeated runs and compare like-for-like CI runners. This report records measurements without an arbitrary pass/fail speed target.",
    },
    inputs: {
      sourceSha256: cold.runtime.sourceSha256,
      tilesetSha256: cold.runtime.tilesetSha256,
      glbSha256: cold.runtime.glbSha256,
    },
    results: { cold, warm },
    comparison: {
      warmVsColdRenderMsRatio: cold.elapsedMs > 0 ? Number((warm.elapsedMs / cold.elapsedMs).toFixed(4)) : null,
      jsHeapUsedDeltaBytes: cold.runtime.jsHeapUsedBytes !== null && warm.runtime.jsHeapUsedBytes !== null
        ? warm.runtime.jsHeapUsedBytes - cold.runtime.jsHeapUsedBytes : null,
      resourceTransferBytesDelta: warm.runtime.resourceTransferBytes - cold.runtime.resourceTransferBytes,
      cachedResourceCountDelta: warm.runtime.cachedResourceCount - cold.runtime.cachedResourceCount,
    },
  };

  const reportPath = path.join(OUTPUT_DIRECTORY, "dhaka-render-performance.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  const reportHash = sha256(await readFile(reportPath));
  await writeFile(
    path.join(OUTPUT_DIRECTORY, "SHA256SUMS.txt"),
    sha256(await readFile(reportPath)) + "  dhaka-render-performance.json\n",
    "utf8",
  );

  console.info("[P2.4] Cold/warm performance evidence captured.", {
    reportPath,
    reportSha256: reportHash,
    coldRenderMs: cold.elapsedMs,
    warmRenderMs: warm.elapsedMs,
    coldJsHeapUsedBytes: cold.runtime.jsHeapUsedBytes,
    warmJsHeapUsedBytes: warm.runtime.jsHeapUsedBytes,
    warmCachedResourceCount: warm.runtime.cachedResourceCount,
  });
});
