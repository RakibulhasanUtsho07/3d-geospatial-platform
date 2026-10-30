import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const OBSERVATION_URL = "/experimental/architectural-observation-review.html";
const BUNDLE_URL = "/experimental/source-bound-evidence-bundle.html";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function png(page: Page, mask = false, variant = false): Promise<Buffer> {
  const dataUrl = await page.evaluate((isMask: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 48;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas fixture context unavailable.");
    if (!isMask) {
      context.fillStyle = "#a9b8c9"; context.fillRect(0, 0, 64, 48);
      context.fillStyle = "#ffffff"; context.fillRect(isVariant ? 20 : 12, isVariant ? 10 : 6, isVariant ? 20 : 40, isVariant ? 20 : 36);
    } else {
      context.clearRect(0, 0, 64, 48);
      context.fillStyle = "#ffffff"; context.fillRect(12, 6, 40, 36);
    }
    return canvas.toDataURL("image/png");
  }, { mask, variant });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function download(page: Page, selector: string): Promise<Buffer> {
  const pending = page.waitForEvent("download");
  await page.locator(selector).click();
  const item = await pending;
  const path = await item.path();
  assert.ok(path);
  return readFile(path);
}

test("browser wizard links real source, mask and observation exports into one fail-closed bundle", async ({ page }: { page: Page }) => {
  const source = await png(page);
  const mask = await png(page, true);
  const sourceHash = sha256(source);
  const maskHash = sha256(mask);

  await page.goto(OBSERVATION_URL);
  await page.locator("#building-id").fill("sample-building");
  await page.locator("#view-id").fill("front");
  await page.locator("#source-id").fill("sample-front-01");
  await page.locator("#source-file").setInputFiles({ name: "source.png", mimeType: "image/png", buffer: source });
  await expect(page.locator("#source-status")).toContainText("Loaded and hashed");
  await page.locator("#category").selectOption("roofline-segment");
  await page.locator("#geometry-type").selectOption("LineString");
  await page.locator("#annotation-canvas").click({ position: { x: 10, y: 12 } });
  await page.locator("#annotation-canvas").click({ position: { x: 50, y: 13 } });
  await page.locator("#finish-geometry").click();
  const observationBytes = await download(page, "#export-batch");
  const observationBatch = JSON.parse(observationBytes.toString("utf8"));
  assert.equal(observationBatch.mask, null);
  assert.equal(observationBatch.source.sha256, sourceHash);

  const maskManifest = {
    schemaVersion: "1.0.0",
    artifactType: "source-bound-manual-mask-review",
    generatedAt: "2026-10-30T10:00:00.000Z",
    source: { sourceId: "sample-front-01", filename: "source.png", sha256: sourceHash, bytes: source.length,
      width: 64, height: 48, mimeType: "image/png" },
    result: { schemaVersion: "1.0.0", sourceId: "sample-front-01", inputSha256: sourceHash,
      provider: { id: "manual-mask-review-editor", kind: "human-reviewed-mask", version: "1.0.0", configurationSha256: "a".repeat(64) },
      mask: { sha256: maskHash, bytes: mask.length, width: 64, height: 48,
        encoding: "binary-8bit-white-foreground-v1", coordinateConvention: "pixel-origin-top-left",
        backgroundValue: 0, foregroundValue: 255 },
      assessment: { status: "proposed", confidence: 0.5, humanReviewed: false } },
    policy: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false, publishable: false },
  };
  const manifestBytes = Buffer.from(JSON.stringify(maskManifest, null, 2) + "\n");

  await page.goto(BUNDLE_URL);
  await page.locator("#source-file").setInputFiles({ name: "source.png", mimeType: "image/png", buffer: source });
  await page.locator("#mask-file").setInputFiles({ name: "mask.png", mimeType: "image/png", buffer: mask });
  await page.locator("#mask-manifest").setInputFiles({ name: "mask-review.json", mimeType: "application/json", buffer: manifestBytes });
  await page.locator("#observations").setInputFiles({ name: "observations.json", mimeType: "application/json", buffer: observationBytes });
  await page.locator("#build").click();
  await expect(page.locator("#status")).toContainText("Bundle validation passed.");
  await expect(page.locator("#download")).toBeEnabled();

  const bundleBytes = await download(page, "#download");
  const bundle = JSON.parse(bundleBytes.toString("utf8"));
  assert.equal(bundle.source.sha256, sourceHash);
  assert.equal(bundle.maskArtifact.sha256, maskHash);
  assert.equal(bundle.maskArtifact.manifestSha256, sha256(manifestBytes));
  assert.equal(bundle.observationArtifact.batch.mask.sha256, maskHash);
  assert.equal(bundle.observationArtifact.batch.mask.width, 64);
  assert.equal(bundle.observationArtifact.observationCount, 1);
  assert.equal(bundle.evidenceLinks.maskAndObservationsShareExactSource, true);
  assert.equal(bundle.evidenceLinks.observationsReferenceExactMask, true);
  assert.equal(bundle.policy.groundTruth, false);
  assert.equal(bundle.policy.acceptanceEligible, false);
  assert.equal(bundle.policy.publicationEligible, false);
  assert.equal(bundle.policy.mapReady, false);
});

test("browser wizard rejects a mask PNG whose bytes do not match its manifest", async ({ page }: { page: Page }) => {
  const source = await png(page);
  const mask = await png(page, true);
  const alteredMask = await png(page, true, true);
  const sourceHash = sha256(source);
  const manifest = {
    schemaVersion: "1.0.0", artifactType: "source-bound-manual-mask-review",
    source: { sourceId: "sample-front-01", sha256: sourceHash, bytes: source.length, width: 64, height: 48 },
    result: { schemaVersion: "1.0.0", sourceId: "sample-front-01", inputSha256: sourceHash,
      mask: { sha256: sha256(mask), bytes: mask.length, width: 64, height: 48,
        encoding: "binary-8bit-white-foreground-v1", coordinateConvention: "pixel-origin-top-left",
        backgroundValue: 0, foregroundValue: 255 },
      assessment: { status: "proposed", humanReviewed: false } },
    policy: { acceptanceEligible: false, publicationEligible: false, mapReady: false, automaticApproval: false, publishable: false },
  };
  const observations = {
    schemaVersion: "1.0.0", batchId: "batch-01", buildingId: "sample-building", viewId: "front",
    createdAt: "2026-10-30T10:00:00.000Z", coordinateConvention: "source-image-pixel-origin-top-left",
    source: { id: "sample-front-01", sha256: sourceHash, width: 64, height: 48 }, mask: null, observations: [],
    policy: { groundTruth: false, publicationEligible: false, publishable: false },
  };
  await page.goto(BUNDLE_URL);
  await page.locator("#source-file").setInputFiles({ name: "source.png", mimeType: "image/png", buffer: source });
  await page.locator("#mask-file").setInputFiles({ name: "wrong-mask.png", mimeType: "image/png", buffer: alteredMask });
  await page.locator("#mask-manifest").setInputFiles({ name: "mask-review.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(manifest)) });
  await page.locator("#observations").setInputFiles({ name: "observations.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(observations)) });
  await page.locator("#build").click();
  await expect(page.locator("#status")).toContainText("Mask PNG bytes, dimensions or encoding do not match");
  await expect(page.locator("#download")).toBeDisabled();
});
