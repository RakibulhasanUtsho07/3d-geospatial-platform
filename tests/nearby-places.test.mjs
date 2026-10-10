import assert from "node:assert/strict";
import test from "node:test";

import {
  NEARBY_PLACE_CATEGORIES,
  NEARBY_PLACE_LIMITS,
  buildOverpassQuery,
  normalizeOverpassElements,
  parseNearbyPlacesParams,
} from "../src/core/geospatial/nearby-places.mjs";

function params(values = {}) {
  return new URLSearchParams({
    lat: "23.78",
    lon: "90.41",
    ...values,
  });
}

function request(values = {}) {
  const parsed = parseNearbyPlacesParams(params(values));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

test("parses defaults and the five supported place categories", () => {
  const parsed = parseNearbyPlacesParams(params());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.radiusMeters, 800);
  assert.equal(parsed.value.limit, 100);
  assert.equal(parsed.value.categories.length, 5);
  assert.equal(NEARBY_PLACE_CATEGORIES.pharmacy.label, "Pharmacy");
  assert.equal(NEARBY_PLACE_LIMITS.maxRadiusMeters, 1500);
});

test("validates coordinates, radius, limit and selected categories", () => {
  for (const input of [
    params({ lat: "91" }),
    params({ lon: "-181" }),
    params({ lat: "Infinity" }),
    params({ radius: "99" }),
    params({ radius: "1501" }),
    params({ radius: "500.5" }),
    params({ limit: "0" }),
    params({ limit: "151" }),
    params({ limit: "1.2" }),
    params({ categories: "" }),
    params({ categories: "pharmacy,untrusted" }),
  ]) {
    const parsed = parseNearbyPlacesParams(input);
    assert.equal(parsed.ok, false);
  }
  assert.match(parseNearbyPlacesParams(new URLSearchParams()).error, /required/i);
});

test("deduplicates category selections and rejects unsupported query tags", () => {
  const parsed = parseNearbyPlacesParams(params({ categories: "pharmacy,pharmacy,market" }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.categories, ["pharmacy", "market"]);

  const query = buildOverpassQuery(parsed.value);
  assert.match(query, /\[out:json\]\[timeout:20\]/);
  assert.match(query, /\["amenity"="pharmacy"\]/);
  assert.match(query, /\["amenity"="marketplace"\]/);
  assert.match(query, /\["shop"="market"\]/);
  assert.match(query, /out center tags 300;/);
  assert.doesNotMatch(query, /\["name"~|userSupplied/i);
});

test("normalizes OSM nodes and way centres with safe tags and canonical URLs", () => {
  const query = request({ categories: "pharmacy,hospital,supermarket" });
  const places = normalizeOverpassElements([
    {
      type: "node",
      id: 11,
      lat: 23.7802,
      lon: 90.4102,
      tags: {
        amenity: "pharmacy",
        name: "Local Pharmacy",
        "addr:street": "Example Road",
        opening_hours: "Mo-Sa 09:00-22:00",
        phone: "+8801000000000",
        unneeded_long_value: "x".repeat(1000),
      },
    },
    {
      type: "way",
      id: 12,
      center: { lat: 23.781, lon: 90.411 },
      tags: { shop: "supermarket", "name:en": "Market Store", website: "https://example.com" },
    },
    {
      type: "relation",
      id: 13,
      center: { lat: 23.782, lon: 90.412 },
      tags: { amenity: "hospital", name: "City Hospital" },
    },
  ], query);

  assert.equal(places.length, 3);
  assert.equal(places[0].id, "osm:node:11");
  assert.equal(places[0].name, "Local Pharmacy");
  assert.equal(places[0].category, "pharmacy");
  assert.equal(places[0].address, "Example Road");
  assert.equal(places[0].openingHours, "Mo-Sa 09:00-22:00");
  assert.equal(places[0].osmUrl, "https://www.openstreetmap.org/node/11");
  assert.ok(places[0].distanceMeters < places[1].distanceMeters);
  assert.equal(places[1].name, "Market Store");
  assert.equal(places[1].osmType, "way");
  assert.equal(places[2].category, "hospital");
  assert.equal("unneeded_long_value" in places[0].tags, false);
});

test("categorizes clinics as medical centres and filters unrequested features", () => {
  const query = request({ categories: "medical_center" });
  const places = normalizeOverpassElements([
    { type: "node", id: 21, lat: 23.78, lon: 90.41, tags: { amenity: "clinic", name: "Family Clinic" } },
    { type: "node", id: 22, lat: 23.781, lon: 90.411, tags: { amenity: "pharmacy", name: "Not requested" } },
    { type: "node", id: 23, lat: 23.782, lon: 90.412, tags: { healthcare: "doctor", name: "Doctor" } },
  ], query);
  assert.deepEqual(places.map((place) => place.category), ["medical_center", "medical_center"]);
});

test("deduplicates OSM elements, sorts nearest first and enforces result limits", () => {
  const query = request({ limit: "2", categories: "pharmacy" });
  const elements = [
    { type: "node", id: 3, lat: 23.785, lon: 90.415, tags: { amenity: "pharmacy", name: "Far" } },
    { type: "node", id: 1, lat: 23.7801, lon: 90.4101, tags: { amenity: "pharmacy", name: "Near" } },
    { type: "node", id: 1, lat: 23.7801, lon: 90.4101, tags: { amenity: "pharmacy", name: "Duplicate" } },
    { type: "node", id: 2, lat: 23.781, lon: 90.411, tags: { amenity: "pharmacy", name: "Mid" } },
    { type: "node", id: 4, lat: 23.782, lon: 90.412, tags: { amenity: "pharmacy", name: "Invalid id" } },
  ];
  elements[4].id = Number.MAX_SAFE_INTEGER + 1;

  const places = normalizeOverpassElements(elements, query);
  assert.equal(places.length, 2);
  assert.equal(places[0].name, "Near");
  assert.equal(places[1].name, "Mid");
  assert.throws(() => normalizeOverpassElements({}, query), TypeError);
});

test("ignores malformed coordinates and unnamed invalid geometry safely", () => {
  const query = request();
  const places = normalizeOverpassElements([
    { type: "node", id: 1, lat: 100, lon: 0, tags: { amenity: "pharmacy" } },
    { type: "node", id: 2, tags: { amenity: "pharmacy", name: "Missing coordinates" } },
    { type: "node", id: 3, lat: 23.78, lon: 90.41, tags: { name: "No category" } },
  ], query);
  assert.deepEqual(places, []);
});
