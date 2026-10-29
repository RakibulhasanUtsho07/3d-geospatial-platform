import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture() {
  const svg = Buffer.from([
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">',
    '<rect width="400" height="400" fill="#fff"/>',
    '<g fill="none" stroke="#111" stroke-width="4">',
    '<rect x="100" y="100" width="200" height="200"/>',
    '<path d="M 20 30 H 90"/>',
    '</g></svg>',
  ].join(""), "utf8");
  const sourceBytes = await sharp(svg).png().toBuffer();
  const candidates = [
    { id: "line-0001", orientation: "horizontal", start: { x: 100, y: 100 }, end: { x: 300, y: 100 }, lengthPx: 200, confidenceScore: 0.98 },
    { id: "line-0002", orientation: "vertical", start: { x: 300, y: 100 }, end: { x: 300, y: 300 }, lengthPx: 200, confidenceScore: 0.97 },
    { id: "line-0003", orientation: "horizontal", start: { x: 100, y: 300 }, end: { x: 300, y: 300 }, lengthPx: 200, confidenceScore: 0.96 },
    { id: "line-0004", orientation: "vertical", start: { x: 100, y: 100 }, end: { x: 100, y: 300 }, lengthPx: 200, confidenceScore: 0.95 },
    { id: "line-0005", orientation: "horizontal", start: { x: 20, y: 30 }, end: { x: 90, y: 30 }, lengthPx: 70, confidenceScore: 0.72 },
  ];
  const report = {
    schemaVersion: "1.0.0",
    engine: "floor-plan-raster-line-proposals-v1",
    status: "review-required-not-scaled",
    source: { sha256: sha256(sourceBytes), mimeType: "image/png", byteSize: sourceBytes.length },
    raster: { width: 400, height: 400, originalWidth: 400, originalHeight: 400, pixelUnits: "px" },
    calibration: { status: "not-calibrated", pixelsPerMetre: null, metresPerPixel: null, units: "pixel", widthMeters: null, heightMeters: null },
    summary: { candidateCount: candidates.length, horizontalCandidates: 3, verticalCandidates: 2, truncated: false, minimumLineLengthPx: 40 },
    candidates,
    warnings: ["Synthetic browser fixture; wall and room labels require review."],
    mapReady: false,
    publicationEligible: false,
  };
  return { sourceBytes, report, reportBytes: Buffer.from(JSON.stringify(report), "utf8") };
}

async function canvasClick(page: Page, x: number, y: number) {
  const canvas = page.locator('svg[aria-label="Interactive floor-plan trace canvas"]');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  assert.ok(rect, "Review canvas must have a bounding box.");
  await page.mouse.click(rect.x + (x / 400) * rect.width, rect.y + (y / 400) * rect.height);
}

async function loadProposalAndSource(page: Page, data: Awaited<ReturnType<typeof fixture>>) {
  await page.goto("/experimental/floor-plan-review", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Proposal report JSON").setInputFiles({
    name: "proposal-report.json", mimeType: "application/json", buffer: data.reportBytes,
  });
  await expect(page.getByText("Proposal SHA-256", { exact: true })).toBeVisible();
  await page.getByLabel("Original raster source").setInputFiles({
    name: "source.png", mimeType: "image/png", buffer: data.sourceBytes,
  });
  await expect(page.getByText("Source bytes match. All review actions remain local to this browser.", { exact: true })).toBeVisible();
  await expect(page.locator('svg[aria-label="Interactive floor-plan trace canvas"]')).toBeVisible();
}

test("review UI blocks modified source bytes and only unlocks the exact original", async ({ page }) => {
  const data = await fixture();
  await page.goto("/experimental/floor-plan-review", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Proposal report JSON").setInputFiles({
    name: "proposal-report.json", mimeType: "application/json", buffer: data.reportBytes,
  });
  await expect(page.getByText("Proposal SHA-256", { exact: true })).toBeVisible();
  await page.getByLabel("Original raster source").setInputFiles({
    name: "changed-source.png",
    mimeType: "image/png",
    buffer: Buffer.concat([data.sourceBytes, Buffer.from("tampered")]),
  });
  await expect(page.getByText("Source mismatch — review/export is blocked.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Validate and download review JSON" })).toBeDisabled();
  await page.getByLabel("Original raster source").setInputFiles({
    name: "source.png", mimeType: "image/png", buffer: data.sourceBytes,
  });
  await expect(page.getByText("Source bytes match. All review actions remain local to this browser.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Validate and download review JSON" })).toBeDisabled();
});

test("draws and reviews a closed room, rejects a false line and downloads a private hash-bound review", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1500, height: 1400 });
  const data = await fixture();
  await loadProposalAndSource(page, data);

  await page.getByLabel("Reviewer name").fill("Playwright QA reviewer");
  await page.getByLabel("Review notes").fill("Synthetic fixture: line and room review interactions were tested.");
  await page.getByText("I reviewed the original source and explicitly confirm the vectors marked reviewed below.", { exact: true }).click();

  for (const lineId of ["line-0001", "line-0002", "line-0003", "line-0004"]) {
    await page.getByRole("button", { name: new RegExp(lineId) }).click();
    await page.getByRole("button", { name: "Accept as wall", exact: true }).click();
  }
  await page.getByRole("button", { name: /line-0005/ }).click();
  await page.getByRole("button", { name: "Reject line", exact: true }).click();
  await page.getByPlaceholder("Why is this not a wall?").fill("False line from a dimension annotation.");

  await page.getByRole("button", { name: "Draw room", exact: true }).click();
  await page.getByLabel("Room ID").fill("room-demo");
  await page.getByLabel("Room name").fill("Reviewed room");
  for (const [x, y] of [[105, 105], [295, 105], [295, 295], [105, 295]]) {
    await canvasClick(page, x, y);
  }
  await page.getByRole("button", { name: /Finish room/ }).click();
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();

  await page.getByRole("button", { name: "Pick scale A", exact: true }).click();
  await canvasClick(page, 40, 60);
  await page.getByRole("button", { name: "Pick scale B", exact: true }).click();
  await canvasClick(page, 140, 60);
  await page.getByRole("button", { name: "Pick origin", exact: true }).click();
  await canvasClick(page, 40, 60);
  await page.getByLabel("Known distance A–B (m)").fill("5");
  await page.getByLabel("Dimension evidence description").fill("Synthetic fixture uses a stated 5.00 m dimension.");

  await page.getByLabel("Longitude").fill("90.406");
  await page.getByLabel("Latitude").fill("23.709");
  await page.getByLabel("Origin height (m)").fill("3.5");
  await page.getByLabel("Heading (degrees)").fill("0");
  await page.getByLabel("Level elevation (m)").fill("0");
  await page.getByLabel("Wall height (m)").fill("3");
  await page.getByLabel("Wall thickness (m)").fill("0.15");
  await page.getByLabel("Floor thickness (m)").fill("0.12");
  await page.getByLabel("Boundary tolerance (m)").fill("0.3");

  const waitForDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Validate and download review JSON" }).click();
  const download = await waitForDownload;
  expect(download.suggestedFilename()).toBe("ground-floor-review.json");
  const downloadPath = await download.path();
  assert.ok(downloadPath, "Review JSON should be downloaded to a temporary file.");
  const payload = JSON.parse(await readFile(downloadPath, "utf8"));
  expect(payload.sourceSha256).toBe(data.report.source.sha256);
  expect(payload.proposalReportSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(payload.candidateDecisions).toHaveLength(5);
  expect(payload.candidateDecisions[4]).toEqual({
    proposalId: "line-0005",
    decision: "reject",
    reason: "False line from a dimension annotation.",
  });
  expect(payload.walls).toHaveLength(4);
  expect(payload.rooms).toHaveLength(1);
  expect(payload.rooms[0].reviewed).toBe(true);
  expect(apiRequests).toEqual([]);
  await expect(page.getByText("Review JSON exported. No source image or review was uploaded.", { exact: true })).toBeVisible();
});
