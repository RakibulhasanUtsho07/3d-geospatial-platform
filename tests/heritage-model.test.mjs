import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AHSAN_MANZIL_LOD_THRESHOLDS, AHSAN_MANZIL_CAMERA_TARGET, AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET, AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS, AHSAN_MANZIL_CAMERA_RANGE_METERS, AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS, AHSAN_MANZIL_ORBIT_PITCH_DEGREES, AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND, AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS, AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS, selectAhsanManzilLod } from "../src/core/geospatial/heritage-landmarks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredNodes = [
  "Plinth", "Rangmahal_GF", "Rangmahal_FF", "Portico_S", "Portico_N",
  "Stair_S", "Veranda_S", "Veranda_N", "Parapet", "Dome_Drum", "Dome",
  "Finial", "Andarmahal",
];

async function readGlbNodes(relativePath) {
  const bytes = await readFile(path.join(root, relativePath));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, relativePath + " GLB magic");
  assert.equal(bytes.readUInt32LE(4), 2, relativePath + " GLB version");
  assert.equal(bytes.readUInt32LE(8), bytes.length, relativePath + " total length");
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, relativePath + " JSON chunk type");
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  return gltf.nodes.map((node) => node.name);
}

test("heritage parameter config tags values and preserves the verified dome peak", async () => {
  const config = JSON.parse(await readFile(path.join(root, "data/heritage/ahsan-manzil.parameters.json"), "utf8"));
  assert.equal(config.parameters.dome.peakHeight.value, 27.13);
  assert.equal(config.parameters.dome.peakHeight.confidence, "[V]");
  for (const section of Object.values(config.parameters)) {
    for (const parameter of Object.values(section)) {
      assert.ok(parameter && typeof parameter === "object");
      assert.ok("value" in parameter && "confidence" in parameter);
      assert.ok(["[V]", "[C]", "[E]", "[?]"].includes(parameter.confidence));
    }
  }
  assert.deepEqual(config.requiredNodeNames, requiredNodes);
});

test("LOD1, LOD2 and LOD3 are valid GLBs with all required named nodes", async () => {
  for (const lod of [1, 2, 3]) {
    const nodes = await readGlbNodes("public/models/ahsan-manzil-lod" + lod + ".glb");
    for (const required of requiredNodes) {
      assert.ok(nodes.includes(required), "LOD" + lod + " is missing " + required);
    }
    for (const contextNode of [
      "Site_Ground", "Site_River", "Site_Approach", "Site_Pond",
      "Site_Family_Mosque", "Site_Stable", "Site_Trees", "Site_Context_Blocks",
    ]) {
      assert.ok(nodes.includes(contextNode), "LOD" + lod + " is missing reference scene context " + contextNode);
    }
  }
});

test("Ahsan Manzil uses the corrected riverfront and stepped footprint geometry", async () => {
  const builder = await readFile(path.join(root, "scripts/build-ahsan-manzil-model.mjs"), "utf8");
  assert.ok(builder.includes("const rangLength = DIM.rangmahalLength;"));
  assert.ok(builder.includes("const split = xMin + andarLength;"));
  assert.ok(builder.includes("const domeX = (split + xMax) / 2;"));
  assert.ok(builder.includes("const stairTopZ = half + 2.7;"));
  assert.ok(builder.includes("The projecting triple-arched portico is an open"));
  assert.ok(builder.includes("Recessed timber door with an arched glazed head"));
  assert.ok(builder.includes('addFacadeSection("Andarmahal",xMin,split,andarBays,[andarGf,andarFf],lod,andarCenterZ,andarDepth);'));
  assert.ok(builder.includes('addEndFacade("Andarmahal", xMin, -1, [andarGf, andarFf], 6, lod,andarCenterZ,andarDepth);'));
  assert.ok(builder.includes("function fillRectLouverWindow("));
  assert.ok(builder.includes('"#45674D"'), "LOD3 facade includes green shutter details from the reference scene");
  assert.ok(builder.includes("Upper-storey triple-arched loggia."));
  assert.ok(builder.includes("Eight open arched bays"));
  assert.ok(builder.includes("addFacadeDisk("));
  assert.ok(builder.includes("const stairBaseWidth = DIM.stairWidth;"));
  assert.ok(builder.includes("const riserCenter=(riserBottom+riserTop)/2;"));
  assert.ok(builder.includes('box(stair,domeX,riserCenter,z,width,rise,stepDepth,"stair")'));
  assert.ok(builder.includes('box(stair,domeX,riserTop-.018,z+stepDepth*.32,width,.036,stepDepth*.16,"trim")'));
  assert.ok(!builder.includes('box(stair,domeX,top/2,z,width,top,stepDepth,"stair")'));
  assert.ok(builder.includes("Upper veranda balustrades"));
  assert.ok(builder.includes("const andarRoofTop=andarFf.base+andarFf.height+DIM.slab;"));
  assert.ok(builder.includes("Align decorative rings with the actual lotus-bud profile samples"));
  assert.ok(builder.includes("A restrained central keystone"), "LOD3 adds arch keystones and impost blocks");
  assert.ok(builder.includes("Dome meridian ribs"), "LOD3 adds deterministic profile-following dome ribs");
  assert.ok(builder.includes("north/rear veranda is split"));
  const config = JSON.parse(await readFile(path.join(root, "data/heritage/ahsan-manzil.parameters.json"), "utf8"));
  assert.equal(config.parameters.facade.pedimentPeakHeightAboveGround.value, 15.2);
  assert.equal(config.parameters.facade.gfOpeningWidth.value, 1.65);
  assert.equal(config.parameters.facade.gfOpeningCrownHeight.value, 3.8);
  assert.equal(config.parameters.facade.ffOpeningWidth.value, 2.0);
  assert.equal(config.parameters.facade.ffOpeningCrownHeight.value, 5.3);
  assert.ok(config.parameters.vertical.firstFloorClearHeight.value - config.parameters.facade.ffOpeningCrownHeight.value <= 0.6,
    "upper-storey arch crown stays close to the cornice to prevent an oversized blank spandrel band");
  assert.equal(config.parameters.footprint.rangmahalBlockLength.value, 55.8);
  assert.equal(config.parameters.footprint.andarmahalBlockLength.value, 69.6);
  assert.equal(config.parameters.footprint.exteriorBayCount.value, 15);
  assert.equal(config.parameters.footprint.andarmahalDepth.value, 14.375);
  assert.equal(config.parameters.footprint.andarmahalNorthOffset.value, -7.1875);
  assert.equal(config.parameters.footprint.andarmahalBayCount.value, 8);
  assert.equal(config.parameters.facade.porticoWidth.value, 18.6);
  assert.equal(config.parameters.stair.width.value, 39);
  assert.equal(config.parameters.stair.topWidth.value, 18.6);
  assert.equal(config.parameters.stair.stepCount.value, 28);
  assert.equal(config.parameters.stair.riserHeight.value, 0.2285714286);
  assert.equal(config.parameters.stair.treadDepth.value, 0.5714285714);
  assert.equal(config.parameters.stair.runLength.value, 16);
  assert.equal(config.parameters.vertical.andarmahalHeightScale.value, 0.94);
  assert.ok(Math.abs(config.parameters.stair.stepCount.value * config.parameters.stair.riserHeight.value - 6.4) < 0.00001);
  assert.ok(Math.abs(config.parameters.stair.stepCount.value * config.parameters.stair.treadDepth.value - 16) < 0.00001);
  const domeRings = config.parameters.dome.profileRings.value;
  assert.equal(domeRings[0][0], 6.9, "dome base radius nearly matches the 7 m drum radius");
  assert.equal(domeRings[2][0], 6.8, "dome keeps a full rounded lower shoulder instead of pinching into a cone");
  assert.ok(domeRings[6][0] > 4.8, "upper-mid dome remains full before narrowing toward the finial");
  assert.equal(domeRings[domeRings.length - 1][1], 6.53, "dome body profile height fits its peak-height budget");
  assert.ok(Math.abs(domeRings[0][0] * 2 - config.parameters.dome.drumWidth.value) <= 0.2);
  assert.equal(config.parameters.materials.facadePink.value, "#E1917D");
  assert.equal(config.parameters.materials.trimOffWhite.value, "#ECAE9B");
  assert.equal(config.parameters.materials.stairStone.value, "#6E625A");
  assert.equal(config.parameters.materials.doorWood.value, "#6B4A32");
  assert.equal(config.parameters.materials.glass.value, "#392B27");
  assert.equal(config.parameters.dome.drumOpeningCount.value, 8);
  assert.equal(config.parameters.dome.drumOpeningWidth.value, 2.7);
  assert.equal(config.parameters.runtimeCamera.frontFocusOffsetEastMeters.value, 34.8);
  assert.equal(config.parameters.runtimeCamera.frontCameraRangeMeters.value, AHSAN_MANZIL_CAMERA_RANGE_METERS);
  assert.equal(config.parameters.runtimeCamera.frontCameraRangeMeters.value, 112);
  assert.equal(config.parameters.runtimeCamera.footprintCameraRangeMeters.value, AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS);
  assert.equal(config.parameters.runtimeCamera.orbitPitchDegrees.value, AHSAN_MANZIL_ORBIT_PITCH_DEGREES);
  assert.equal(config.parameters.runtimeCamera.orbitDegreesPerSecond.value, AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND);
  assert.equal(config.parameters.runtimeCamera.frontBoundingSphereRadiusMeters.value, AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS);
  assert.equal(config.parameters.runtimeCamera.footprintBoundingSphereRadiusMeters.value, AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS);
});

test("the map opens in Dhaka building coverage and retains explicit heritage camera controls", async () => {
  const landmarks = await readFile(path.join(root, "src/core/geospatial/heritage-landmarks.mjs"), "utf8");
  assert.ok(landmarks.includes("AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS"));
  assert.match(landmarks, /AHSAN_MANZIL_ANCHOR_LONGITUDE = 90\.40606/);
  assert.match(landmarks, /AHSAN_MANZIL_ANCHOR_LATITUDE = 23\.70860/);
  assert.match(landmarks, /longitude: 90\.40606/);
  assert.match(landmarks, /anchorConfidence: "\[C\]"/);
  assert.equal(AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS, 34.8);
  assert.ok(AHSAN_MANZIL_CAMERA_TARGET.longitude > AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.longitude);
  assert.ok(AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS >= 48);
  assert.ok(AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS < AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS + 62.7);
  assert.equal(Number(((AHSAN_MANZIL_CAMERA_TARGET.longitude - AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.longitude) * 111319.49 * Math.cos((23.7086 * Math.PI) / 180)).toFixed(1)), 34.8);

  const adapter = await readFile(path.join(root, "src/core/map-engine/cesium-adapter.ts"), "utf8");
  const cameraController = await readFile(path.join(root, "src/core/map-engine/heritage-camera-controller.ts"), "utf8");
  assert.ok(adapter.includes("focusAhsanManzil(durationMs = 1200)"));
  assert.ok(adapter.includes("focusAhsanManzilWhole(durationMs = 900)"));
  assert.ok(adapter.includes("focusAhsanManzilTopDown(durationMs = 850)"));
  assert.ok(adapter.includes("focusAhsanManzilRear(durationMs = 850)"));
  assert.ok(adapter.includes("focusAhsanManzilSide(durationMs = 850)"));
  assert.ok(adapter.includes("startAhsanManzilOrbitTour(onStopped?: () => void): void"));
  assert.ok(cameraController.includes("DEFAULT_DHAKA_MAP_CAMERA.longitude"));
  assert.ok(cameraController.includes("DEFAULT_DHAKA_MAP_CAMERA.latitude"));
  assert.ok(cameraController.includes("DEFAULT_DHAKA_MAP_CAMERA.rangeMeters"));
  assert.ok(cameraController.includes("AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET.longitude"));
  assert.ok(cameraController.includes("AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS"));
  assert.ok(adapter.includes("stopAhsanManzilOrbitTour(): void"));
  assert.ok(cameraController.includes("if (wasActive) callback?.();"));
  assert.ok(adapter.includes("orbitAhsanManzil(stepDegrees: number)"));
  assert.ok(cameraController.includes('this.flyToLandmark(650, "footprint")'));
  assert.ok(cameraController.includes("flyToBoundingSphere"));
  assert.ok(cameraController.includes("AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS"));
  assert.ok(cameraController.includes("AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS"));
  assert.ok(cameraController.includes("AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND"));
  assert.match(adapter, /ahsan-manzil-lod3\.glb/);
  assert.match(adapter, /Shat Gombuj Mosque/);
  assert.ok(adapter.includes("ahsan-manzil.manifest.json"));

  const manifest = JSON.parse(await readFile(path.join(root, "public/models/ahsan-manzil.manifest.json"), "utf8"));
  const entry = manifest.entries.find((item) => item.id === "ahsan-manzil-kumartuli-dhaka");
  assert.equal(entry.assets.default.uri, "/models/ahsan-manzil-lod3.glb");
  assert.deepEqual(entry.nodes, requiredNodes);

  const mapCanvas = await readFile(path.join(root, "src/features/map/components/MapCanvas.tsx"), "utf8");
  const controls = await readFile(path.join(root, "src/features/map/components/MapControls.tsx"), "utf8");
  assert.ok(
    !mapCanvas.includes("engine.focusAhsanManzil(650)"),
    "initialization must preserve the Dhaka property-discovery camera instead of auto-flying to the out-of-coverage heritage anchor",
  );
  assert.ok(mapCanvas.includes("engine.focusAhsanManzil(1100)"));
  assert.ok(mapCanvas.includes("engine.focusAhsanManzilWhole(900)"));
  assert.ok(mapCanvas.includes("engine.focusAhsanManzilTopDown(850)"));
  assert.ok(mapCanvas.includes("engine.focusAhsanManzilRear(850)"));
  assert.ok(mapCanvas.includes("engine.focusAhsanManzilSide(850)"));
  assert.ok(mapCanvas.includes("engine.startAhsanManzilOrbitTour(() => setOrbitTourActive(false))"));
  assert.ok(mapCanvas.includes("engine.stopAhsanManzilOrbitTour()"));
  assert.ok(mapCanvas.includes("onRotateLeft={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(-15); }}"));
  assert.ok(mapCanvas.includes("onRotateRight={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(15); }}"));
  assert.ok(mapCanvas.includes("onOrbitLeft={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(-45); }}"));
  assert.ok(mapCanvas.includes("onOrbitRight={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(45); }}"));
  assert.ok(controls.includes("Full model"));
  assert.ok(controls.includes("Top view"));
  assert.ok(controls.includes("Rear"));
  assert.ok(controls.includes("Side"));
  assert.ok(controls.includes("360° tour"));
  assert.ok(controls.includes("Stop tour"));
  assert.ok(adapter.includes("selectAhsanManzilLod"));
  assert.ok(adapter.includes("forwardAxis: Cesium.Axis.Z"));
});
test("camera-distance LOD selection follows tagged rendering thresholds", async () => {
  const config = JSON.parse(await readFile(path.join(root, "data/heritage/ahsan-manzil.parameters.json"), "utf8"));
  const p = config.parameters.runtimeLod;
  assert.equal(p.lod1MaxDistance.value, AHSAN_MANZIL_LOD_THRESHOLDS.lod1.maxDistanceMeters);
  assert.equal(p.lod1MaxCameraHeight.value, AHSAN_MANZIL_LOD_THRESHOLDS.lod1.maxCameraHeightMeters);
  assert.equal(p.lod2MaxDistance.value, AHSAN_MANZIL_LOD_THRESHOLDS.lod2.maxDistanceMeters);
  assert.equal(p.lod2MaxCameraHeight.value, AHSAN_MANZIL_LOD_THRESHOLDS.lod2.maxCameraHeightMeters);
  assert.equal(p.lod3MaxDistance.value, AHSAN_MANZIL_LOD_THRESHOLDS.lod3.maxDistanceMeters);
  assert.equal(p.lod3MaxCameraHeight.value, AHSAN_MANZIL_LOD_THRESHOLDS.lod3.maxCameraHeightMeters);
  assert.equal(selectAhsanManzilLod(400, 250), 3);
  assert.equal(selectAhsanManzilLod(4_000, 6_000), 2);
  assert.equal(selectAhsanManzilLod(10_000, 18_000), 1);
  assert.equal(selectAhsanManzilLod(20_000, 1_000), null);
  assert.equal(selectAhsanManzilLod(-1, 100), null);
});


test("Blender front review view prioritizes the facade over the roof deck", async () => {
  const renderer = await readFile(path.join(root, "scripts/blender/render-building-review.py"), "utf8");
  assert.ok(renderer.includes('("front", Vector((0.0, -0.990268, 0.139173)), "ORTHO")'));
  assert.ok(renderer.includes("Low-angle (~8 degree) south-elevation camera prioritizes the facade."));
  assert.ok(renderer.includes('background.inputs["Strength"].default_value = 0.45'));
  assert.ok(renderer.includes("max_dimension * max_dimension * 29.0"));
  assert.ok(renderer.includes("light_power * 0.33, light_size * 1.05"));
  assert.ok(renderer.includes("light_power * 0.38, light_size"));
  assert.ok(renderer.includes('("turntable-" + str(angle).zfill(3), direction, "ORTHO")'));
  assert.ok(renderer.includes("def projected_ortho_scale("), "review views fit to their projected geometry bounds");
  assert.ok(renderer.includes("original_render_visibility"), "renderer restores whole-model visibility for each view");
  assert.ok(renderer.includes("if obj not in rangmahal_review_meshes:"), "front-detail view excludes off-facade meshes");
  assert.ok(renderer.includes('view_framing = "rangmahal-south-facade-focused"'));
  assert.ok(renderer.includes("view_scale = projected_ortho_scale(visible_meshes, view_center, direction)"));
});
