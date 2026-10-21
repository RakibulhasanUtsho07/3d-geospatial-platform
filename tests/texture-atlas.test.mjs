import assert from "node:assert/strict";
import test from "node:test";
import { packTextureAtlas, remapFacesToAtlas, remapUvToAtlas } from "../src/core/building-generation/texture-atlas.mjs";

const image = (id, width, height) => ({ id, width, height, sha256: "a".repeat(64), verifiedSource: true });

test("packs images deterministically while preserving aspect ratio", () => {
  const images = [image("front", 400, 200), image("side", 100, 200)];
  const a = packTextureAtlas(images, { width: 512, height: 512, padding: 4 });
  const b = packTextureAtlas(images, { width: 512, height: 512, padding: 4 });
  assert.deepEqual(a.placements, b.placements);
  for (const p of a.placements) assert.ok(Math.abs(p.width / p.height - p.sourceWidth / p.sourceHeight) < 0.02);
});

test("remaps source UVs into the packed atlas using bottom-left UV convention", () => {
  const atlas = packTextureAtlas([image("front", 100, 50)], { width: 256, height: 256, padding: 4 });
  const p = atlas.placements[0];
  assert.deepEqual(remapUvToAtlas([0, 0], p, atlas.width, atlas.height), [p.x / 256, (256 - p.y - p.height) / 256]);
  const remapped = remapFacesToAtlas([{ sourceImageId: "front", uv: [[0,0],[1,0],[0,1]], vertices: ["a","b","c"] }], atlas);
  assert.deepEqual(remapped[0].sourceUv, [[0,0],[1,0],[0,1]]);
  assert.equal(remapped[0].uv.length, 3);
});

test("rejects unverified images, invalid dimensions and missing source placement", () => {
  assert.throws(() => packTextureAtlas([{ ...image("x", 3, 3), verifiedSource: false }]), /verifiedSource/);
  assert.throws(() => packTextureAtlas([image("x", 0, 3)]), /positive integer/);
  const atlas = packTextureAtlas([image("a", 10, 10)]);
  assert.throws(() => remapFacesToAtlas([{ sourceImageId: "missing", uv: [[0,0],[1,0],[0,1]] }], atlas), /not present/);
});

test("fails when full resolution cannot fit and downscaling is disabled", () => {
  assert.throws(() => packTextureAtlas([image("wide", 2048, 1024)], { width: 256, height: 256, padding: 4, allowDownscale: false }), /do not fit/);
});

test("reports when multiple tiny slots cannot fit the atlas", () => {
  assert.throws(() => packTextureAtlas([image("a", 3, 3), image("b", 3, 3)], { width: 2, height: 2, padding: 0 }), /too many images/);
});
