import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildRenderContactSheet, REVIEW_VIEW_IDS } from "../scripts/build-render-contact-sheet.mjs";

async function createFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-contact-sheet-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "views");
  await mkdir(inputDir, { recursive: true });
  const size = options.size ?? 16;
  const objectSize = options.objectSize ?? 12;
  const inset = Math.floor((size - objectSize) / 2);

  const viewManifest = [];
  for (const id of REVIEW_VIEW_IDS) {
    const imagePath = path.join(inputDir, id + ".png");
    const background = sharp({
      create: { width: size, height: size, channels: 3, background: "#161d23" },
    });
    const image = await background.composite([{
      input: await sharp({
        create: {
          width: objectSize,
          height: objectSize,
          channels: 3,
          background: "#e7e5de",
        },
      }).png().toBuffer(),
      left: inset,
      top: inset,
    }]).png().toBuffer();
    await writeFile(imagePath, image);
    viewManifest.push({
      id: id,
      filename: id + ".png",
      sha256: createHash("sha256").update(image).digest("hex"),
      width: size,
      height: size,
      renderComplete: true,
    });
  }
  await writeFile(path.join(inputDir, "render-review-manifest.json"), JSON.stringify({
    valid: true,
    modelSha256: "a".repeat(64),
    views: viewManifest,
  }));
  return { root: root, inputDir: inputDir, outputPath: path.join(root, "out", "contact-sheet.png") };
}

test("contact sheet validates all fixed views and emits hash-pinned pixel occupancy evidence", async (t) => {
  const fixture = await createFixture(t);
  const result = await buildRenderContactSheet(fixture.inputDir, fixture.outputPath, {
    resolution: 16,
    thumbSize: 32,
    labelHeight: 18,
    columns: 4,
  });
  const metadata = await sharp(fixture.outputPath).metadata();
  const report = JSON.parse(await readFile(result.visibilityReportPath, "utf8"));

  assert.equal(result.viewCount, 13);
  assert.equal(result.width, 128);
  assert.equal(result.height, 200);
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 200);
  assert.equal(report.summary.status, "passed");
  assert.equal(report.summary.passedViews, 13);
  assert.equal(report.views.length, 13);
  assert.equal(report.candidateModelSha256, "a".repeat(64));
  assert.equal(report.views[0].foregroundBounds.width, 12);
  assert.equal(report.views[0].foregroundBounds.height, 12);
  assert.equal(report.views[0].maxAxisFillRatio, 0.75);
});

test("contact sheet fails closed when a fixed view is missing", async (t) => {
  const fixture = await createFixture(t);
  await rm(path.join(fixture.inputDir, "front.png"));

  await assert.rejects(
    buildRenderContactSheet(fixture.inputDir, fixture.outputPath, { resolution: 16 }),
    /Missing or invalid review image '.*front\.png'/,
  );
});

test("contact sheet rejects wrong-sized images rather than silently resizing evidence", async (t) => {
  const fixture = await createFixture(t);
  const frontPath = path.join(fixture.inputDir, "front.png");
  const wrongSize = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#161d23" },
  }).png().toBuffer();
  await writeFile(frontPath, wrongSize);

  await assert.rejects(
    buildRenderContactSheet(fixture.inputDir, fixture.outputPath, { resolution: 16 }),
    /must be 16×16; got 8×8/,
  );
});

test("contact sheet rejects views whose rendered foreground is too small", async (t) => {
  const fixture = await createFixture(t, { objectSize: 8 });
  await assert.rejects(
    buildRenderContactSheet(fixture.inputDir, fixture.outputPath, {
      resolution: 16,
      minAxisFillRatio: 0.70,
    }),
    /Foreground visibility gate failed: front=0\.5 \(foreground-underfills-frame\)/,
  );
  const report = JSON.parse(await readFile(path.join(fixture.inputDir, "foreground-visibility-report.json"), "utf8"));
  assert.equal(report.summary.status, "failed");
  assert.equal(report.summary.failedViews, 13);
});
