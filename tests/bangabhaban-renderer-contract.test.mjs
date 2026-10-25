import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const renderer = await readFile(new URL("../scripts/blender/render-building-review.py", import.meta.url), "utf8");
test("headless Blender QA samples saved PNG bytes rather than the transient Render Result image", () => {
  assert.match(renderer, /rendered_path = scene\.render\.filepath/);
  assert.match(renderer, /bpy\.data\.images\.load\(rendered_path, check_existing=False\)/);
  assert.match(renderer, /stats = sample_pixel_statistics\(result, resolution\)/);
  assert.match(renderer, /bpy\.data\.images\.remove\(result\)/);
  assert.doesNotMatch(renderer, /bpy\.data\.images\.get\("Render Result"\)/);
});
