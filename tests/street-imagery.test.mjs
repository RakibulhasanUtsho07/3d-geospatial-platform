import assert from "node:assert/strict";
import test from "node:test";

import {
  assessReconstructionReadiness,
  haversineDistanceMeters,
  normalizeKartaViewPhotos,
  parseStreetImageryParams,
} from "../src/core/geospatial/street-imagery.mjs";

function parse(search) {
  return parseStreetImageryParams(new URLSearchParams(search));
}

function request(overrides = {}) {
  return {
    latitude: 23.78,
    longitude: 90.41,
    radiusMeters: 250,
    limit: 25,
    ...overrides,
  };
}

test("requires a valid coordinate pair and applies safe search defaults", () => {
  assert.equal(parse("radius=250").ok, false);
  assert.equal(parse("lat=nope&lon=90.41").ok, false);
  const parsed = parse("lat=23.78&lon=90.41");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.radiusMeters, 250);
  assert.equal(parsed.value.limit, 25);
});

test("rejects oversized query radius or result limit", () => {
  assert.equal(parse("lat=23.78&lon=90.41&radius=501").ok, false);
  assert.equal(parse("lat=23.78&lon=90.41&radius=49").ok, false);
  assert.equal(parse("lat=23.78&lon=90.41&limit=51").ok, false);
});

test("normalizes public KartaView media with attribution, date, heading and distance", () => {
  const payload = {
    status: { apiCode: 600 },
    result: {
      data: [{
        id: 11,
        sequenceId: 23,
        lat: "23.7805",
        lng: "90.4101",
        heading: "181.5",
        shotDate: "2025-02-01 10:30:00",
        visibility: "public",
        status: "active",
        fileurlTh: "https://storage13.openstreetcam.org/files/photo/a/thumb.jpg",
        fileurl: "https://storage13.openstreetcam.org/files/photo/a/full.jpg",
      }],
    },
  };
  const results = normalizeKartaViewPhotos(payload, request());
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "11");
  assert.equal(results[0].sequenceId, "23");
  assert.equal(results[0].headingDegrees, 181.5);
  assert.equal(results[0].mediaKind, "photo");
  assert.equal(results[0].license, "CC BY-SA 4.0");
  assert.ok(results[0].distanceMeters < 100);
  assert.equal(results[0].thumbnailUrl, "https://storage13.openstreetcam.org/files/photo/a/thumb.jpg");
});

test("filters private, deleted, unsafe URL, invalid location and out-of-radius records", () => {
  const payload = { result: { data: [
    { id: 1, lat: "23.78", lng: "90.41", visibility: "private", fileurl: "https://storage13.openstreetcam.org/p.jpg" },
    { id: 2, lat: "23.78", lng: "90.41", status: "deleted", fileurl: "https://storage13.openstreetcam.org/p.jpg" },
    { id: 3, lat: "23.78", lng: "90.41", fileurl: "javascript:alert(1)" },
    { id: 4, lat: "23.78", lng: "90.41", fileurl: "https://example.com/not-kartaview.jpg" },
    { id: 5, lat: "25", lng: "90.41", fileurl: "https://storage13.openstreetcam.org/far.jpg" },
    { id: 6, lat: "not-a-lat", lng: "90.41", fileurl: "https://storage13.openstreetcam.org/invalid.jpg" },
  ] } };
  assert.deepEqual(normalizeKartaViewPhotos(payload, request()), []);
});

test("deduplicates IDs, sorts closest first and tags video-derived frames", () => {
  const payload = { result: { data: [
    { id: 12, lat: "23.781", lng: "90.41", videoId: 99, visibility: "public", fileurlTh: "https://storage13.openstreetcam.org/far.jpg" },
    { id: 10, lat: "23.7801", lng: "90.41", videoId: "88", visibility: "public", fileurlTh: "https://storage13.openstreetcam.org/near.jpg" },
    { id: 10, lat: "23.7801", lng: "90.41", videoId: "88", visibility: "public", fileurlTh: "https://storage13.openstreetcam.org/duplicate.jpg" },
  ] } };
  const results = normalizeKartaViewPhotos(payload, request());
  assert.deepEqual(results.map((item) => item.id), ["10", "12"]);
  assert.equal(results[0].mediaKind, "video-frame");
});

test("calculates distance safely and classifies reconstruction readiness honestly", () => {
  assert.equal(haversineDistanceMeters(23.78, 90.41, 23.78, 90.41), 0);
  assert.equal(assessReconstructionReadiness([]).level, "estimated");
  assert.equal(assessReconstructionReadiness([
    { latitude: 23.78, longitude: 90.41 },
  ]).level, "reference-only");
  const multiView = assessReconstructionReadiness([
    { latitude: 23.78, longitude: 90.41 },
    { latitude: 23.7805, longitude: 90.4102 },
    { latitude: 23.781, longitude: 90.4104 },
  ]);
  assert.equal(multiView.level, "multi-view-candidate");
  assert.equal(multiView.distinctCapturePoints, 3);
  assert.match(multiView.detail, /not been reconstructed or verified/i);
});
