import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lYsAAAAASUVORK5CYII=", "base64");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function makeGlb({ uvs = [[0,0],[1,0],[0,1]], omitUv = false, textureIndex = 0, imageUri = null } = {}) {
  const positions = Buffer.alloc(36);
  [[0,0,0],[1,0,0],[0,1,0]].flat().forEach((n,i)=>positions.writeFloatLE(n,i*4));
  const uvBytes = Buffer.alloc(uvs.length * 8);
  uvs.flat().forEach((n,i)=>uvBytes.writeFloatLE(n,i*4));
  const indices = Buffer.alloc(6);
  [0,1,2].forEach((n,i)=>indices.writeUInt16LE(n,i*2));
  const imageOffset = 68;
  const binary = Buffer.concat([positions,uvBytes,indices,Buffer.alloc(2),imageUri ? Buffer.alloc(0) : png]);
  const bufferViews = [
    { buffer:0, byteOffset:0, byteLength:positions.length, target:34962 },
    { buffer:0, byteOffset:36, byteLength:uvBytes.length, target:34962 },
    { buffer:0, byteOffset:60, byteLength:indices.length, target:34963 },
  ];
  const images = imageUri ? [{ uri:imageUri, mimeType:"image/png" }] : [{ bufferView:3, mimeType:"image/png", name:"atlas" }];
  if (!imageUri) bufferViews.push({ buffer:0, byteOffset:imageOffset, byteLength:png.length });
  const attributes = { POSITION:0 };
  if (!omitUv) attributes.TEXCOORD_0 = 1;
  const gltf = {
    asset:{version:"2.0",generator:"texture binding QA test"},
    scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    meshes:[{primitives:[{attributes,indices:2,material:0,mode:4}]}],
    accessors:[
      {bufferView:0,componentType:5126,count:3,type:"VEC3",min:[0,0,0],max:[1,1,0]},
      {bufferView:1,componentType:5126,count:uvs.length,type:"VEC2"},
      {bufferView:2,componentType:5123,count:3,type:"SCALAR",min:[0],max:[2]},
    ],
    bufferViews,buffers:[{byteLength:binary.length}],
    materials:[{name:"facade",pbrMetallicRoughness:{baseColorTexture:{index:textureIndex}}}],
    textures:[{source:0}],
    images,
  };
  const raw = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.concat([raw,Buffer.alloc((4-raw.length%4)%4,0x20)]);
  const bin = Buffer.concat([binary,Buffer.alloc((4-binary.length%4)%4)]);
  const out = Buffer.alloc(12+8+json.length+8+bin.length);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(json.length,12);out.writeUInt32LE(0x4e4f534a,16);json.copy(out,20);
  const binHeader=20+json.length;out.writeUInt32LE(bin.length,binHeader);out.writeUInt32LE(0x004e4942,binHeader+4);bin.copy(out,binHeader+8);
  return out;
}

test("accepts embedded PNG with material texture and normalized TEXCOORD_0", () => {
  const report = reviewGlbTextureBindings(makeGlb());
  assert.equal(report.valid,true);
  assert.equal(report.status,"texture-bindings-structurally-valid");
  assert.equal(report.counts.texturedPrimitiveCount,1);
  assert.equal(report.images[0].width,1);
  assert.equal(report.images[0].height,1);
  assert.equal(report.images[0].embedded,true);
});

test("verifies atlas byte hash and manifest dimensions", () => {
  const report = reviewGlbTextureBindings(makeGlb(), { expectedAtlas:{ sha256:hash(png), width:1, height:1 } });
  assert.equal(report.valid,true);
  const mismatch = reviewGlbTextureBindings(makeGlb(), { expectedAtlas:{ sha256:"0".repeat(64), width:1, height:1 } });
  assert.ok(mismatch.errors.includes("expected-atlas-not-embedded-in-glb"));
});

test("fails when a textured primitive has no required TEXCOORD attribute", () => {
  const report = reviewGlbTextureBindings(makeGlb({ omitUv:true }));
  assert.equal(report.valid,false);
  assert.ok(report.errors.includes("mesh-0-primitive-0-missing-TEXCOORD_0"));
});

test("flags UV values outside normalized atlas bounds", () => {
  const report = reviewGlbTextureBindings(makeGlb({ uvs:[[0,0],[1.4,0],[0,1]] }));
  assert.equal(report.valid,false);
  assert.ok(report.errors.includes("mesh-0-primitive-0-TEXCOORD_0-uv-outside-normalized-range"));
});

test("rejects material references to missing textures", () => {
  const report = reviewGlbTextureBindings(makeGlb({ textureIndex:9 }));
  assert.equal(report.valid,false);
  assert.ok(report.errors.includes("mesh-0-primitive-0-pbrMetallicRoughness.baseColorTexture-references-invalid-texture"));
});

test("reports external image resources without pretending they are embedded", () => {
  const report = reviewGlbTextureBindings(makeGlb({ imageUri:"https://example.invalid/atlas.png" }));
  assert.equal(report.valid,true);
  assert.ok(report.warnings.includes("image-0-external-uri"));
  assert.ok(report.warnings.includes("model-is-not-fully-self-contained"));
  assert.equal(report.images[0].embedded,false);
});

test("rejects malformed GLB inputs", () => {
  assert.throws(() => reviewGlbTextureBindings(Buffer.from("not a glb")), /GLB 2.0 Buffer/);
});
