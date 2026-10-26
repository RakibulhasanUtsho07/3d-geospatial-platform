import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseRenderOptions } from "../src/core/building-generation/render-review-options.mjs";

const rendererSource = await readFile(new URL("../scripts/blender/render-building-review.py", import.meta.url), "utf8");
const cameraSetupSource = await readFile(new URL("../scripts/blender/source_camera_camera.py", import.meta.url), "utf8");

test("keeps the renderer generic and moves building-specific framing into a review profile", async () => {
  assert.match(rendererSource, /def read_review_profile\(opts\):/);
  assert.match(rendererSource, /DEFAULT_REVIEW_PROFILE/);
  assert.match(rendererSource, /front_review_meshes = \[/);
  assert.doesNotMatch(rendererSource, /Rangmahal|Andarmahal|RoofDeck|Site_/);
  const profile = JSON.parse(await readFile(new URL("../data/heritage/rangmahal-render-review-profile.json", import.meta.url), "utf8"));
  assert.equal(profile.profileId, "rangmahal-south-facade-review");
  assert.ok(profile.frontView.includeNodeNames.includes("Portico_S"));
  assert.ok(profile.excludeNodeNamePrefixes.includes("Site_"));
});

test("uses all non-excluded meshes for generic whole-model views and lets a profile scope only the front view", () => {
  assert.match(rendererSource, /profileId": "generic-whole-model-v1"/);
  assert.match(rendererSource, /for obj in meshes:[\s\S]*if obj not in front_review_meshes:[\s\S]*obj\.hide_render = True/);
  assert.match(rendererSource, /view_framing = "whole-model"/);
  assert.match(rendererSource, /front_view_framing = front_profile\["framingLabel"\]/);
  assert.doesNotMatch(rendererSource, /focus_rangmahal/);
});
test("uses the candidate GLB's explicit front bearing and keeps a legacy fallback", () => {
  assert.match(rendererSource, /def read_front_facing_azimuth\(model_path\):/);
  assert.match(rendererSource, /front_azimuth = read_front_facing_azimuth\(model_path\)/);
  assert.match(rendererSource, /if front_azimuth is None:[\s\S]*front_axis_source = "renderer-default"/);
  assert.match(rendererSource, /front_axis_source = "glb-extras\.frontFacingAzimuthDegrees"/);
  assert.match(rendererSource, /frontFacingAzimuthDegrees/);
  assert.match(rendererSource, /sin_bearing \* math\.cos\(front_elevation\)/);
  assert.match(rendererSource, /frontAxisSource/);
});

test("keeps the five orthographic views and eight turntable views in the renderer", () => {
  for (const view of ["front", "back", "left", "right", "top"]) {
    assert.ok(rendererSource.includes('"' + view + '"'), "missing orthographic view " + view);
  }
  assert.match(rendererSource, /for angle in range\(0, 360, 45\)/);
  assert.match(rendererSource, /"turntable-" \+ str\(angle\)\.zfill\(3\)/);
});

test("parses a bounded timeout without changing deterministic render defaults", () => {
  assert.deepEqual(parseRenderOptions([], {}), { resolution: 1024, blender: "blender", timeoutMs: 600000 });
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

test("renders a calibrated source photo camera from its pose, focal lengths, principal point and image size", () => {
  assert.match(rendererSource, /def render_source_camera\(opts, meshes, scene, output_dir, dimensions, center\):/);
  assert.match(cameraSetupSource, /camera_data\.lens = fx \* camera_data\.sensor_width \/ width/);
  assert.match(cameraSetupSource, /camera_data\.shift_x = \(cx - \(width - 1\.0\) \/ 2\.0\) \/ -width/);
  assert.match(cameraSetupSource, /camera_data\.shift_y = \(\(cy - \(height - 1\.0\) \/ 2\.0\) \/ width\) \* pixel_aspect_ratio/);
  assert.match(cameraSetupSource, /camera\.rotation_quaternion = Quaternion\(\(quaternion\[0\], quaternion\[1\], quaternion\[2\], quaternion\[3\]\)\)/);
  assert.match(cameraSetupSource, /if fx > fy:/);
  assert.match(cameraSetupSource, /elif fx < fy:/);
  assert.match(cameraSetupSource, /scene\.render\.pixel_aspect_x = pixel_aspect_x/);
  assert.match(cameraSetupSource, /scene\.render\.pixel_aspect_y = pixel_aspect_y/);
  assert.match(cameraSetupSource, /scene\.render\.resolution_x = width/);
  assert.match(cameraSetupSource, /scene\.render\.resolution_y = height/);
  assert.match(rendererSource, /sourceCameraView/);
  assert.doesNotMatch(cameraSetupSource, /projected_ortho_scale/);
});

test("keeps source-camera evidence separate and blocks stale or unverified pairs", async () => {
  const wrapper = await readFile(new URL("../scripts/render-building-review-views.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /assessSourceCameraForRender/);
  assert.match(wrapper, /sourceImageSha256: sha256\(sourceImageBytes\)/);
  assert.match(wrapper, /sourceImageSize: rasterDimensions\(sourceImageBytes, sourceImagePath\)/);
  assert.match(wrapper, /source-camera-render-manifest\.json/);
  assert.match(wrapper, /sourceCameraReport\?\.sameCameraComparable === false/);
  assert.match(wrapper, /blender-source-camera-error:/);
  assert.match(rendererSource, /errorMessage": str\(error\)\[:1000\]/);
  assert.match(rendererSource, /luminanceStandardDeviation.*< 0\.01/);
  assert.match(rendererSource, /source-camera-render-has-no-visible-geometry-content/);
  assert.match(wrapper, /pixelStatistics: sourceCameraView\.pixelStatistics/);
  assert.match(rendererSource, /camera_data = camera\.data[\s\S]*bpy\.data\.objects\.remove\(camera, do_unlink=True\)[\s\S]*bpy\.data\.cameras\.remove\(camera_data\)/);
  assert.match(wrapper, /--source-camera, --source-image, --calibration-evidence and --frame-alignment-evidence must be supplied together/);
});

test("terminates a stalled Blender process and never promotes its partial output", async () => {
  const wrapper = await readFile(new URL("../scripts/render-building-review-views.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /timeout: timeoutMs/);
  assert.match(wrapper, /result\.error\.code === "ETIMEDOUT"/);
  assert.match(wrapper, /no render set is accepted/);
});

test("validates and forwards an optional review profile, while generic mode stays the default", async () => {
  const wrapper = await readFile(new URL("../scripts/render-building-review-views.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /singleFlag\("review-profile"\)/);
  assert.match(wrapper, /validateRenderReviewProfile\(parsedProfile\)/);
  assert.match(wrapper, /--review-profile-json/);
  assert.match(wrapper, /--review-profile-sha256/);
});