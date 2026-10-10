import assert from "node:assert/strict";
import test from "node:test";

import { resolveBuildingVisualStyle } from "../src/core/buildings/building-style.ts";

test("uses source-tagged facade and roof colours instead of random generic palettes", () => {
  const style = resolveBuildingVisualStyle({
    "building:colour": "#2F6C96",
    "roof:colour": "#D8B044",
    "facade:material": "brick",
    "architecture_style": "painted-mid-rise-apartment",
    "facade_features": "symmetrical blue and yellow facade with balconies",
  }, "osm-way-42", 24);

  assert.equal(style.facadeColor, "#2f6c96");
  assert.equal(style.roofColor, "#d8b044");
  assert.equal(style.pattern, "painted-balcony");
  assert.equal(style.materialPattern, "brick");
});

test("recognizes heritage facade details and keeps ground-floor arches separate", () => {
  const style = resolveBuildingVisualStyle({
    "style_family": "Old-Dhaka-courtyard-historic-house",
    "facade_features": "arched ground-floor veranda, weathered wall finish, fluted columns",
    "roof_features": "not enough photos to confirm roof",
    "facade_material": "weathered plaster",
  }, "heritage-house-1", 9);

  assert.equal(style.pattern, "heritage-arches");
  assert.equal(style.decorativeColumns, true);
  assert.equal(style.materialPattern, "plaster");
});

test("uses explicitly sourced roof-garden clues without inventing them on other buildings", () => {
  const roofGarden = resolveBuildingVisualStyle({
    "building:use": "residential",
    "roof_features": "rooftop garden and landscaped terrace",
  }, "residence-with-roof-garden", 24);
  const unknownRoof = resolveBuildingVisualStyle({
    "building:use": "residential",
  }, "unverified-house", 24);

  assert.equal(roofGarden.roofDetail, "roof-garden");
  assert.ok(["none", "water-tank"].includes(unknownRoof.roofDetail));
});

test("normalizes common named source colour values", () => {
  const style = resolveBuildingVisualStyle({
    "building:colour": "blue",
    "roof:colour": "white",
  }, "named-colour-building", 12);

  assert.equal(style.facadeColor, "#2f6c96");
  assert.equal(style.roofColor, "#ffffff");
});
