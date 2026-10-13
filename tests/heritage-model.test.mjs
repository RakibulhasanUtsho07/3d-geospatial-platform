import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AHSAN_MANZIL_LOD_THRESHOLDS, AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS, AHSAN_MANZIL_CAMERA_RANGE_METERS, AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS, AHSAN_MANZIL_ORBIT_PITCH_DEGREES, AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND, AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS, AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS, selectAhsanManzilLod } from "../src/core/geospatial/heritage-landmarks.mjs";

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
  }
});

test("Ahsan Manzil uses the corrected riverfront and stepped footprint geometry", async () => {
  const builder = await readFile(path.join(root, "scripts/build-ahsan-manzil-model.mjs"), "utf8");
  assert.ok(builder.includes("const rangLength=DIM.rangmahalLength, split=0, domeX=(split+xMax)/2;"));
  assert.ok(builder.includes('addFacadeSection("Andarmahal",xMin,split,andarBays,[gf,ff],lod,andarCenterZ,andarDepth);'));
  assert.ok(builder.includes('addEndFacade("Andarmahal", xMin, -1, [gf, ff], 6, lod,andarCenterZ,andarDepth);'));
  assert.ok(builder.includes("function fillRectLouverWindow("));
  assert.ok(builder.includes("Upper-storey triple-arched loggia."));
  assert.ok(builder.includes("Eight open arched bays"));
  assert.ok(builder.includes("addFacadeDisk("));
  assert.ok(builder.includes("const stairBaseWidth = DIM.stairWidth;"));
  assert.ok(builder.includes('box(stair,domeX,top/2,z,width,top,stepDepth,"stair")'));
  assert.ok(builder.includes("Upper veranda balustrades"));
  const config = JSON.parse(await readFile(path.join(root, "data/heritage/ahsan-manzil.parameters.json"), "utf8"));
  assert.equal(config.parameters.facade.pedimentPeakHeightAboveGround.value, 15.2);
  assert.equal(config.parameters.footprint.rangmahalBlockLength.value, 62.7);
  assert.equal(config.parameters.footprint.andarmahalBlockLength.value, 62.7);
  assert.equal(config.parameters.footprint.exteriorBayCount.value, 15);
  assert.equal(config.parameters.footprint.andarmahalDepth.value, 14.375);
  assert.equal(config.parameters.footprint.andarmahalNorthOffset.value, -7.1875);
  assert.equal(config.parameters.footprint.andarmahalBayCount.value, 8);
  assert.equal(config.parameters.facade.porticoWidth.value, 20);
  assert.equal(config.parameters.stair.width.value, 16.5);
  assert.equal(config.parameters.stair.topWidth.value, 13.5);
  assert.equal(config.parameters.stair.stepCount.value, 28);
  assert.equal(config.parameters.stair.riserHeight.value, 0.23);
  assert.equal(config.parameters.stair.treadDepth.value, 0.57);
  assert.equal(config.parameters.materials.facadePink.value, "#E1917D");
  assert.equal(config.parameters.materials.trimOffWhite.value, "#E99C8A");
  assert.equal(config.parameters.materials.stairStone.value, "#6E625A");
  assert.equal(config.parameters.materials.doorWood.value, "#6B4A32");
  assert.equal(config.parameters.dome.drumOpeningWidth.value, 2.7);
  assert.equal(config.parameters.runtimeCamera.frontFocusOffsetEastMeters.value, 31.35);
  assert.equal(config.parameters.runtimeCamera.frontCameraRangeMeters.value, AHSAN_MANZIL_CAMERA_RANGE_METERS);
  assert.equal(config.parameters.runtimeCamera.footprintCameraRangeMeters.value, AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS);
  assert.equal(config.parameters.runtimeCamera.orbitPitchDegrees.value, AHSAN_MANZIL_ORBIT_PITCH_DEGREES);
  assert.equal(config.parameters.runtimeCamera.orbitDegreesPerSecond.value, AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND);
  assert.equal(config.parameters.runtimeCamera.frontBoundingSphereRadiusMeters.value, AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS);
  assert.equal(config.parameters.runtimeCamera.footprintBoundingSphereRadiusMeters.value, AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS);
});

test("the map opens on the river-facing facade and provides whole-footprint and guided-orbit views", async () => {
  const landmarks = await readFile(path.join(root, "src/core/geospatial/heritage-landmarks.mjs"), "utf8");
  assert.ok(landmarks.includes("AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS"));
  assert.match(landmarks, /AHSAN_MANZIL_ANCHOR_LONGITUDE = 90\.40606/);
  assert.match(landmarks, /AHSAN_MANZIL_ANCHOR_LATITUDE = 23\.70860/);
  assert.match(landmarks, /longitude: 90\.40606/);
  assert.match(landmarks, /anchorConfidence: "\[C\]"/);
  assert.equal(AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS, 31.35);

  const adapter = await readFile(path.join(root, "src/core/map-engine/cesium-adapter.ts"), "utf8");
  assert.ok(adapter.includes("focusAhsanManzil(durationMs = 1200)"));
  assert.ok(adapter.includes("focusAhsanManzilTopDown(durationMs = 850)"));
  assert.ok(adapter.includes("startAhsanManzilOrbitTour(): void"));
  assert.ok(adapter.includes("stopAhsanManzilOrbitTour(): void"));
  assert.ok(adapter.includes("orbitAhsanManzil(stepDegrees: number)"));
  assert.ok(adapter.includes("flyToBoundingSphere"));
  assert.ok(adapter.includes("AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS"));
  assert.ok(adapter.includes("AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS"));
  assert.ok(adapter.includes("AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND"));
  assert.match(adapter, /ahsan-manzil-lod3\.glb/);
  assert.match(adapter, /Shat Gombuj Mosque/);
  assert.ok(adapter.includes("ahsan-manzil.manifest.json"));

  const manifest = JSON.parse(await readFile(path.join(root, "public/models/ahsan-manzil.manifest.json"), "utf8"));
  const entry = manifest.entries.find((item) => item.id === "ahsan-manzil-kumartuli-dhaka");
  assert.equal(entry.assets.default.uri, "/models/ahsan-manzil-lod3.glb");
  assert.deepEqual(entry.nodes, requiredNodes);

  const mapCanvas = await readFile(path.join(root, "src/features/map/components/MapCanvas.tsx"), "utf8");
  const controls = await readFile(path.join(root, "src/features/map/components/MapControls.tsx"), "utf8");
  assert.ok(mapCanvas.includes("engine.focusAhsanManzil(650)"));
  assert.ok(mapCanvas.includes("engine.focusAhsanManzilTopDown(850)"));
  assert.ok(mapCanvas.includes("engine.startAhsanManzilOrbitTour()"));
  assert.ok(mapCanvas.includes("engine.stopAhsanManzilOrbitTour()"));
  assert.ok(mapCanvas.includes("onRotateLeft={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(-15); }}"));
  assert.ok(mapCanvas.includes("onRotateRight={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(15); }}"));
  assert.ok(mapCanvas.includes("onOrbitLeft={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(-45); }}"));
  assert.ok(mapCanvas.includes("onOrbitRight={() => { stopOrbitTourForManualControl(); engineRef.current?.orbitAhsanManzil(45); }}"));
  assert.ok(controls.includes("Top view"));
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
