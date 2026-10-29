import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const REVIEW_URL = "/experimental/building-mask-review.html";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixturePng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context is unavailable in the test browser.");
    context.fillStyle = "#8b9caf";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#d9c9b0";
    context.fillRect(18, 8, 28, 34);
    context.fillStyle = "#53677f";
    context.fillRect(25, 17, 6, 8);
    context.fillRect(34, 17, 6, 8);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function loadFixture(page: Page, sourceId = "fixture-front"): Promise<Buffer> {
  await page.goto(REVIEW_URL);
  await expect(page.getByRole("heading", { name: "Building mask review" })).toBeVisible();
  const sourceBytes = await fixturePng(page);
  await page.locator("#source-id").fill(sourceId);
  await page.locator("#source-file").setInputFiles({
    name: "fixture-front.png",
    mimeType: "image/png",
    buffer: sourceBytes,
  });
  await expect(page.locator("#source-status")).toContainText("Loaded and hashed");
  await expect(page.locator("#mask-canvas")).toBeVisible();
  assert.equal(await page.locator("#source-hash").textContent(), sha256(sourceBytes));
  return sourceBytes;
}

async function drawOneStroke(page: Page): Promise<void> {
  const canvas = page.locator("#mask-canvas");
  const bounds = await canvas.boundingBox();
  assert.ok(bounds, "mask canvas should have a visible bounding box");
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
}

async function downloadBytes(page: Page, selector: string): Promise<{ filename: string; bytes: Buffer }> {
  const pending = page.waitForEvent("download");
  await page.locator(selector).click();
  const download = await pending;
  const path = await download.path();
  assert.ok(path, "browser download should be materialized for test inspection");
  return { filename: download.suggestedFilename(), bytes: await readFile(path) };
}

async function assertBinaryPng(page: Page, pngBytes: Buffer): Promise<void> {
  const decoded = await page.evaluate(async (base64: string) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D context is unavailable while validating the mask PNG.");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    let foreground = 0;
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 255 || data[i] !== data[i + 1] || data[i + 1] !== data[i + 2] || (data[i] !== 0 && data[i] !== 255)) {
        throw new Error("PNG contains non-binary or non-opaque mask pixels");
      }
      colours.add(data[i]);
      if (data[i] === 255) foreground += 1;
    }
    return { width: image.width, height: image.height, foreground, colours: Array.from(colours) };
  }, pngBytes.toString("base64"));
  assert.equal(decoded.width, 64);
  assert.equal(decoded.height, 48);
  assert.ok(decoded.foreground > 0 && decoded.foreground < decoded.width * decoded.height);
  assert.deepEqual(decoded.colours.sort((a: number,b: number)=>a-b), [0,255]);
}

test("manual mask editor exports source/hash-bound binary PNG and a proposed manifest by default", async ({ page }: { page: Page }) => {
  const sourceBytes = await loadFixture(page);
  await drawOneStroke(page);
  const png = await downloadBytes(page, "#export-mask-png");
  assert.equal(png.filename, "fixture-front-mask.png");
  await assertBinaryPng(page, png.bytes);
  await expect(page.locator("#download-manifest")).toBeEnabled();

  const json = await downloadBytes(page, "#download-manifest");
  assert.equal(json.filename, "fixture-front-mask-review.json");
  const manifest = JSON.parse(json.bytes.toString("utf8"));
  assert.equal(manifest.artifactType, "source-bound-manual-mask-review");
  assert.equal(manifest.source.sourceId, "fixture-front");
  assert.equal(manifest.source.sha256, sha256(sourceBytes));
  assert.equal(manifest.source.bytes, sourceBytes.length);
  assert.equal(manifest.source.width, 64);
  assert.equal(manifest.source.height, 48);
  assert.equal(manifest.result.schemaVersion, "1.0.0");
  assert.equal(manifest.result.provider.kind, "human-reviewed-mask");
  assert.equal(manifest.result.inputSha256, sha256(sourceBytes));
  assert.equal(manifest.result.mask.sha256, sha256(png.bytes));
  assert.equal(manifest.result.mask.bytes, png.bytes.length);
  assert.equal(manifest.result.mask.width, 64);
  assert.equal(manifest.result.mask.height, 48);
  assert.equal(manifest.result.mask.encoding, "binary-8bit-white-foreground-v1");
  assert.equal(manifest.result.assessment.status, "proposed");
  assert.equal(manifest.result.assessment.humanReviewed, false);
  assert.deepEqual(manifest.policy, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
    publishable: false,
  });

  await page.locator("#existing-mask-file").setInputFiles({ name: png.filename, mimeType: "image/png", buffer: png.bytes });
  await page.locator("#existing-mask-manifest").setInputFiles({ name: json.filename, mimeType: "application/json", buffer: json.bytes });
  await page.locator("#load-existing-mask").click();
  await expect(page.locator("#import-status")).toContainText("source/hash verified");

  const staleManifest = structuredClone(manifest);
  staleManifest.source.sha256 = "f".repeat(64);
  await page.locator("#existing-mask-manifest").setInputFiles({
    name: "stale-mask-review.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(staleManifest)),
  });
  await page.locator("#load-existing-mask").click();
  await expect(page.locator("#import-status")).toContainText("does not match the exact loaded source");
  await expect(page.locator("#download-manifest")).toBeDisabled();
});

test("manual mask editor records a named human-review attestation but never approves publication", async ({ page }: { page: Page }) => {
  await loadFixture(page, "fixture-heritage-front");
  await drawOneStroke(page);
  const png = await downloadBytes(page, "#export-mask-png");
  await assertBinaryPng(page, png.bytes);

  await page.locator("#reviewer-id").fill("reviewer-fixture-a");
  await page.locator("#confidence").evaluate((element: HTMLInputElement) => {
    element.value = "0.75";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#review-confirm").check();
  const json = await downloadBytes(page, "#download-manifest");
  const manifest = JSON.parse(json.bytes.toString("utf8"));
  assert.equal(manifest.result.assessment.status, "reviewed");
  assert.equal(manifest.result.assessment.humanReviewed, true);
  assert.equal(manifest.result.assessment.reviewerId, "reviewer-fixture-a");
  assert.ok(Number.isFinite(Date.parse(manifest.result.assessment.reviewedAt)));
  assert.equal(manifest.result.assessment.confidence, 0.75);
  assert.equal(manifest.policy.acceptanceEligible, false);
  assert.equal(manifest.policy.publicationEligible, false);
  assert.equal(manifest.policy.mapReady, false);
  assert.equal(manifest.policy.automaticApproval, false);
  assert.equal(manifest.policy.publishable, false);
});

test("manual mask editor rejects empty masks and refuses reviewed export without reviewer identity", async ({ page }: { page: Page }) => {
  await loadFixture(page, "fixture-edge-case");
  await page.locator("#export-mask-png").click();
  await expect(page.locator("#export-status")).toContainText("Mask must contain both building foreground and background pixels");
  await drawOneStroke(page);
  await downloadBytes(page, "#export-mask-png");
  await page.locator("#review-confirm").check();
  await page.locator("#download-manifest").click();
  await expect(page.locator("#export-status")).toContainText("Enter the reviewer identifier");
});
