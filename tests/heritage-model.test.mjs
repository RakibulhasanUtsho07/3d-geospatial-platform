import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

test("the map camera defaults to Shat Gombuj and Ahsan Manzil uses the provisional anchor", async () => {
  const landmarks = await readFile(path.join(root, "src/core/geospatial/heritage-landmarks.mjs"), "utf8");
  assert.match(landmarks, /longitude: 89\.7417917/);
  assert.match(landmarks, /latitude: 22\.6744861/);
  assert.match(landmarks, /anchorConfidence: "\[C\]"/);
  const adapter = await readFile(path.join(root, "src/core/map-engine/cesium-adapter.ts"), "utf8");
  assert.match(adapter, /ahsan-manzil-lod3\.glb/);
  assert.match(adapter, /Shat Gombuj Mosque/);
});
