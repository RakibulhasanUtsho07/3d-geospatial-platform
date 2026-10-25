import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildRenderContactSheet, REVIEW_VIEW_IDS } from "../scripts/build-render-contact-sheet.mjs";

test("contact sheet contains every expected fixed view at the configured resolution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-contact-sheet-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "views");
  const outputPath = path.join(root, "out", "contact-sheet.png");
  await mkdir(inputDir, { recursive: true });

  for (const id of REVIEW_VIEW_IDS) {
    await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#d8d8d8" },
    }).png().toFile(path.join(inputDir, `${id}.png`));
  }

  const result = await buildRenderContactSheet(inputDir, outputPath, {
    resolution: 16,
    thumbSize: 32,
    labelHeight: 18,
    columns: 4,
  });
  const metadata = await sharp(outputPath).metadata();

  assert.equal(result.viewCount, 13);
  assert.equal(result.width, 128);
  assert.equal(result.height, 200);
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 200);
});

test("contact sheet fails closed when a fixed view is absent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-contact-sheet-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "views");
  await mkdir(inputDir, { recursive: true });

  await assert.rejects(
    buildRenderContactSheet(inputDir, path.join(root, "sheet.png"), { resolution: 16 }),
    /Missing or invalid review image '.*front\.png'/,
  );
});

test("contact sheet rejects wrong-sized images rather than silently resizing evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-contact-sheet-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "views");
  await mkdir(inputDir, { recursive: true });

  for (const id of REVIEW_VIEW_IDS) {
    const size = id === "front" ? 8 : 16;
    await sharp({
      create: { width: size, height: size, channels: 3, background: "#d8d8d8" },
    }).png().toFile(path.join(inputDir, `${id}.png`));
  }

  await assert.rejects(
    buildRenderContactSheet(inputDir, path.join(root, "sheet.png"), {
      resolution: 16,
    }),
    /must be 16×16; got 8×8/,
  );
});
