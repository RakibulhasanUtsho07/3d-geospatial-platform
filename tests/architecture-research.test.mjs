import assert from "node:assert/strict";
import test from "node:test";

import {
  canAssignArchitectureReference,
  createArchitectureStylePreview,
  filterArchitectureReferences,
  resolveArchitectureMediaPreview,
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
  assert.deepEqual(filterArchitectureReferences(references, { ...base, mediaType: "video" }).map((reference) => reference.id), ["V02"]);
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

test("builds temporary facade preview styles from researched architecture palettes", () => {
  const heritage = createArchitectureStylePreview(references[1]);
  assert.equal(heritage.id, "research-preview-R18");
  assert.equal(heritage.pattern, "heritage-arches");
  assert.equal(heritage.facadeColor, "#C5B18C");
  assert.equal(heritage.roofDetail, "none");
  assert.equal(heritage.materialPattern, "weathered");
  assert.equal(heritage.groundFloorArches, true);
  assert.equal(heritage.fullHeightTexture, true);
  assert.equal(heritage.greenery, false);

  const painted = createArchitectureStylePreview(references[0]);
  assert.equal(painted.pattern, "painted-balcony");
  assert.equal(painted.facadeColor, "#2F6C96");
  assert.equal(painted.materialPattern, "painted");
  assert.equal(painted.windowBayCount, 3);
  assert.match(painted.id, /^research-preview-/);
});

test("maps biophilic references into brick, balcony, greenery and roof-garden features", () => {
  const biophilic = {
    id: "R23",
    mediaType: "image",
    designProfile: {
      styleFamily: "Gulshan-climate-responsive-residence",
      colorPalette: [
        { name: "warm-brick", hex: "#A5543A" },
        { name: "fair-faced-concrete", hex: "#B5B0A6" },
        { name: "glass-muted-blue", hex: "#91A6AE" },
        { name: "cascading-green", hex: "#3F7746" },
      ],
      facadeFeatures: ["integrated planter beds", "hanging creepers", "wide balconies", "large openings"],
      roofFeatures: ["rooftop garden and landscaped terraces"],
      siteContext: ["Gulshan"],
      locationPrecision: "city-level",
      paletteConfidence: "estimated",
      reconstructionUse: "facade preview",
    },
  };
  const style = createArchitectureStylePreview(biophilic);
  assert.equal(style.pattern, "biophilic-balcony");
  assert.equal(style.materialPattern, "brick");
  assert.equal(style.greenery, true);
  assert.equal(style.roofDetail, "roof-garden");
  assert.equal(style.balconyProjectionMeters, 1.6);
});

test("resolves only reuse-aware Commons image previews and validated YouTube embeds", () => {
  const commons = resolveArchitectureMediaPreview({
    id: "R02",
    mediaType: "image",
    title: "Mugda facade",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Symmetrical_blue_and_yellow_facade_of_a_building_at_Mugda_in_Dhaka.jpg",
    license: "CC BY-SA 4.0 International",
    usageStatus: "open-licence-candidate; re-check",
  });
  assert.equal(commons.mediaPreviewKind, "image");
  assert.match(commons.mediaPreviewUrl, /Special:FilePath/);
  assert.match(commons.mediaPreviewUrl, /width=720/);

  const video = resolveArchitectureMediaPreview({
    id: "V02",
    mediaType: "video",
    title: "Old Dhaka walking tour",
    sourceUrl: "https://www.youtube.com/watch?v=TRiPqruKoGE",
    license: "Standard YouTube viewing",
    usageStatus: "viewing/reference only; reuse not established",
  });
  assert.equal(video.mediaPreviewKind, "video");
  assert.equal(video.mediaPreviewUrl, "https://www.youtube-nocookie.com/embed/TRiPqruKoGE");

  const rightsUnclear = resolveArchitectureMediaPreview({
    id: "R18",
    mediaType: "image",
    sourceUrl: "https://www.jagonews24.com/photo/bangladesh/photo-feature/1471",
    license: "Not established",
    usageStatus: "research-only",
  });
  assert.deepEqual(rightsUnclear, { mediaPreviewUrl: null, mediaPreviewKind: null });

  const unsafeHost = resolveArchitectureMediaPreview({
    id: "V99",
    mediaType: "video",
    sourceUrl: "https://evil.example/watch?v=TRiPqruKoGE",
    usageStatus: "viewing/reference only",
  });
  assert.deepEqual(unsafeHost, { mediaPreviewUrl: null, mediaPreviewKind: null });
});

test("derives reported geometry only when source metadata has an unambiguous floor count or height", () => {
  const roseGarden = createArchitectureStylePreview({
    id: "R19",
    mediaType: "image",
    reportedBuildingMetadata: {
      reportedStoreys: 2,
      reportedHeightFeet: 45,
    },
    designProfile: {
      styleFamily: "formal-heritage-mansion-garden",
      colorPalette: [{ name: "ivory", hex: "#F1EFE7" }],
      facadeFeatures: ["three entrance arches", "fluted columns"],
      roofFeatures: [],
      siteContext: [],
      locationPrecision: "named landmark",
      paletteConfidence: "medium estimate",
      reconstructionUse: "heritage mansion",
    },
  });
  assert.equal(roseGarden.reportedFloorCount, 2);
  assert.equal(roseGarden.reportedHeightMeters, 13.72);

  const jcx = createArchitectureStylePreview({
    id: "R27",
    mediaType: "image",
    reportedBuildingMetadata: { floors: "B+G+9" },
    designProfile: {
      styleFamily: "residential-tower",
      colorPalette: [{ name: "white", hex: "#F1EFE7" }],
      facadeFeatures: ["balconies"],
      roofFeatures: ["rooftop garden"],
      siteContext: [],
      locationPrecision: "developer-reported plot address",
      paletteConfidence: "estimated",
      reconstructionUse: "building reference",
    },
  });
  assert.equal(jcx.reportedFloorCount, 10);
  assert.equal(jcx.roofDetail, "roof-garden");

  const complexWings = createArchitectureStylePreview({
    id: "R08",
    mediaType: "image",
    reportedBuildingMetadata: { storeys: "two-storey main house; three-storey southern wing" },
    designProfile: {
      styleFamily: "courtyard-family-house",
      colorPalette: [{ name: "cream", hex: "#E7D2BD" }],
      facadeFeatures: [],
      roofFeatures: [],
      siteContext: [],
      locationPrecision: "street level",
      paletteConfidence: "low estimate",
      reconstructionUse: "multi-wing house",
    },
  });
  assert.equal(complexWings.reportedFloorCount, undefined);
});

test("blocks single-building assignment for skyline, panoramic and cluster-only context", () => {
  assert.equal(canAssignArchitectureReference({
    id: "R01",
    mediaType: "image",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Dhaka_skyline.jpg",
    designProfile: {
      styleFamily: "dense-high-rise-residential-context",
      reconstructionUse: "urban density template; individual facades not matched",
    },
    buildingMatchConfidence: "viewpoint-level, not building centroids",
  }), false);

  assert.equal(canAssignArchitectureReference({
    id: "R19",
    mediaType: "image",
    sourceUrl: "https://example.org/rose-garden",
    designProfile: {
      styleFamily: "formal-heritage-mansion-garden",
      reconstructionUse: "manual facade profile",
    },
    buildingMatchConfidence: "named landmark; footprint still needs validation",
  }), true);

  assert.equal(canAssignArchitectureReference({
    id: "V03",
    mediaType: "video",
    sourceUrl: "https://www.youtube.com/watch?v=orB6n7bX-uk",
    designProfile: { styleFamily: "Old-Dhaka-dense-market-street" },
  }), false);
});
