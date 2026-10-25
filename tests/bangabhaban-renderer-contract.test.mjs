import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const renderer = await readFile(new URL("../scripts/blender/render-building-review.py", import.meta.url), "utf8");
test("headless Blender QA samples the exact saved PNG rather than relying on transient Render Result pixels", () => {
  assert.match(renderer, /rendered_path = scene\.render\.filepath/);
  assert.match(renderer, /os\.path\.isfile\(rendered_path\)/);
  assert.match(renderer, /bpy\.data\.images\.load\(rendered_path, check_existing=False\)/);
  assert.match(renderer, /stats = sample_pixel_statistics\(result, resolution\)/);
  assert.match(renderer, /bpy\.data\.images\.remove\(result\)/);
  assert.doesNotMatch(renderer, /bpy\.data\.images\.get\("Render Result"\)/);
});
