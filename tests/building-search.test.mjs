import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILDING_SEARCH_LIMITS,
  createBuildingSearchIndex,
  searchBuildingIndex,
} from "../src/core/geospatial/building-search.mjs";

function makeFeature(id, name, longitude, latitude, properties = {}) {
  const ring = [
    [longitude - 0.001, latitude - 0.001],
    [longitude + 0.001, latitude - 0.001],
    [longitude + 0.001, latitude + 0.001],
    [longitude - 0.001, latitude + 0.001],
    [longitude - 0.001, latitude - 0.001],
  ];

  return {
    type: "Feature",
    id,
    properties: {
      ...(name ? { names: { primary: name } } : {}),
      ...properties,
    },
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

test("search matches feature names case-insensitively and ranks direct names first", () => {
  const index = createBuildingSearchIndex([
    makeFeature("tower-1", "Central Tower", 90.41, 23.78, { class: "commercial" }),
    makeFeature("block-1", "Central Block", 90.42, 23.79, { class: "residential" }),
    makeFeature("other-1", "Riverside Building", 90.43, 23.8, { class: "residential" }),
  ]);

  const exact = searchBuildingIndex(index, "CENTRAL TOWER");
  assert.equal(exact.totalMatches, 1);
  assert.equal(exact.results[0].id, "tower-1");
  assert.equal(exact.results[0].name, "Central Tower");

  const prefix = searchBuildingIndex(index, "central");
  assert.equal(prefix.totalMatches, 2);
  assert.deepEqual(prefix.results.map((entry) => entry.name), ["Central Block", "Central Tower"]);
});

test("search can match a source property value or Overture feature identifier", () => {
  const index = createBuildingSearchIndex([
    makeFeature("overture-abc-123", null, 90.41, 23.78, {
      subtype: "residential",
      use: "student housing",
    }),
  ]);

  assert.equal(searchBuildingIndex(index, "student housing").results[0].id, "overture-abc-123");
  assert.equal(searchBuildingIndex(index, "abc-123").results[0].id, "overture-abc-123");
});

test("search summaries include a geometry center and useful source metadata", () => {
  const index = createBuildingSearchIndex([
    makeFeature("tower-1", "Central Tower", 90.41, 23.78, {
      class: "commercial",
      height_m: "42.5",
      num_floors: 12,
    }),
  ]);

  const result = searchBuildingIndex(index, "central").results[0];
  assert.equal(result.longitude, 90.41);
  assert.equal(result.latitude, 23.78);
  assert.equal(result.category, "commercial");
  assert.equal(result.heightMeters, 42.5);
  assert.equal(result.floors, 12);
  assert.equal("searchableText" in result, false);
});

test("hidden parent footprints with rendered parts are not duplicated in results", () => {
  const index = createBuildingSearchIndex([
    makeFeature("parent", "Twin Tower", 90.41, 23.78, {
      _renderRole: "building_parent",
      _renderPartCount: 2,
      name: "Twin Tower",
    }),
    makeFeature("part", "Twin Tower East", 90.411, 23.781, {
      _renderRole: "building_part",
      name: "Twin Tower East",
    }),
  ]);

  const result = searchBuildingIndex(index, "twin tower");
  assert.equal(result.totalMatches, 1);
  assert.equal(result.results[0].id, "part");
});

test("invalid geometries are skipped safely", () => {
  const index = createBuildingSearchIndex([
    makeFeature("valid", "Valid Hall", 90.41, 23.78),
    {
      type: "Feature",
      id: "invalid",
      properties: { name: "No geometry" },
      geometry: { type: "Polygon", coordinates: [] },
    },
  ]);

  assert.equal(searchBuildingIndex(index, "valid hall").totalMatches, 1);
});

test("search rejects queries and result limits outside the configured bounds", () => {
  const index = createBuildingSearchIndex([
    makeFeature("one", "Example Building", 90.41, 23.78),
  ]);

  assert.equal(BUILDING_SEARCH_LIMITS.defaultLimit, 8);
  for (const query of ["", "a", "x".repeat(101)]) {
    assert.throws(() => searchBuildingIndex(index, query), RangeError);
  }
  for (const limit of [0, -1, 1.5, 21, Number.NaN]) {
    assert.throws(() => searchBuildingIndex(index, "example", limit), RangeError);
  }
  assert.throws(() => createBuildingSearchIndex({}), TypeError);
});
