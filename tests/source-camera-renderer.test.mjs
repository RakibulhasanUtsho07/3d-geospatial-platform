import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const python = await readFile(new URL("../scripts/blender/render-building-source-camera.py", import.meta.url), "utf8");
const wrapper = await readFile(new URL("../scripts/render-building-source-camera.mjs", import.meta.url), "utf8");

test("source-camera runner requires an explicit coordinate frame and hashes input bytes", () => {
  assert.match(wrapper, /--coordinate-frame is required/);
  assert.match(wrapper, /sha256\(modelBytes\)/);
  assert.match(wrapper, /sha256\(sourceBytes\)/);
  assert.match(wrapper, /No calibrated render was produced/);
});

test("Blender renderer uses source dimensions and the validated camera pose/intrinsics", () => {
  assert.match(python, /scene\.render\.resolution_x = width/);
  assert.match(python, /scene\.render\.resolution_y = height/);
  assert.match(python, /Matrix\(camera_plan\["rotationMatrix"\]\)\.to_quaternion\(\)/);
  assert.match(python, /camera_data\.lens = float\(camera_plan\["lensMm"\]\)/);
  assert.match(python, /camera_data\.shift_x = float\(camera_plan\["shiftX"\]\)/);
  assert.match(python, /camera_data\.shift_y = float\(camera_plan\["shiftY"\]\)/);
});

test("renderer verifies source identity again before writing candidate and reference overlay", () => {
  assert.match(python, /sha256_file\(model_path\) != plan\.get\("modelSha256"\)/);
  assert.match(python, /sha256_file\(source_path\) != plan\.get\("sourceImageSha256"\)/);
  assert.match(python, /candidate\.png/);
  assert.match(python, /overlay\.png/);
  assert.match(python, /Reference image dimensions changed; refusing to create a misleading overlay/);
});

test("reference image remains the overlay background and candidate geometry is translucent", () => {
  assert.match(python, /alpha_over\.inputs\[0\]\.default_value = 0\.5/);
  assert.match(python, /image_node\.outputs\["Image"\], alpha_over\.inputs\[1\]/);
  assert.match(python, /render_node\.outputs\["Image"\], alpha_over\.inputs\[2\]/);
  assert.match(wrapper, /publicationEligible: false/);
});
