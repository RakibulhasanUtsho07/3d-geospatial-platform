import assert from "node:assert/strict";
import test from "node:test";
import { resolveRoadVisualStyle, ROAD_VISUAL_LIMITS } from "../src/core/map-engine/road-visual-style.mjs";

test("road classes have a distinct visual hierarchy", () => {
  const arterial = resolveRoadVisualStyle({ roadClass: "arterial", widthMeters: 8 });
  const collector = resolveRoadVisualStyle({ roadClass: "collector", widthMeters: 5 });
  const local = resolveRoadVisualStyle({ roadClass: "local", widthMeters: 3 });
  const path = resolveRoadVisualStyle({ roadClass: "path", widthMeters: 1.2 });
  assert.ok(arterial.opacity > collector.opacity);
  assert.ok(collector.opacity > local.opacity);
  assert.ok(local.opacity > path.opacity);
  assert.equal(arterial.hasCentreLine, true);
  assert.equal(collector.hasCentreLine, false);
  assert.equal(path.color, "#B5A88E");
});

test("tagged road surfaces override class palette", () => {
  assert.equal(resolveRoadVisualStyle({ roadClass: "arterial", surface: "asphalt", widthMeters: 8 }).color, "#69757F");
  assert.equal(resolveRoadVisualStyle({ roadClass: "local", surface: "gravel", widthMeters: 3 }).color, "#9B8F7B");
});

test("width, bridge and tunnel properties are clamped and retained", () => {
  assert.equal(resolveRoadVisualStyle({ roadClass: "local", widthMeters: 0.1 }).widthMeters, ROAD_VISUAL_LIMITS.minWidthMeters);
  assert.equal(resolveRoadVisualStyle({ roadClass: "arterial", widthMeters: 100 }).widthMeters, ROAD_VISUAL_LIMITS.maxWidthMeters);
  assert.equal(resolveRoadVisualStyle({ roadClass: "arterial", widthMeters: 9, bridge: true, layer: 2 }).renderHeight, 6);
  assert.equal(resolveRoadVisualStyle({ roadClass: "local", widthMeters: 3, tunnel: true }).renderHeight, -3);
});

test("unknown road classes use a safe local-road style", () => {
  const style = resolveRoadVisualStyle({ roadClass: "unknown", widthMeters: 2 });
  assert.equal(style.roadClass, "local");
  assert.equal(style.color, "#CDD5DA");
  assert.equal(style.hasCentreLine, false);
});
