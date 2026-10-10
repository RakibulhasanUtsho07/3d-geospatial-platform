import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateDistanceMeters,
  matchNearbyServices,
  parsePropertySearchParams,
  searchPropertyListings,
} from "../src/core/geospatial/property-listings.mjs";

function parse(search) {
  return parsePropertySearchParams(new URLSearchParams(search));
}

test("requires valid coordinates and applies safe defaults", () => {
  assert.equal(parse("radius=5000").ok, false);
  assert.equal(parse("lat=abc&lon=90").ok, false);
  const result = parse("lat=23.7461&lon=90.3742");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.radiusMeters, 5000);
  assert.equal(result.value.limit, 50);
  assert.equal(result.value.propertyType, "all");
  assert.equal(result.value.savedOnly, false);
});

test("validates radius, limit, rent range, furnishing and type", () => {
  assert.equal(parse("lat=23&lon=90&radius=99").ok, false);
  assert.equal(parse("lat=23&lon=90&limit=101").ok, false);
  assert.equal(parse("lat=23&lon=90&minRent=50000&maxRent=10000").ok, false);
  assert.equal(parse("lat=23&lon=90&type=spaceship").ok, false);
  assert.equal(parse("lat=23&lon=90&furnishing=gold").ok, false);
  assert.equal(parse("lat=23&lon=90&q=x").ok, false);
});

test("filters nearby listings by budget, bedrooms and property type", () => {
  const parsed = parse("lat=23.7461&lon=90.3742&radius=20000&minRent=20000&maxRent=40000&minBedrooms=2&type=apartment");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const response = searchPropertyListings(parsed.value);
  assert.ok(response.totalMatches > 0);
  assert.ok(response.results.every((property) => property.propertyType === "apartment"
    && property.monthlyRentBdt >= 20000 && property.monthlyRentBdt <= 40000
    && property.bedrooms >= 2 && property.verified === false && property.liveAvailability === false));
  assert.deepEqual(response.results.map((property) => property.distanceMeters),
    [...response.results.map((property) => property.distanceMeters)].sort((a, b) => a - b));
});

test("respects radius for normal discovery searches", () => {
  const parsed = parse("lat=23.7461&lon=90.3742&radius=500");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.ok(searchPropertyListings(parsed.value).results.every((property) => property.distanceMeters <= 500));
});

test("saved-only mode returns saved records beyond the current radius", () => {
  const parsed = parse("lat=23.7461&lon=90.3742&radius=500&savedOnly=true&savedIds=dhk-gulshan-a01");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const response = searchPropertyListings(parsed.value);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].id, "dhk-gulshan-a01");
  assert.ok(response.results[0].distanceMeters > 500);
});

test("search text matches locality and caps returned results", () => {
  const parsed = parse("lat=23.7461&lon=90.3742&radius=20000&q=mirpur&limit=1");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const response = searchPropertyListings(parsed.value);
  assert.ok(response.totalMatches >= 2);
  assert.equal(response.returnedCount, 1);
  assert.equal(response.results.length, 1);
  assert.equal(response.results[0].area.toLowerCase(), "mirpur");
});

test("computes geographic distance with stable zero-distance handling", () => {
  assert.equal(calculateDistanceMeters(23.7, 90.4, 23.7, 90.4), 0);
  assert.ok(calculateDistanceMeters(23.7, 90.4, 23.71, 90.4) > 1000);
});

test("matches the nearest service per category inside the property radius", () => {
  const property = { latitude: 23.7461, longitude: 90.3742 };
  const places = [
    { id: "pharmacy-far", category: "pharmacy", latitude: 23.75, longitude: 90.3742 },
    { id: "pharmacy-near", category: "pharmacy", latitude: 23.7465, longitude: 90.3742 },
    { id: "hospital", category: "hospital", latitude: 23.747, longitude: 90.3742 },
    { id: "too-far", category: "market", latitude: 24.5, longitude: 90.5 },
  ];
  const matches = matchNearbyServices(property, places, 1500);
  assert.deepEqual(matches.map((item) => item.id), ["pharmacy-near", "hospital"]);
  assert.ok(matches[0].distanceFromPropertyMeters < matches[1].distanceFromPropertyMeters);
});
