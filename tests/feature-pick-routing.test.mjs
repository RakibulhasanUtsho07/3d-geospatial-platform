import assert from "node:assert/strict";
import test from "node:test";
import { resolveFeaturePickRoute } from "../src/core/map-engine/feature-pick-routing.mjs";

function entity(id, graphics = {}) {
  return { id, ...graphics };
}

function resolvers(values = {}, calls = []) {
  return {
    resolveNearbyPlace() {
      calls.push("nearby");
      return values.nearby ?? null;
    },
    resolvePropertyListing() {
      calls.push("property");
      return values.property ?? null;
    },
    resolveRoad() {
      calls.push("road");
      return values.road ?? null;
    },
    resolveBuilding() {
      calls.push("building");
      return values.building ?? null;
    },
  };
}

test("nearby places keep highest priority and stop lower-priority lookups", () => {
  const nearby = entity("place-1", { point: {} });
  const calls = [];
  const route = resolveFeaturePickRoute(resolvers({
    nearby,
    property: entity("property-1", { point: {} }),
    road: { id: "road-1" },
    building: entity("building-1", { polygon: {} }),
  }, calls));

  assert.deepEqual(route, { kind: "nearby-place", entity: nearby });
  assert.deepEqual(calls, ["nearby"]);
});

test("property listing wins when there is no nearby-place point", () => {
  const property = entity("property-1", { point: {} });
  const calls = [];
  const route = resolveFeaturePickRoute(resolvers({
    nearby: entity("label-only", { label: {} }),
    property,
    road: { id: "road-1" },
    building: entity("building-1", { polygon: {} }),
  }, calls));

  assert.deepEqual(route, { kind: "property-listing", entity: property });
  assert.deepEqual(calls, ["nearby", "property"]);
});

test("a mapped road wins over the underlying building", () => {
  const road = { id: "road-1", name: "Road" };
  const calls = [];
  const route = resolveFeaturePickRoute(resolvers({
    nearby: entity("non-point", { polygon: {} }),
    property: entity("non-point-property", { billboard: {} }),
    road,
    building: entity("building-1", { polygon: {} }),
  }, calls));

  assert.deepEqual(route, { kind: "road", road });
  assert.deepEqual(calls, ["nearby", "property", "road"]);
});

test("a polygon building is the final selectable candidate", () => {
  const building = entity("building-1", { polygon: {} });
  const calls = [];
  const route = resolveFeaturePickRoute(resolvers({ building }, calls));

  assert.deepEqual(route, { kind: "building", entity: building });
  assert.deepEqual(calls, ["nearby", "property", "road", "building"]);
});

test("candidates without the required point or polygon graphics are skipped", () => {
  const calls = [];
  const route = resolveFeaturePickRoute(resolvers({
    nearby: entity("nearby-without-point", { label: {} }),
    property: entity("property-without-point", { billboard: {} }),
    building: entity("building-without-polygon", { wall: {} }),
  }, calls));

  assert.deepEqual(route, { kind: "none" });
  assert.deepEqual(calls, ["nearby", "property", "road", "building"]);
});

test("null road lookup continues to the building candidate", () => {
  const building = entity("building-2", { polygon: {} });
  const calls = [];
  const route = resolveFeaturePickRoute(resolvers({ building }, calls));

  assert.equal(route.kind, "building");
  assert.strictEqual(route.entity, building);
  assert.deepEqual(calls, ["nearby", "property", "road", "building"]);
});

test("a falsey road value is not treated as a selected road", () => {
  const calls = [];
  const route = resolveFeaturePickRoute(resolvers({
    road: null,
    building: entity("building-3", { polygon: {} }),
  }, calls));

  assert.equal(route.kind, "building");
  assert.deepEqual(calls, ["nearby", "property", "road", "building"]);
});

test("the no-match route does not mutate candidates or invoke selection callbacks", () => {
  const candidate = entity("not-selectable", { label: {} });
  const calls = [];
  const route = resolveFeaturePickRoute(resolvers({ nearby: candidate }, calls));

  assert.deepEqual(route, { kind: "none" });
  assert.deepEqual(candidate, { id: "not-selectable", label: {} });
  assert.deepEqual(calls, ["nearby", "property", "road", "building"]);
});
