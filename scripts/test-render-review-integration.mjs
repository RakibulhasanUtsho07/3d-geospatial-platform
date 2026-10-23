#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateProceduralGlb } from "../src/core/building-generation/procedural-glb.mjs";
import { REQUIRED_REVIEW_VIEWS } from "../src/core/building-generation/render-review-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const blender = (process.env.BLENDER_BIN || "blender").trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  if (!blender) throw new TypeError("BLENDER_BIN must not be empty");
  const root = await mkdtemp(path.join(os.tmpdir(), "building-render-review-integration-"));
  let succeeded = false;
  try {
    const spec = JSON.parse(await readFile(new URL("../tests/fixtures/demo-building-spec.json", import.meta.url), "utf8"));
    const generated = generateProceduralGlb(spec);
    const modelPath = path.join(root, "render-review-fixture.glb");
    const outputDir = path.join(root, "render-review-output");
    await writeFile(modelPath, generated.glb, { flag: "wx", mode: 0o600 });
    const modelSha256 = sha256(await readFile(modelPath));

    const result = spawnSync(process.execPath, [
      path.join(here, "render-building-review-views.mjs"),
      modelPath,
      outputDir,
      "--resolution=256",
      "--blender=" + blender,
    ], { encoding: "utf8", windowsHide: true, timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
    if (result.error) throw new Error("Render-review CLI could not start: " + result.error.message);
    if (result.status !== 0) {
      throw new Error("Headless Blender render integration failed (exit " + result.status + "). Artifacts retained at " + outputDir + "\n" +
        ((result.stdout || "") + "\n" + (result.stderr || "")).trim().slice(-12000));
    }

    const manifest = JSON.parse(await readFile(path.join(outputDir, "render-review-manifest.json"), "utf8"));
    assert.equal(manifest.valid, true, "manifest should validate after real renders");
    assert.notEqual(manifest.status, "failed");
    assert.equal(manifest.publicationEligible, false, "render review must never grant publication eligibility");
    assert.equal(manifest.modelSha256, modelSha256, "manifest must bind the source GLB hash");
    assert.equal(manifest.geometryQaSummary?.engine, "glb-geometry-qa-v2");
    assert.equal(manifest.geometryQaSummary?.valid, true);
    assert.equal(manifest.counts.generatedViews, REQUIRED_REVIEW_VIEWS.length);
    assert.deepEqual(manifest.views.map((view) => view.id), [...REQUIRED_REVIEW_VIEWS]);
    assert.match(manifest.renderConfigSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.renderProfile, "building-review-fixed-cameras-v1");

    const outputFiles = new Set(await readdir(outputDir));
    for (const view of manifest.views) {
      assert.ok(outputFiles.has(view.filename), "expected PNG is missing: " + view.filename);
      const bytes = await readFile(path.join(outputDir, view.filename));
      assert.ok(bytes.length > 24, "PNG is empty or truncated: " + view.filename);
      assert.equal(bytes.toString("ascii", 1, 4), "PNG", "render output is not PNG: " + view.filename);
      assert.equal(bytes.readUInt32BE(16), 256, "wrong render width: " + view.filename);
      assert.equal(bytes.readUInt32BE(20), 256, "wrong render height: " + view.filename);
      assert.equal(sha256(bytes), view.sha256, "manifest SHA-256 does not match: " + view.filename);
      assert.equal(view.renderComplete, true);
      assert.ok(view.cameraPose?.positionWorld?.length === 3, "camera pose missing: " + view.id);
    }
    assert.equal(outputFiles.has(".blender-render-manifest.raw.json"), false, "temporary manifest must not be left behind");

    console.log(JSON.stringify({
      status: "headless-render-integration-passed",
      blender: manifest.rendererVersion,
      modelSha256,
      renderConfigSha256: manifest.renderConfigSha256,
      views: manifest.counts.generatedViews,
      resolution: "256x256",
      geometryQaStatus: manifest.geometryQaSummary.status,
      pngHashesVerified: manifest.views.length,
      warnings: manifest.warnings.length,
      publicationEligible: false,
    }, null, 2));
    succeeded = true;
  } finally {
    if (succeeded) await rm(root, { recursive: true, force: true });
    else console.error("Render integration workspace retained for diagnosis: " + root);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
