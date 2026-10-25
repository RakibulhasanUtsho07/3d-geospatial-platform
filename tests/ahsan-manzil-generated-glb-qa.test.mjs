import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readGlbJson(bytes, label) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, label + " GLB magic");
  assert.equal(bytes.readUInt32LE(4), 2, label + " GLB version");
  assert.equal(bytes.readUInt32LE(8), bytes.length, label + " declared length");
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, label + " JSON chunk");
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
}

test("all generated Ahsan Manzil LODs pass structural GLB and triangle-area QA without implying fidelity", async () => {
  for (const lod of [1, 2, 3]) {
    const label = "LOD" + lod;
    const bytes = await readFile(path.join(root, "public/models/ahsan-manzil-" + label.toLowerCase() + ".glb"));
    const report = analyzeGlbQuality(bytes);
    assert.equal(report.valid, true, label + " should be a structurally valid GLB");
    assert.equal(report.format, "glb");
    assert.ok(report.counts.meshCount >= 13, label + " should retain the semantic building nodes");
    assert.ok(report.counts.vertexCount > 1000, label + " should contain nontrivial geometry");
    assert.ok(report.counts.triangleCount > 1000, label + " should contain nontrivial triangle geometry");
    assert.equal(report.counts.degenerateTriangleCount, 0, label + " contains degenerate triangles");
    assert.equal(report.counts.degenerateTriangleRatio, 0);
    assert.ok(report.bounds.dimensions.every((value) => Number.isFinite(value) && value > 0));
    assert.ok(report.limitations.some((limitation) => limitation.includes("architectural fidelity")));
    const gltf = readGlbJson(bytes, label);
    assert.equal((gltf.images ?? []).length, 0, label + " must not silently claim embedded photo textures");
    assert.equal((gltf.textures ?? []).length, 0, label + " must not silently claim texture bindings");
    assert.ok(report.warnings.includes("no-texture-atlas-embedded-or-declared"),
      label + " should explicitly remain review-required until a texture atlas is added");
    assert.equal(report.status, "review-recommended",
      label + " must not be promoted to a clean pass while texture review is outstanding");
  }
});

test("LOD3 and the default Ahsan Manzil GLB are byte-identical", async () => {
  const lod3 = await readFile(path.join(root, "public/models/ahsan-manzil-lod3.glb"));
  const primary = await readFile(path.join(root, "public/models/ahsan-manzil.glb"));
  assert.deepEqual(primary, lod3);
});
