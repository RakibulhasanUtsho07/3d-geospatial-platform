import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGeneratedModelDefinition } from "../src/core/map-engine/generated-model-policy.mjs";

const valid = {
  id: "building-demo-1",
  name: "Demo building",
  url: "/models/demo-building.glb",
  position: { longitude: 90.406, latitude: 23.709, height: 2 },
};

test("normalizes stable model defaults and preserves metric placement", () => {
  const result = normalizeGeneratedModelDefinition(valid);
  assert.equal(result.id, "building-demo-1");
  assert.equal(result.url, "/models/demo-building.glb");
  assert.deepEqual(result.position, { longitude: 90.406, latitude: 23.709, height: 2 });
  assert.equal(result.headingDegrees, 0);
  assert.equal(result.pitchDegrees, 0);
  assert.equal(result.rollDegrees, 0);
  assert.equal(result.scale, 1);
  assert.equal(result.minimumPixelSize, 0);
  assert.equal(result.show, true);
  assert.equal(result.upAxis, "Y");
  assert.equal(result.forwardAxis, "Z");
});

test("accepts an HTTPS asset URL and valid model transform overrides", () => {
  const result = normalizeGeneratedModelDefinition({
    ...valid,
    url: "https://assets.example.com/models/building.glb?version=2",
    headingDegrees: 90,
    pitchDegrees: -10,
    rollDegrees: 2,
    scale: 1.25,
    minimumPixelSize: 16,
    maximumScale: 200,
    show: false,
    upAxis: "Z",
    forwardAxis: "Y",
  });
  assert.equal(result.headingDegrees, 90);
  assert.equal(result.pitchDegrees, -10);
  assert.equal(result.rollDegrees, 2);
  assert.equal(result.scale, 1.25);
  assert.equal(result.minimumPixelSize, 16);
  assert.equal(result.maximumScale, 200);
  assert.equal(result.show, false);
  assert.equal(result.upAxis, "Z");
  assert.equal(result.forwardAxis, "Y");
});

test("rejects malformed ids, untrusted schemes and path traversal", () => {
  for (const id of ["", "../building", "bad id", "-starts-with-dash"]) {
    assert.throws(() => normalizeGeneratedModelDefinition({ ...valid, id }), TypeError);
  }
  for (const url of ["javascript:alert(1)", "data:model/gltf-binary;base64,abc", "blob:https://example.com/id", "//evil.example/model.glb", "/models/%2e%2e/private.glb", "http://assets.example.com/model.glb"]) {
    assert.throws(() => normalizeGeneratedModelDefinition({ ...valid, url }), TypeError);
  }
});

test("rejects non-finite or out-of-range coordinates and transforms", () => {
  const invalidValues = [
    { ...valid, position: { longitude: 181, latitude: 0 } },
    { ...valid, position: { longitude: 0, latitude: -91 } },
    { ...valid, position: { longitude: 0, latitude: 0, height: Number.NaN } },
    { ...valid, headingDegrees: Infinity },
    { ...valid, pitchDegrees: 91 },
    { ...valid, rollDegrees: 361 },
    { ...valid, scale: 0 },
    { ...valid, minimumPixelSize: 513 },
    { ...valid, maximumScale: 0.5 },
  ];
  for (const value of invalidValues) assert.throws(() => normalizeGeneratedModelDefinition(value), RangeError);
});

test("requires distinct valid orientation axes and a boolean visibility flag", () => {
  assert.throws(() => normalizeGeneratedModelDefinition({ ...valid, upAxis: "Q" }), TypeError);
  assert.throws(() => normalizeGeneratedModelDefinition({ ...valid, upAxis: "X", forwardAxis: "X" }), RangeError);
  assert.throws(() => normalizeGeneratedModelDefinition({ ...valid, show: "false" }), TypeError);
});

test("rejects malformed or incomplete definitions", () => {
  assert.throws(() => normalizeGeneratedModelDefinition(null), TypeError);
  assert.throws(() => normalizeGeneratedModelDefinition({ ...valid, position: null }), TypeError);
  assert.throws(() => normalizeGeneratedModelDefinition({ ...valid, name: "" }), TypeError);
});
