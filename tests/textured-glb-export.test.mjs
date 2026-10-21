import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { buildTexturedGlb } from "../src/core/building-generation/textured-glb-export.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function pngRgba(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x++) {
      const at = row + 1 + x * 4;
      rows[at] = 80 + ((x * 7 + y) % 150);
      rows[at + 1] = 65 + ((y * 9 + x) % 160);
      rows[at + 2] = 50 + ((x + y * 3) % 180);
      rows[at + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const atlasBytes = pngRgba(32, 32);
const atlasSha256 = digest(atlasBytes);

const mesh = {
  vertices: [
    { id: "a", position: [0, 0, 0] },
    { id: "b", position: [2, 0, 0] },
    { id: "c", position: [0, 2, 0] },
    { id: "d", position: [0, 0, 2] },
  ],
  triangles: [
    { vertices: ["a", "b", "c"] },
    { vertices: ["a", "d", "b"] },
  ],
};

const faces = [
  { vertices: ["a", "b", "c"], uv: [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9]] },
  { vertices: ["a", "b", "d"], uv: [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9]] },
];

test("exports a self-contained GLB 2.0 with embedded atlas, normals, UVs and material binding", () => {
  const built = buildTexturedGlb({
    mesh,
    faces,
    atlasBytes,
    atlasWidth: 32,
    atlasHeight: 32,
    atlasSha256,
  });
  assert.equal(built.buffer.readUInt32LE(0), 0x46546c67);
  assert.equal(built.buffer.readUInt32LE(4), 2);
  assert.equal(built.buffer.readUInt32LE(8), built.buffer.length);
  const jsonLength = built.buffer.readUInt32LE(12);
  const gltf = JSON.parse(built.buffer.toString("utf8", 20, 20 + jsonLength).trim());
  assert.equal(gltf.asset.version, "2.0");
  assert.equal(gltf.images.length, 1);
  assert.equal(gltf.images[0].mimeType, "image/png");
  assert.equal(typeof gltf.images[0].bufferView, "number");
  assert.equal(gltf.images[0].uri, undefined);
  assert.equal(gltf.buffers[0].uri, undefined);
  assert.equal(gltf.materials[0].pbrMetallicRoughness.baseColorTexture.index, 0);
  assert.deepEqual(Object.keys(gltf.meshes[0].primitives[0].attributes).sort(), ["NORMAL", "POSITION", "TEXCOORD_0"]);
  assert.equal(built.report.texturedTriangleCount, 2);
  assert.equal(built.report.untexturedTriangleCount, 0);
  assert.equal(built.report.externalUrisUsed, false);

  const qa = reviewGlbTextureBindings(built.buffer, {
    expectedAtlas: { sha256: atlasSha256, width: 32, height: 32 },
  });
  assert.equal(qa.valid, true, JSON.stringify(qa.errors));
  assert.equal(qa.counts.imageCount, 1);
  assert.equal(qa.counts.texturedPrimitiveCount, 1);
  assert.equal(qa.images[0].sha256, atlasSha256);
});

test("reports uncovered mesh triangles instead of inventing texture evidence", () => {
  const built = buildTexturedGlb({
    mesh,
    faces: faces.slice(0, 1),
    atlasBytes,
    atlasWidth: 32,
    atlasHeight: 32,
    atlasSha256,
  });
  assert.equal(built.report.status, "partial-textured-mesh");
  assert.equal(built.report.texturedTriangleCount, 1);
  assert.equal(built.report.untexturedTriangleCount, 1);
  assert.equal(built.report.omittedTriangleKeys.length, 1);
});

test("rejects atlas hash/dimension mismatches and malformed face UVs", () => {
  assert.throws(() => buildTexturedGlb({
    mesh, faces, atlasBytes, atlasWidth: 32, atlasHeight: 32, atlasSha256: "0".repeat(64),
  }), /SHA-256/);
  assert.throws(() => buildTexturedGlb({
    mesh, faces, atlasBytes, atlasWidth: 16, atlasHeight: 32, atlasSha256,
  }), /dimensions/);
  assert.throws(() => buildTexturedGlb({
    mesh,
    faces: [{ vertices: ["a", "b", "c"], uv: [[0, 0], [1.2, 0], [0, 1]] }],
    atlasBytes,
    atlasWidth: 32,
    atlasHeight: 32,
    atlasSha256,
  }), /normalized finite UV/);
});
