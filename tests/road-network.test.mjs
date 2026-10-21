import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOverpassRoadQuery,
  normalizeOverpassRoadElements,
  parseRoadNetworkParams,
} from "../src/core/geospatial/road-network.mjs";

const defaultBounds = {
  west: 90.40,
  south: 23.74,
  east: 90.42,
  north: 23.76,
  limit: 900,
};

test("parses detailed Dhaka viewport bounds and rejects unbounded/global requests", () => {
  const parsed = parseRoadNetworkParams(new URLSearchParams("west=90.40&south=23.74&east=90.42&north=23.76&limit=700"));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.limit, 700);

  assert.equal(parseRoadNetworkParams(new URLSearchParams()).ok, false);
  assert.equal(parseRoadNetworkParams(new URLSearchParams("west=90.42&south=23.74&east=90.40&north=23.76")).ok, false);
  assert.equal(parseRoadNetworkParams(new URLSearchParams("west=90.1&south=23.1&east=90.3&north=23.3")).ok, false);
  assert.equal(parseRoadNetworkParams(new URLSearchParams("west=90.40&south=23.74&east=90.40&north=23.76")).ok, false);
  assert.equal(parseRoadNetworkParams(new URLSearchParams("west=90.40&south=23.74&east=90.42&north=23.76&limit=9999")).ok, false);
});

test("builds a scoped Overpass highway query with geometry", () => {
  const query = buildOverpassRoadQuery(defaultBounds);
  assert.match(query, /way\["highway"~/);
  assert.match(query, /90\.4/);
  assert.match(query, /out body geom/);
  assert.match(query, /out body geom\(23\.74,90\.4,23\.76,90\.42\) qt 900;/);
  assert.doesNotMatch(query, /building/);
});

test("normalizes roads with source names, road class, surface and inferred width", () => {
  const normalized = normalizeOverpassRoadElements([
    { type: "way", id: 20, tags: { highway: "primary", name: "Main Road", lanes: "2", surface: "asphalt" }, geometry: [{ lon: 90.405, lat: 23.75 }, { lon: 90.406, lat: 23.751 }] },
    { type: "way", id: 21, tags: { highway: "residential", width: "4.25" }, geometry: [{ lon: 90.4055, lat: 23.75 }, { lon: 90.407, lat: 23.751 }] },
    { type: "way", id: 22, tags: { highway: "unknown_kind" }, geometry: [{ lon: 90.405, lat: 23.75 }, { lon: 90.406, lat: 23.751 }] },
  ], defaultBounds);

  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].name, "Main Road");
  assert.equal(normalized[0].roadClass, "arterial");
  assert.equal(normalized[0].widthMeters, 6);
  assert.equal(normalized[0].widthSource, "lanes-estimate");
  assert.equal(normalized[0].surface, "asphalt");
  assert.equal(normalized[1].widthMeters, 4.25);
  assert.equal(normalized[1].widthSource, "tagged");
  assert.equal(normalized[0].license, "ODbL 1.0");
});

test("ignores malformed, duplicate and out-of-view road ways", () => {
  const elements = [
    { type: "way", id: 1, tags: { highway: "residential" }, geometry: [{ lon: 90.405, lat: 23.75 }, { lon: 90.406, lat: 23.751 }] },
    { type: "way", id: 1, tags: { highway: "primary", name: "duplicate" }, geometry: [{ lon: 90.405, lat: 23.75 }, { lon: 90.406, lat: 23.751 }] },
    { type: "way", id: 2, tags: { highway: "secondary" }, geometry: [{ lon: 91.1, lat: 24.5 }, { lon: 91.2, lat: 24.6 }] },
    { type: "node", id: 3, tags: { highway: "bus_stop" }, geometry: [] },
    { type: "way", id: 4, tags: { highway: "tertiary" }, geometry: [{ lon: 90.405, lat: 23.75 }] },
  ];
  const normalized = normalizeOverpassRoadElements(elements, defaultBounds);
  assert.deepEqual(normalized.map((road) => road.osmWayId), ["1"]);
});

test("includes connecting carriageways and pedestrian steps in the road vocabulary", () => {
  const normalized = normalizeOverpassRoadElements([
    { type: "way", id: 61, tags: { highway: "primary_link", name: "Main Road Connector" }, geometry: [{ lon: 90.405, lat: 23.75 }, { lon: 90.406, lat: 23.751 }] },
    { type: "way", id: 62, tags: { highway: "steps", name: "Footpath Steps" }, geometry: [{ lon: 90.405, lat: 23.75 }, { lon: 90.406, lat: 23.751 }] },
  ], defaultBounds);
  assert.equal(normalized.length, 2);
  assert.equal(normalized.find((road) => road.osmWayId === "61")?.roadClass, "arterial");
  assert.equal(normalized.find((road) => road.osmWayId === "62")?.roadClass, "path");
});

test("uses explicit OSM width ahead of typical road-class widths", () => {
  const [road] = normalizeOverpassRoadElements([
    { type: "way", id: 50, tags: { highway: "residential", width: "5.5 m", layer: "1", bridge: "yes" }, geometry: [{ lon: 90.405, lat: 23.75 }, { lon: 90.406, lat: 23.751 }] },
  ], defaultBounds);
  assert.equal(road.widthMeters, 5.5);
  assert.equal(road.widthSource, "tagged");
  assert.equal(road.layer, 1);
  assert.equal(road.bridge, true);
});
