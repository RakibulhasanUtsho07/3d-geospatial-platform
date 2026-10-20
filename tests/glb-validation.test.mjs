import assert from "node:assert/strict";
import test from "node:test";

import { generateParametricBuildingGlb } from "../src/core/building-generation/procedural-builder.mjs";
import { downloadGeneratedGlb, inspectGeneratedGlb } from "../src/core/building-generation/glb-validation.mjs";

const request = {
  schemaVersion: 1,
  requestId: "glb-validation-test",
  building: {
    name: "Validation House",
    buildingType: "house",
    designBrief: "A two-storey test house.",
    dimensions: { aboveGroundFloors: 2, floorToFloorHeightMeters: 3, totalHeightMeters: 6 },
    footprint: { widthMeters: 10, depthMeters: 8 },
    facadeColours: ["#e8e0d3"],
  },
  references: [],
  quality: "parametric-facade",
  allowExternalProviderProcessing: false,
};

function makeGlb() {
  return generateParametricBuildingGlb(request).glb;
}

function decodeChunks(glb) {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength).replace(/ +$/, ""));
  const binHeader = 20 + jsonLength;
  assert.equal(glb.readUInt32LE(binHeader + 4), 0x004e4942);
  const binLength = glb.readUInt32LE(binHeader);
  const bin = Buffer.from(glb.subarray(binHeader + 8, binHeader + 8 + binLength));
  return { json, bin };
}

function encodeGlb(json, bin = Buffer.alloc(0)) {
  const jsonRaw = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadding = (4 - (jsonRaw.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonRaw, Buffer.alloc(jsonPadding, 0x20)]);
  const binPadding = (4 - (bin.length % 4)) % 4;
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPadding)]);
  const hasBin = bin.length > 0;
  const total = 12 + 8 + jsonChunk.length + (hasBin ? 8 + binChunk.length : 0);
  const output = Buffer.alloc(total);
  output.write("glTF", 0, 4, "ascii");
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(total, 8);
  output.writeUInt32LE(jsonChunk.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(output, 20);
  if (hasBin) {
    const offset = 20 + jsonChunk.length;
    output.writeUInt32LE(binChunk.length, offset);
    output.writeUInt32LE(0x004e4942, offset + 4);
    binChunk.copy(output, offset + 8);
  }
  if (json.buffers?.[0]) json.buffers[0].byteLength = bin.length;
  return output;
}

test("accepts a generated GLB and reports only mesh-position bounds", () => {
  const glb = makeGlb();
  const result = inspectGeneratedGlb(glb);
  assert.equal(result.valid, true);
  assert.equal(result.contentType, "model/gltf-binary");
  assert.ok(result.bytes > 1024);
  assert.ok(result.jsonChunkBytes > 100);
  assert.ok(result.meshCount > 0);
  assert.ok(result.primitiveCount > 0);
  assert.ok(result.triangleCount > 0);
  assert.ok(result.vertexCount > 0);
  assert.equal(result.bounds.min[1], 0);
  assert.equal(result.bounds.max[1], 6);
  assert.ok(result.bounds.max[0] - result.bounds.min[0] >= 10);
  assert.ok(result.bounds.max[2] - result.bounds.min[2] >= 8);
});

test("rejects malformed GLB headers, lengths and unsupported versions", () => {
  const glb = makeGlb();
  const badMagic = Buffer.from(glb);
  badMagic.write("BAD!", 0, 4, "ascii");
  assert.throws(() => inspectGeneratedGlb(badMagic), /magic/i);

  const badLength = Buffer.from(glb);
  badLength.writeUInt32LE(glb.length + 4, 8);
  assert.throws(() => inspectGeneratedGlb(badLength), /total length/i);

  const badVersion = Buffer.from(glb);
  badVersion.writeUInt32LE(1, 4);
  assert.throws(() => inspectGeneratedGlb(badVersion), /version 2/i);

  assert.throws(() => inspectGeneratedGlb(Buffer.from("glTF")), /too short/i);
});

test("rejects external binary resources and invalid triangle indices", () => {
  const { json, bin } = decodeChunks(makeGlb());
  const external = structuredClone(json);
  external.buffers[0].uri = "https://evil.example/model.bin";
  assert.throws(() => inspectGeneratedGlb(encodeGlb(external, bin)), /External buffer URIs/i);

  const mutated = structuredClone(json);
  const indicesAccessor = mutated.accessors.find((accessor) => accessor.type === "SCALAR");
  assert.ok(indicesAccessor);
  const view = mutated.bufferViews[indicesAccessor.bufferView];
  const offset = (view.byteOffset ?? 0) + (indicesAccessor.byteOffset ?? 0);
  const corruptedBin = Buffer.from(bin);
  if (indicesAccessor.componentType === 5125) corruptedBin.writeUInt32LE(0xffffffff, offset);
  else if (indicesAccessor.componentType === 5123) corruptedBin.writeUInt16LE(0xffff, offset);
  else corruptedBin.writeUInt8(0xff, offset);
  assert.throws(() => inspectGeneratedGlb(encodeGlb(mutated, corruptedBin)), /index exceeds/i);
});

test("rejects non-finite vertex positions and oversized GLB data", () => {
  const { json, bin } = decodeChunks(makeGlb());
  const positionAccessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  const view = json.bufferViews[positionAccessor.bufferView];
  const offset = (view.byteOffset ?? 0) + (positionAccessor.byteOffset ?? 0);
  const corruptedBin = Buffer.from(bin);
  corruptedBin.writeFloatLE(Number.NaN, offset);
  assert.throws(() => inspectGeneratedGlb(encodeGlb(json, corruptedBin)), /non-finite/i);
  assert.throws(() => inspectGeneratedGlb(makeGlb(), { maxBytes: 1024 }), /size limit/i);
});

test("downloads and validates a model only from an explicit HTTPS host allowlist", async () => {
  const glb = makeGlb();
  let requestUrl;
  let requestInit;
  const result = await downloadGeneratedGlb("https://cdn.example.test/models/house.glb", {
    allowedHosts: ["cdn.example.test"],
    fetchImpl: async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return new Response(glb, { status: 200 });
    },
  });
  assert.equal(requestUrl, "https://cdn.example.test/models/house.glb");
  assert.equal(requestInit.redirect, "manual");
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.glb, glb);
});

test("rejects unsafe URLs, untrusted hosts, redirects and oversized downloads", async () => {
  const noFetch = async () => { throw new Error("fetch should not be called"); };
  await assert.rejects(downloadGeneratedGlb("http://cdn.tripo3d.ai/model.glb", { fetchImpl: noFetch }), /HTTPS/i);
  await assert.rejects(downloadGeneratedGlb("https://user:pass@cdn.tripo3d.ai/model.glb", { fetchImpl: noFetch }), /credentials/i);
  await assert.rejects(downloadGeneratedGlb("https://cdn.tripo3d.ai.evil.example/model.glb", { fetchImpl: noFetch }), /not allowlisted/i);
  await assert.rejects(downloadGeneratedGlb("https://cdn.tripo3d.ai/model.glb", {
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/model.glb" } }),
  }), /Redirected/i);

  const oversize = Buffer.alloc(4096, 0);
  await assert.rejects(downloadGeneratedGlb("https://cdn.example.test/model.glb", {
    allowedHosts: ["cdn.example.test"],
    maxBytes: 1024,
    fetchImpl: async () => new Response(oversize, { status: 200 }),
  }), /size limit/i);
});
