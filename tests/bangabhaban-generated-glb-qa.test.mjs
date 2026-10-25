import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function parseGlb(bytes, label) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, label + " magic");
  assert.equal(bytes.readUInt32LE(4), 2, label + " version");
  assert.equal(bytes.readUInt32LE(8), bytes.length, label + " declared length");
  const jsonLength = bytes.readUInt32LE(12);
  assert.equal(bytes.readUInt32LE(16), 0x4e4f534a, label + " JSON chunk");
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
}
test("Bangabhaban LOD1/2/3 pass structural GLB and zero-degenerate-triangle QA", async () => {
  for (const lod of [1, 2, 3]) {
    const label = "LOD" + lod;
    const bytes = await readFile(path.join(root, "public/models/bangabhaban-lod" + lod + ".glb"));
    const report = analyzeGlbQuality(bytes), gltf = parseGlb(bytes, label);
    assert.equal(report.valid, true);
    assert.equal(report.format, "glb");
    assert.ok(report.counts.meshCount >= 12);
    assert.ok(report.counts.triangleCount > 1500);
    assert.equal(report.counts.degenerateTriangleCount, 0);
    assert.ok(report.bounds.dimensions.every(value => Number.isFinite(value) && value > 0));
    assert.equal((gltf.images || []).length, 0);
    assert.equal((gltf.textures || []).length, 0);
    assert.ok(report.warnings.includes("no-texture-atlas-embedded-or-declared"));
    const plinth = gltf.nodes.find(node => node.name === "Plinth");
    assert.ok(plinth, "semantic Plinth node is required");
    const details = report.meshDetails.find(d => d.meshIndex === plinth.mesh && d.primitiveIndex === 0);
    assert.ok(details?.topology?.topologyAnalyzed);
    assert.equal(details.topology.connectedComponentCount, 1);
    assert.equal(details.topology.boundaryEdgeCount, 0);
    assert.equal(details.topology.nonManifoldEdgeCount, 0);
  }
});
test("default Bangabhaban GLB is byte-identical to LOD3 and manifest pins the GLB hash", async () => {
  const lod3 = await readFile(path.join(root, "public/models/bangabhaban-lod3.glb"));
  const primary = await readFile(path.join(root, "public/models/bangabhaban.glb"));
  assert.deepEqual(primary, lod3);
  const manifest = JSON.parse(await readFile(path.join(root, "public/models/bangabhaban.manifest.json"), "utf8"));
  assert.equal(manifest.entries[0].publicationEligible, false);
  assert.equal(manifest.entries[0].status, "provisional-visual-proxy-not-survey-verified");
  assert.equal(manifest.entries[0].assets.lod3.sha256, createHash("sha256").update(lod3).digest("hex"));
});
