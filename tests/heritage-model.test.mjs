import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AHSAN_MANZIL_LOD_THRESHOLDS, selectAhsanManzilLod } from "../src/core/geospatial/heritage-landmarks.mjs";

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

test("the map opens at Ahsan Manzil and retains both heritage landmark anchors", async () => {
  const landmarks = await readFile(path.join(root, "src/core/geospatial/heritage-landmarks.mjs"), "utf8");
  assert.match(landmarks, /export const AHSAN_MANZIL_CAMERA_TARGET/);
  assert.match(landmarks, /longitude: 90\.40606/);
  assert.match(landmarks, /latitude: 23\.70860/);
  assert.match(landmarks, /longitude: 89\.7417917/);
  assert.match(landmarks, /latitude: 22\.6744861/);
  assert.match(landmarks, /anchorConfidence: "\[C\]"/);
  const adapter = await readFile(path.join(root, "src/core/map-engine/cesium-adapter.ts"), "utf8");
  assert.match(adapter, /const INITIAL_CAMERA = AHSAN_MANZIL_CAMERA/);
  assert.match(adapter, /ahsan-manzil-lod3\.glb/);
  assert.match(adapter, /Shat Gombuj Mosque/);
  assert.ok(adapter.includes("ahsan-manzil.manifest.json"));
  const manifest = JSON.parse(await readFile(path.join(root, "public/models/ahsan-manzil.manifest.json"), "utf8"));
  const entry = manifest.entries.find((item) => item.id === "ahsan-manzil-kumartuli-dhaka");
  assert.equal(entry.assets.default.uri, "/models/ahsan-manzil-lod3.glb");
  assert.deepEqual(entry.nodes, requiredNodes);
  const mapCanvas = await readFile(path.join(root, "src/features/map/components/MapCanvas.tsx"), "utf8");
  const controls = await readFile(path.join(root, "src/features/map/components/MapControls.tsx"), "utf8");
  assert.ok(mapCanvas.includes("function goToAhsanManzil()"));
  assert.ok(mapCanvas.includes("AHSAN_MANZIL_CAMERA_TARGET"));
  assert.ok(mapCanvas.includes("function goHomeToAhsanManzil()"));
  assert.ok(mapCanvas.includes("Loading Ahsan Manzil 3D map"));
  assert.ok(controls.includes("Fly to Ahsan Manzil"));
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
