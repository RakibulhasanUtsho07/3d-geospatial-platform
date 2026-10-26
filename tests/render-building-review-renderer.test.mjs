import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
