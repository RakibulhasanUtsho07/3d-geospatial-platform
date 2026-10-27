import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import test from "node:test";

const root = process.cwd();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const script = fileURLToPath(new URL("../scripts/prepare-building-visual-review-packet.mjs", import.meta.url));

test("reference-review packet CLI help clearly states the non-acceptance contract", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified-reference-manifest\.json/);
  assert.match(result.stdout, /pending annotation templates/);
  assert.match(result.stdout, /does not create\/approve masks/);
});

test("builds a hash-pinned review packet from verified images without inventing human review", async () => {
  const artifactsDir = path.join(root, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const tempDir = await mkdtemp(path.join(artifactsDir, "brf-review-packet-test-"));
  try {
    const sources = [];
    for (let index = 0; index < 3; index += 1) {
      const width = 64, height = 48;
      const pixels = Buffer.alloc(width * height * 3);
      for (let offset = 0; offset < pixels.length; offset += 3) {
        pixels[offset] = 45 + index * 50;
        pixels[offset + 1] = (offset / 3 + index * 17) % 255;
        pixels[offset + 2] = 180 - index * 30;
      }
      const bytes = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
      const filename = ["front.jpg", "side.jpg", "oblique.jpg"][index];
      await writeFile(path.join(tempDir, filename), bytes);
      sources.push({
        id: ["view-front", "view-side", "view-oblique"][index],
        title: ["Front fixture", "Side fixture", "Oblique fixture"][index],
        viewRole: ["south-front-elevation", "side-facade", "oblique-front-side"][index],
        url: "https://commons.wikimedia.org/wiki/File:" + filename,
        sourceUrl: "https://commons.wikimedia.org/wiki/File:" + filename,
        downloadedUrl: "https://upload.wikimedia.org/wikipedia/commons/fixture/" + filename,
        creator: "Fixture author",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
        attributionRequired: true,
        modificationDisclosureRequired: true,
        expectedByteLength: bytes.length,
        byteLength: bytes.length,
        dimensionsPixels: { width, height },
        expectedDownloadDimensions: null,
        downloadMode: "original",
        imagePath: filename,
        publishedSha1: "a".repeat(40),
        computedSha256: sha256(bytes),
        sha256: sha256(bytes),
        verified: true,
        downloaded: true,
        viewAssessment: {
          geometryUse: "qualitative visual comparison only",
          occlusions: ["foreground fixture occlusion"],
          cameraCalibration: "unknown",
          notSufficientFor: ["independent dimension survey"],
        },
      });
    }
    const manifest = {
      schemaVersion: "1.0.0",
      id: "fixture-building-reference-pack",
      building: { name: "Synthetic fixture building" },
      verified: true,
      sources,
    };
    const manifestPath = path.join(tempDir, "reference-pack.manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const manifestRelative = path.relative(root, manifestPath).split(path.sep).join("/");
    const outputRelative = path.relative(root, path.join(tempDir, "review-packet")).split(path.sep).join("/");
    const result = spawnSync(process.execPath, [script, manifestRelative, outputRelative], {
      cwd: root, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);

    const outputDir = path.join(root, outputRelative);
    const packetBytes = await readFile(path.join(outputDir, "review-packet.json"));
    const packet = JSON.parse(packetBytes.toString("utf8"));
    assert.equal(packet.sourceCount, 3);
    assert.equal(packet.sourceImages.length, 3);
    assert.equal(packet.policy.groundTruth, false);
    assert.equal(packet.policy.acceptanceEligible, false);
    assert.equal(packet.policy.publicationEligible, false);
    assert.equal(packet.policy.mapReady, false);
    assert.equal(packet.policy.independentlyReviewedMasksAvailable, false);
    assert.ok(packet.blockingGaps.length >= 4);
    for (const asset of packet.sourceImages) {
      const source = sources.find((item) => item.id === asset.id);
      assert.equal(asset.sha256, source.computedSha256);
      assert.deepEqual(asset.downloadedDimensions, { width: 64, height: 48 });
      assert.equal(asset.independentRightsReview, "required");
      assert.equal(asset.metadataQuality, "downloaded-and-hash-verified");
      const bytes = await readFile(path.join(outputDir, asset.imagePath));
      assert.equal(sha256(bytes), asset.sha256);
      const template = JSON.parse(await readFile(
        path.join(outputDir, "annotation-templates", asset.id + ".annotation-template.json"), "utf8"));
      assert.equal(template.source.sha256, asset.sha256);
      assert.equal(template.rightsReview.status, "pending-independent-review");
      assert.equal(template.masks.status, "pending-annotation");
      assert.deepEqual(template.observations, []);
      assert.equal(template.acceptance.reviewedByIndependentHuman, false);
      assert.equal(template.acceptance.groundTruth, false);
      assert.equal(template.acceptance.acceptanceEligible, false);
    }
    const contact = await readFile(path.join(outputDir, "contact-sheet.png"));
    assert.equal(sha256(contact), packet.contactSheet.sha256);
    assert.equal(packet.contactSheet.width, 1600);
    assert.equal(packet.contactSheet.height, 1200);
    assert.match(await readFile(path.join(outputDir, "SHA256SUMS.txt"), "utf8"), /contact-sheet\.png/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
