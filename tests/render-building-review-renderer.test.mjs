import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseRenderOptions } from "../src/core/building-generation/render-review-options.mjs";

const rendererSource = await readFile(new URL("../scripts/blender/render-building-review.py", import.meta.url), "utf8");

test("uses focused Rangmahal framing when its named facade meshes are available", () => {
  assert.match(rendererSource, /focus_rangmahal = bool\(rangmahal_review_meshes\)/);
  assert.match(rendererSource, /front_review_meshes = rangmahal_review_meshes/);
  assert.match(rendererSource, /front_view_framing = "rangmahal-south-facade-focused"/);
});

test("falls back to a full-model front render for generic building GLBs", () => {
  assert.match(rendererSource, /else:\n\s+front_review_meshes = meshes\n\s+front_review_center = center/);
  assert.match(rendererSource, /front_view_framing = "whole-model-generic-front"/);
  assert.match(rendererSource, /if view_id == "front":\n\s+if focus_rangmahal:/);
  assert.doesNotMatch(rendererSource, /Could not find Rangmahal meshes for the focused front review view/);
});

test("keeps the five orthographic views and eight turntable views in the renderer", () => {
  for (const view of ["front", "back", "left", "right", "top"]) {
    assert.ok(rendererSource.includes('"' + view + '"'), "missing orthographic view " + view);
  }
  assert.match(rendererSource, /for angle in range\(0, 360, 45\)/);
  assert.match(rendererSource, /"turntable-" \+ str\(angle\)\.zfill\(3\)/);
});

test("parses a bounded timeout without changing deterministic render defaults", () => {
  assert.deepEqual(parseRenderOptions([]), { resolution: 1024, blender: "blender", timeoutMs: 600000 });
  assert.deepEqual(parseRenderOptions(["--resolution=512", "--blender=/opt/blender", "--timeout-ms=120000"]), {
    resolution: 512, blender: "/opt/blender", timeoutMs: 120000,
  });
});

test("rejects unbounded renderer timeouts, invalid resolutions, and unknown flags", () => {
  for (const value of ["0", "999", "900001", "1.5", "not-a-number"]) {
    assert.throws(() => parseRenderOptions(["--timeout-ms=" + value]), /timeout-ms/);
  }
  assert.throws(() => parseRenderOptions(["--resolution=300"]), /resolution/);
  assert.throws(() => parseRenderOptions(["--unknown=true"]), /Unknown option/);
  assert.throws(() => parseRenderOptions(["--blender=   "]), /Blender executable/);
});

test("terminates a stalled Blender process and never promotes its partial output", async () => {
  const wrapper = await readFile(new URL("../scripts/render-building-review-views.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /timeout: timeoutMs/);
  assert.match(wrapper, /result\.error\.code === "ETIMEDOUT"/);
  assert.match(wrapper, /no render set is accepted/);
});
