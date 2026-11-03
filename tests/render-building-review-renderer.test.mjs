import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseRenderOptions } from "../src/core/building-generation/render-review-options.mjs";
import { extractGlbFacadeOrientation, toBlenderCameraDirection } from "../src/core/building-generation/glb-facade-orientation.mjs";

const rendererSource = await readFile(new URL("../scripts/blender/render-building-review.py", import.meta.url), "utf8");
const cameraSetupSource = await readFile(new URL("../scripts/blender/source_camera_camera.py", import.meta.url), "utf8");

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


test("reads and applies an explicit hash-pinned review profile", () => {
  assert.match(rendererSource, /def read_review_profile\(opts\):/);
  assert.match(rendererSource, /--review-profile-sha256/);
  assert.match(rendererSource, /Explicit review profiles require a 64-character preflight SHA-256 digest/);
  assert.match(rendererSource, /expected_hash != profile_hash/);
  assert.match(rendererSource, /missing_front_names/);
  assert.match(rendererSource, /front_profile\["elevationDegrees"\]/);
  assert.match(rendererSource, /"reviewProfile": review_profile_evidence/);
});

test("preserves legacy renderer defaults while applying explicit profiles only when supplied", () => {
  assert.match(rendererSource, /profile_explicit = "--review-profile-json" in opts/);
  assert.match(rendererSource, /excluded_prefixes = \["Site_"\]/);
  assert.match(rendererSource, /if focus_rangmahal:/);
});

test("finalizes the render manifest from the Blender profile evidence without undeclared metadata", async () => {
  const wrapper = await readFile(new URL("../scripts/render-building-review-views.mjs", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../src/core/building-generation/render-review-manifest.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /raw\.reviewProfile\?\.sha256 !== reviewProfileAssessment\.sha256/);
  assert.match(manifest, /reviewProfile: rawManifest\.reviewProfile/);
  assert.doesNotMatch(wrapper, /renderProfileMetadata/);
});

function glbWithDocument(document) {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(paddedLength - json.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonChunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonChunk.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);
  return Buffer.concat([header, chunkHeader, jsonChunk]);
}

const eastFacadeMetadata = {
  schemaVersion: "1.0.0",
  coordinateFrame: "glTF-local:+X=east,+Y=up,+Z=north",
  selectionMethod: "azimuth-nearest-edge",
  edgeIndex: 1,
  requestedAzimuthDegrees: 90,
  actualAzimuthDegrees: 90,
  outwardNormal: { x: 1, z: 0 },
  confidence: "operator-specified",
  source: "buildingSpec.architecture.frontFacingAzimuthDegrees",
  reviewRequired: true,
};

test("reads validated facade orientation from GLB extras and keeps legacy assets optional", () => {
  const legacy = glbWithDocument({ asset: { version: "2.0" } });
  assert.equal(extractGlbFacadeOrientation(legacy), null);
  const glb = glbWithDocument({ asset: { version: "2.0" }, extras: { building: { facadeOrientation: eastFacadeMetadata } } });
  assert.deepEqual(extractGlbFacadeOrientation(glb), eastFacadeMetadata);
  const malformed = glbWithDocument({
    asset: { version: "2.0" },
    extras: { building: { facadeOrientation: { ...eastFacadeMetadata, outwardNormal: { x: 0, z: 1 } } } },
  });
  assert.throws(() => extractGlbFacadeOrientation(malformed), /azimuth does not match/);
});

test("maps a GLB facade normal into Blender axes without changing model coordinates", () => {
  const east = toBlenderCameraDirection(eastFacadeMetadata);
  assert.ok(Math.abs(east[0] - Math.cos(Math.PI / 36)) < 1e-8);
  assert.equal(east[1], 0);
  assert.ok(Math.abs(east[2] - Math.sin(Math.PI / 36)) < 1e-8);
  const north = toBlenderCameraDirection({
    ...eastFacadeMetadata,
    outwardNormal: { x: 0, z: 1 },
    actualAzimuthDegrees: 0,
    requestedAzimuthDegrees: 0,
  });
  assert.ok(Math.abs(north[0]) < 1e-9);
  assert.ok(north[1] < -0.99);
  assert.throws(() => toBlenderCameraDirection(eastFacadeMetadata, 61), /elevationDegrees/);
});

test("passes the embedded facade direction to Blender and records confidence and provenance", async () => {
  const wrapper = await readFile(new URL("../scripts/render-building-review-views.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /extractGlbFacadeOrientation\(modelBytes\)/);
  assert.match(wrapper, /--front-facade-direction-x/);
  assert.match(wrapper, /--front-facade-coordinate-frame/);
  assert.match(wrapper, /renderedOrientation\.source !== facadeOrientation\.source/);
  assert.match(rendererSource, /def read_facade_orientation\(opts\):/);
  assert.match(rendererSource, /Vector\(facade_orientation\["blenderCameraDirection"\]\)/);
  assert.match(rendererSource, /"facadeOrientation": facade_orientation/);
});
