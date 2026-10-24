import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const SAMPLE_COUNT = 5;
const OUTPUT_DIRECTORY = path.resolve(
  process.env.P2_5_EVIDENCE_DIR ?? "artifacts/p2.5-dhaka-performance-repeatability",
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
  canvas: { width: number; height: number; cssWidth: number; cssHeight: number };
  cesiumVersion: string | null;
  tileLoadCount: number | null;
  tileVisibleCount: number | null;
  tileFailedCount: number | null;
  sourceSha256: string | null;
  tilesetSha256: string | null;
  glbSha256: string | null;
};

type PhaseResult = { phase: "cold" | "warm"; elapsedMs: number; runtime: RuntimeSample };
type PairedSample = {
  iteration: number;
  cold: PhaseResult;
  warm: PhaseResult;
  warmVsColdMsRatio: number | null;
  warmResourceTransferReductionPct: number | null;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return Number(sorted[lower].toFixed(3));
  const fraction = position - lower;
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * fraction).toFixed(3));
}

function summarize(values: number[]) {
  return {
    count: values.length,
    min: percentile(values, 0),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: percentile(values, 1),
  };
}

async function sampleRuntime(page: Page): Promise<RuntimeSample> {
  return page.evaluate(() => {
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
    }).memory;
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const reportText = document.querySelector("#review-result")?.textContent ?? "";
    let report: MiniReport = {};
    try { report = JSON.parse(reportText) as MiniReport; } catch { /* validation below reports absent evidence */ }
    const canvas = document.querySelector("#tiles-viewer canvas") as HTMLCanvasElement | null;
    const rect = canvas?.getBoundingClientRect();
    const cesiumVersion = (window as Window & { Cesium?: { VERSION?: string } }).Cesium?.VERSION;
    return {
      sampledAt: new Date().toISOString(),
      jsHeapUsedBytes: typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null,
      jsHeapTotalBytes: typeof memory?.totalJSHeapSize === "number" ? memory.totalJSHeapSize : null,
      jsHeapLimitBytes: typeof memory?.jsHeapSizeLimit === "number" ? memory.jsHeapSizeLimit : null,
      resourceCount: resources.length,
      resourceTransferBytes: resources.reduce((sum, item) => sum + (item.transferSize || 0), 0),
      resourceEncodedBytes: resources.reduce((sum, item) => sum + (item.encodedBodySize || 0), 0),
      cachedResourceCount: resources.filter((item) => item.transferSize === 0 && item.encodedBodySize > 0).length,
      canvas: {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        cssWidth: rect?.width ?? 0,
        cssHeight: rect?.height ?? 0,
      },
      cesiumVersion: typeof cesiumVersion === "string" ? cesiumVersion : null,
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

test("aggregates five isolated cold/warm 3D Tiles render pairs", async ({ browser }) => {
  test.setTimeout(300_000);
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const samples: PairedSample[] = [];

  for (let iteration = 1; iteration <= SAMPLE_COUNT; iteration += 1) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    try {
      const page = await context.newPage();
      const measure = async (phase: "cold" | "warm", navigate: () => Promise<unknown>): Promise<PhaseResult> => {
        const started = performance.now();
        await navigate();
        await waitForReady(page);
        await page.evaluate(() => new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        const elapsedMs = Number((performance.now() - started).toFixed(3));
        const runtime = await sampleRuntime(page);
        assert.ok(runtime.canvas.width >= 640 && runtime.canvas.height >= 400, phase + " canvas drawing buffer must be valid");
        assert.ok(runtime.canvas.cssWidth >= 640 && runtime.canvas.cssHeight >= 400, phase + " canvas CSS viewport must be valid");
        assert.ok((runtime.tileLoadCount ?? 0) > 0, phase + " must load tile content");
        assert.ok((runtime.tileVisibleCount ?? 0) > 0, phase + " must show tile content");
        assert.equal(runtime.tileFailedCount, 0, phase + " must not have tile failures");
        assert.match(runtime.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
        assert.match(runtime.tilesetSha256 ?? "", /^[a-f0-9]{64}$/);
        assert.match(runtime.glbSha256 ?? "", /^[a-f0-9]{64}$/);
        return { phase, elapsedMs, runtime };
      };

      const cold = await measure("cold", () => page.goto(REVIEW_URL, { waitUntil: "load", timeout: 60_000 }));
      const warm = await measure("warm", () => page.reload({ waitUntil: "load", timeout: 60_000 }));

      assert.equal(cold.runtime.sourceSha256, warm.runtime.sourceSha256, "cold/warm source hash must match");
      assert.equal(cold.runtime.tilesetSha256, warm.runtime.tilesetSha256, "cold/warm tileset hash must match");
      assert.equal(cold.runtime.glbSha256, warm.runtime.glbSha256, "cold/warm GLB hash must match");

      samples.push({
        iteration,
        cold,
        warm,
        warmVsColdMsRatio: cold.elapsedMs > 0 ? Number((warm.elapsedMs / cold.elapsedMs).toFixed(4)) : null,
        warmResourceTransferReductionPct: cold.runtime.resourceTransferBytes > 0
          ? Number(((cold.runtime.resourceTransferBytes - warm.runtime.resourceTransferBytes) / cold.runtime.resourceTransferBytes * 100).toFixed(2))
          : null,
      });
    } finally {
      await context.close();
    }
  }

  const allPhases = samples.flatMap((sample) => [sample.cold, sample.warm]);
  const inputValues = {
    sourceSha256: new Set(allPhases.map((phase) => phase.runtime.sourceSha256)),
    tilesetSha256: new Set(allPhases.map((phase) => phase.runtime.tilesetSha256)),
    glbSha256: new Set(allPhases.map((phase) => phase.runtime.glbSha256)),
  };
  assert.equal(inputValues.sourceSha256.size, 1, "source dataset hash must remain fixed for all repetitions");
  assert.equal(inputValues.tilesetSha256.size, 1, "tileset hash must remain fixed for all repetitions");
  assert.equal(inputValues.glbSha256.size, 1, "GLB hash must remain fixed for all repetitions");

  const coldTimes = samples.map((sample) => sample.cold.elapsedMs);
  const warmTimes = samples.map((sample) => sample.warm.elapsedMs);
  const coldTransfer = samples.map((sample) => sample.cold.runtime.resourceTransferBytes);
  const warmTransfer = samples.map((sample) => sample.warm.runtime.resourceTransferBytes);
  const coldHeap = samples.map((sample) => sample.cold.runtime.jsHeapUsedBytes).filter((value): value is number => value !== null);
  const warmHeap = samples.map((sample) => sample.warm.runtime.jsHeapUsedBytes).filter((value): value is number => value !== null);

  const report = {
    schemaVersion: 1,
    evidenceType: "p2.5-dhaka-3d-tiles-performance-repeatability",
    status: "pass",
    createdAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    sampleCount: SAMPLE_COUNT,
    runtime: {
      browserName: "chromium",
      browserVersion: browser.version(),
      viewport: { width: 1600, height: 950 },
      renderBackend: "Playwright Chromium with SwiftShader; comparative CI data only",
      cesiumVersion: samples[0]?.cold.runtime.cesiumVersion ?? null,
    },
    methodology: {
      cold: "First navigation in a newly created isolated browser context. Each iteration gets a fresh context and therefore an isolated browser resource cache.",
      warm: "Reload within that same iteration's context; HTTP cache may be reused while the Cesium scene is reconstructed.",
      samples: SAMPLE_COUNT,
      aggregation: "Median and P95 use linear interpolation over sorted samples. Raw measurements remain in the report.",
      memory: "Chromium performance.memory JS heap only when exposed; GPU/driver memory is not measured.",
      policy: "No timing pass/fail budget is imposed until repeated measurements from like-for-like runners establish stable variance.",
    },
    inputs: {
      sourceSha256: samples[0]?.cold.runtime.sourceSha256 ?? null,
      tilesetSha256: samples[0]?.cold.runtime.tilesetSha256 ?? null,
      glbSha256: samples[0]?.cold.runtime.glbSha256 ?? null,
    },
    samples,
    summary: {
      coldRenderMs: summarize(coldTimes),
      warmRenderMs: summarize(warmTimes),
      coldResourceTransferBytes: summarize(coldTransfer),
      warmResourceTransferBytes: summarize(warmTransfer),
      coldJsHeapUsedBytes: summarize(coldHeap),
      warmJsHeapUsedBytes: summarize(warmHeap),
      pairedWarmVsColdRatio: summarize(samples.map((sample) => sample.warmVsColdMsRatio).filter((value): value is number => value !== null)),
      medianWarmImprovementPercent: (() => {
        const coldMedian = percentile(coldTimes, 0.5);
        const warmMedian = percentile(warmTimes, 0.5);
        return coldMedian !== null && warmMedian !== null && coldMedian > 0
          ? Number(((coldMedian - warmMedian) / coldMedian * 100).toFixed(2)) : null;
      })(),
      medianResourceTransferReductionPercent: percentile(samples.map((sample) => sample.warmResourceTransferReductionPct).filter((value): value is number => value !== null), 0.5),
    },
  };

  const reportPath = path.join(OUTPUT_DIRECTORY, "dhaka-render-performance-repeatability.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  const reportBytes = await readFile(reportPath);
  await writeFile(
    path.join(OUTPUT_DIRECTORY, "SHA256SUMS.txt"),
    sha256(reportBytes) + "  dhaka-render-performance-repeatability.json\n",
    "utf8",
  );
  console.info("[P2.5] Repeatability baseline captured.", {
    reportPath,
    reportSha256: sha256(reportBytes),
    coldMedianMs: report.summary.coldRenderMs.median,
    coldP95Ms: report.summary.coldRenderMs.p95,
    warmMedianMs: report.summary.warmRenderMs.median,
    warmP95Ms: report.summary.warmRenderMs.p95,
    medianWarmImprovementPercent: report.summary.medianWarmImprovementPercent,
  });
});
