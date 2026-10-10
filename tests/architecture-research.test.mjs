import assert from "node:assert/strict";
import test from "node:test";

import {
  filterArchitectureReferences,
  parseArchitectureResearchParams,
  summarizeArchitectureReferences,
} from "../src/core/geospatial/architecture-research.mjs";

const references = [
  {
    id: "R02",
    mediaType: "image",
    title: "Blue yellow facade in Mugda",
    sourceName: "Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg",
    locationText: "Mugda, Dhaka",
    usageStatus: "open-licence candidate",
    designProfile: {
      styleFamily: "painted-mid-rise-apartment",
      colorPalette: [{ name: "blue", hex: "#2F6C96" }],
      facadeFeatures: ["repeating balconies", "blue facade"],
      roofFeatures: [],
      siteContext: ["Mugda"],
      locationPrecision: "neighbourhood",
      paletteConfidence: "medium estimate",
      reconstructionUse: "facade template",
    },
  },
  {
    id: "R18",
    mediaType: "image",
    title: "Beauty Boarding courtyard",
    sourceName: "News",
    sourceUrl: "https://example.com/beauty",
    locationText: "Shree Shash Lane, Old Dhaka",
    usageStatus: "research-only",
    designProfile: {
      styleFamily: "Old-Dhaka-courtyard-historic-house",
      colorPalette: [{ name: "aged plaster", hex: "#C5B18C" }],
      facadeFeatures: ["arched veranda"],
      roofFeatures: [],
      siteContext: ["courtyard"],
      locationPrecision: "street-level",
      paletteConfidence: "low estimate",
      reconstructionUse: "heritage reference",
    },
  },
  {
    id: "V02",
    mediaType: "video",
    title: "Old Dhaka walking tour",
    sourceName: "YouTube",
    sourceUrl: "https://youtube.com/watch?v=example",
    locationText: "Old Dhaka",
    usageStatus: "research-only",
    designProfile: {
      styleFamily: "old-dhaka-walking-tour",
      colorPalette: [{ name: "brick", hex: "#99543E" }],
      facadeFeatures: ["narrow lanes"],
      roofFeatures: [],
      siteContext: ["market street"],
      locationPrecision: "route",
      paletteConfidence: "low estimate",
      reconstructionUse: "context only",
    },
  },
];

test("parses defaults and bounded query filters", () => {
  const parsed = parseArchitectureResearchParams(new URLSearchParams());
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.limit, 50);
    assert.equal(parsed.value.mediaType, "all");
    assert.equal(parsed.value.usage, "all");
  }
  const filtered = parseArchitectureResearchParams(new URLSearchParams("q=mugda&area=Mugda&style=painted&mediaType=image&usage=open&limit=5"));
  assert.equal(filtered.ok, true);
  if (filtered.ok) {
    assert.equal(filtered.value.query, "mugda");
    assert.equal(filtered.value.area, "mugda");
    assert.equal(filtered.value.limit, 5);
  }
});

test("rejects invalid query lengths, facets and bounds", () => {
  assert.equal(parseArchitectureResearchParams(new URLSearchParams("q=x")).ok, false);
  assert.equal(parseArchitectureResearchParams(new URLSearchParams("q=" + "x".repeat(101))).ok, false);
  assert.equal(parseArchitectureResearchParams(new URLSearchParams("mediaType=audio")).ok, false);
  assert.equal(parseArchitectureResearchParams(new URLSearchParams("usage=anything")).ok, false);
  assert.equal(parseArchitectureResearchParams(new URLSearchParams("limit=51")).ok, false);
  assert.equal(parseArchitectureResearchParams(new URLSearchParams("limit=1.5")).ok, false);
});

test("filters by neighbourhood, style family, media type and reuse status", () => {
  const base = {
    query: "",
    area: "old dhaka",
    style: "old-dhaka",
    mediaType: "image",
    usage: "research-only",
    limit: 50,
  };
  assert.deepEqual(filterArchitectureReferences(references, base).map((reference) => reference.id), ["R18"]);
  assert.deepEqual(filterArchitectureReferences(references, { ...base, area: "mugda", style: "painted", usage: "open" }).map((reference) => reference.id), ["R02"]);
  assert.deepEqual(filterArchitectureReferences(references, { ...base, mediaType: "video" }).map((reference) => reference.id), []);
});

test("search includes design features and palette hex codes", () => {
  const query = { query: "arched veranda", area: "", style: "", mediaType: "all", usage: "all", limit: 50 };
  assert.deepEqual(filterArchitectureReferences(references, query).map((reference) => reference.id), ["R18"]);
  const colorQuery = { ...query, query: "#2f6c96" };
  assert.deepEqual(filterArchitectureReferences(references, colorQuery).map((reference) => reference.id), ["R02"]);
});

test("summarizes image/video totals and unique facets", () => {
  const summary = summarizeArchitectureReferences(references);
  assert.equal(summary.totalReferences, 3);
  assert.equal(summary.imageCount, 2);
  assert.equal(summary.videoCount, 1);
  assert.ok(summary.styles.includes("painted-mid-rise-apartment"));
  assert.ok(summary.areas.includes("Mugda, Dhaka"));
});
