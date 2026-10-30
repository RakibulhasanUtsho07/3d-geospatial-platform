import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const REVIEW_URL = "/experimental/architectural-observation-review.html";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixturePng(page: Page, variant = 0): Promise<Buffer> {
  const dataUrl = await page.evaluate((tone: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Fixture canvas context unavailable.");
    context.fillStyle = tone === 0 ? "#8b9caf" : "#9b8caf";
    context.fillRect(0, 0, 64, 48);
    context.fillStyle = "#ddc9b0";
    context.fillRect(16, 7, 32, 36);
    context.fillStyle = "#53677f";
    context.fillRect(22, 16, 7, 8);
    context.fillRect(35, 16, 7, 8);
    return canvas.toDataURL("image/png");
  }, variant);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function loadSource(
  page: Page,
  bytes: Buffer,
  sourceId = "ahsan-front-01",
): Promise<void> {
  await page.goto(REVIEW_URL);
  await expect(page.getByRole("heading", { name: "Architectural observation review studio" })).toBeVisible();
  await page.locator("#building-id").fill("ahsan-manzil");
  await page.locator("#view-id").fill("front");
  await page.locator("#source-id").fill(sourceId);
  await page.locator("#source-file").setInputFiles({
    name: "front-reference.png",
    mimeType: "image/png",
    buffer: bytes,
  });
  await expect(page.locator("#source-status")).toContainText("Loaded and hashed");
  assert.equal(await page.locator("#source-hash").textContent(), sha256(bytes));
  await expect(page.locator("#annotation-canvas")).toBeVisible();
}

async function downloadBytes(page: Page): Promise<{ filename: string; bytes: Buffer }> {
  const pending = page.waitForEvent("download");
  await page.locator("#export-batch").click();
  const download = await pending;
  const path = await download.path();
  assert.ok(path, "download should be available for assertions");
  return { filename: download.suggestedFilename(), bytes: await readFile(path) };
}

async function clickCanvas(page: Page, x: number, y: number): Promise<void> {
  await page.locator("#annotation-canvas").click({ position: { x, y } });
}

test("manual source-pixel annotations export the exact source/view contract", async ({ page }: { page: Page }) => {
  const source = await fixturePng(page);
  await loadSource(page, source);
  await page.locator("#category").selectOption("dome-candidate");
  await page.locator("#geometry-type").selectOption("Point");
  await clickCanvas(page, 20, 18);

  await expect(page.locator("#observation-list")).toContainText("dome-candidate");
  await expect(page.locator("#observation-list")).toContainText("proposed");

  const output = await downloadBytes(page);
  assert.equal(output.filename, "ahsan-manzil-front-architectural-observations.json");
  const batch = JSON.parse(output.bytes.toString("utf8"));
  assert.equal(batch.schemaVersion, "1.0.0");
  assert.equal(batch.buildingId, "ahsan-manzil");
  assert.equal(batch.viewId, "front");
  assert.equal(batch.coordinateConvention, "source-image-pixel-origin-top-left");
  assert.equal(batch.source.id, "ahsan-front-01");
  assert.equal(batch.source.sha256, sha256(source));
  assert.equal(batch.source.width, 64);
  assert.equal(batch.source.height, 48);
  assert.equal(batch.mask, null);
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].category, "dome-candidate");
  assert.equal(batch.observations[0].method, "human-review");
  assert.equal(batch.observations[0].status, "proposed");
  assert.deepEqual(batch.observations[0].geometry, { type: "Point", coordinates: [20, 18] });
  assert.deepEqual(batch.policy, { groundTruth: false, publicationEligible: false, publishable: false });
});

test("polygon review, rejection, reopening and batch round-trip preserve append-only history", async ({ page }: { page: Page }) => {
  const source = await fixturePng(page);
  await loadSource(page, source);
  await page.locator("#category").selectOption("arch-candidate");
  await page.locator("#geometry-type").selectOption("Polygon");
  await clickCanvas(page, 12, 10);
  await clickCanvas(page, 42, 10);
  await clickCanvas(page, 38, 34);
  await page.locator("#finish-geometry").click();
  await expect(page.locator("#observation-list")).toContainText("arch-candidate");

  await page.locator("#reviewer-id").fill("architect-reviewer-a");
  await page.locator("#review-notes").fill("The arch boundary is visible in the supplied front view.");
  await page.locator("#review-observation").click();
  await expect(page.locator("#selected-status")).toContainText("reviewed");

  await page.locator("#reviewer-id").fill("architect-reviewer-b");
  await page.locator("#review-notes").fill("Reconsidered: the right springing is partially hidden.");
  await page.locator("#reject-observation").click();
  await expect(page.locator("#selected-status")).toContainText("rejected");

  await page.locator("#reopen-observation").click();
  await expect(page.locator("#selected-status")).toContainText("proposed");
  await expect(page.locator("#selected-status")).toContainText("2 review event(s)");

  const output = await downloadBytes(page);
  const batch = JSON.parse(output.bytes.toString("utf8"));
  const observation = batch.observations[0];
  assert.equal(observation.status, "proposed");
  assert.equal(observation.originalProposal.status, "proposed");
  assert.equal(observation.originalProposal.geometry.type, "Polygon");
  assert.equal(observation.originalProposal.geometry.coordinates[0][0][0], 12);
  assert.deepEqual(observation.reviews.map((event: { decision: string }) => event.decision), ["reviewed", "rejected"]);
  assert.equal(observation.reviews[0].reviewerId, "architect-reviewer-a");
  assert.equal(observation.reviews[1].reviewerId, "architect-reviewer-b");
  assert.equal(observation.reviews[1].notes, "Reconsidered: the right springing is partially hidden.");

  await loadSource(page, source);
  await page.locator("#batch-file").setInputFiles({
    name: output.filename,
    mimeType: "application/json",
    buffer: output.bytes,
  });
  await page.locator("#import-batch").click();
  await expect(page.locator("#batch-status")).toContainText("Validated and imported 1 source-bound observation");
  await expect(page.locator("#selected-status")).toContainText("proposed");
  await expect(page.locator("#selected-status")).toContainText("2 review event(s)");
  const roundTrip = await downloadBytes(page);
  const restored = JSON.parse(roundTrip.bytes.toString("utf8")).observations[0];
  assert.equal(restored.reviews.length, 2);
  assert.equal(restored.originalProposal.geometry.coordinates[0][0][0], 12);
});

test("not-visible and not-detected observations can be recorded without invented geometry", async ({ page }: { page: Page }) => {
  const source = await fixturePng(page);
  await loadSource(page, source);

  await page.locator("#category").selectOption("dome-candidate");
  await page.locator("#visibility").selectOption("not-visible");
  await page.locator("#add-no-geometry").click();

  await page.locator("#category").selectOption("window-candidate");
  await page.locator("#visibility").selectOption("not-detected");
  await page.locator("#add-no-geometry").click();

  const output = await downloadBytes(page);
  const batch = JSON.parse(output.bytes.toString("utf8"));
  assert.equal(batch.observations.length, 2);
  assert.equal(batch.observations[0].visibility, "not-visible");
  assert.equal(batch.observations[1].visibility, "not-detected");
  assert.equal(batch.observations[0].geometry, null);
  assert.equal(batch.observations[1].geometry, null);
});
