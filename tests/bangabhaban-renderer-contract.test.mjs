import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const renderer = await readFile(new URL("../scripts/blender/render-building-review.py", import.meta.url), "utf8");
test("headless Blender QA samples the exact saved PNG rather than relying on transient Render Result pixels", () => {
  assert.match(renderer, /rendered_path = os\.path\.join\(output_dir, filename\)/);
  assert.match(renderer, /scene\.render\.filepath = rendered_path/);
  assert.match(renderer, /os\.path\.isfile\(rendered_path\)/);
  assert.match(renderer, /bpy\.data\.images\.load\(rendered_path, check_existing=False\)/);
  assert.match(renderer, /stats = sample_pixel_statistics\(result, resolution\)/);
  assert.match(renderer, /bpy\.data\.images\.remove\(result\)/);
  assert.doesNotMatch(renderer, /bpy\.data\.images\.get\("Render Result"\)/);
});
test("front review camera uses a small elevation to expose stair treads", () => {
  assert.match(renderer, /\("front", Vector\(\(0\.0, -math\.cos\(math\.radians\(5\.0\)\), math\.sin\(math\.radians\(5\.0\)\)\)\), "ORTHO"\)/);
});
test("heritage render lighting preserves facade contrast on large models", () => {
  assert.match(renderer, /default_value = \(0\.055, 0\.070, 0\.090, 1\.0\)/);
  assert.match(renderer, /AgX - Medium High Contrast/);
  assert.match(renderer, /min\(8000000\.0, max_dimension \* max_dimension \* 180\.0\)/);
  assert.doesNotMatch(renderer, /min\(50000\.0, max_dimension \* max_dimension/);
});
