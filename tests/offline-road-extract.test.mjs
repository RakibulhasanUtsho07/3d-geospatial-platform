import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadOfflineRoadExtract, queryOfflineRoadExtract, validateOfflineRoadExtract } from "../src/core/geospatial/offline-road-extract.mjs";
import { normalizeGeoJsonRoadFeatures } from "../src/core/geospatial/road-network.mjs";

const coverage = { west: 90.30, south: 23.60, east: 90.55, north: 23.90 };
const viewport = { west: 90.40, south: 23.70, east: 90.43, north: 23.73, limit: 50 };
const source = {
  provider: "Geofabrik / OpenStreetMap",
  url: "https://download.geofabrik.de/asia/bangladesh-latest.osm.pbf",
  extractDate: "2026-09-19", license: "ODbL 1.0",
  attribution: "© OpenStreetMap contributors", sourceSha256: "a".repeat(64),
};
const geojson = { type: "FeatureCollection", features: [
  { type: "Feature", id: "way/101", properties: { osm_id: 101, highway: "primary", name: "Main Road", lanes: 2 }, geometry: { type: "LineString", coordinates: [[90.405,23.71],[90.415,23.72]] } },
  { type: "Feature", id: "way/202", properties: { osm_id: 202, highway: "residential", name: "Lane", oneway: true }, geometry: { type: "MultiLineString", coordinates: [[[90.41,23.705],[90.412,23.706]],[[90.42,23.71],[90.421,23.712]]] } },
  { type: "Feature", id: "way/303", properties: { osm_id: 303, highway: "building" }, geometry: { type: "LineString", coordinates: [[90.41,23.71],[90.42,23.72]] } },
  { type: "Feature", id: "way/404", properties: { osm_id: 404, highway: "secondary" }, geometry: { type: "Polygon", coordinates: [] } },
  { type: "Feature", id: "way/505", properties: { osm_id: 505, highway: "footway" }, geometry: { type: "LineString", coordinates: [[90.50,23.8],[90.51,23.81]] } },
]};
function createExtract(overrides = {}) {
  const roads = normalizeGeoJsonRoadFeatures(geojson.features, { ...coverage, limit: 1000 });
  return validateOfflineRoadExtract({
    schemaVersion: 1, generatedAt: "2026-10-25T00:00:00.000Z", source, coverage,
    featureCount: roads.length, roads, ...overrides,
  });
}
test("normalizes line and multipart road geometry while filtering unsupported features", () => {
  const roads = normalizeGeoJsonRoadFeatures(geojson.features, { ...coverage, limit: 1000 });
  assert.equal(roads.length, 3);
  assert.equal(roads.filter((road) => road.osmWayId === "202").length, 2);
  assert.ok(roads.every((road) => road.source === "OpenStreetMap regional extract"));
  assert.ok(roads.every((road) => road.license === "ODbL 1.0" && road.coordinates.length >= 2));
  assert.equal(roads.find((road) => road.osmWayId === "202")?.oneway, true);
});
test("selects viewport-intersecting roads only when the extract covers the full viewport", () => {
  const result = queryOfflineRoadExtract(createExtract(), viewport);
  assert.equal(result.covered, true); assert.equal(result.sourceDate, source.extractDate);
  assert.ok(result.roads.length >= 1);
  assert.ok(result.roads.every((road) => road.source === "OpenStreetMap regional extract"));
});
test("does not use an extract outside its declared bounds", () => {
  const result = queryOfflineRoadExtract(createExtract(), { west:90.60,south:23.7,east:90.62,north:23.72,limit:50 });
  assert.equal(result.covered, false); assert.deepEqual(result.roads, []);
});
test("rejects missing attribution, insecure source URL and mismatched feature count", () => {
  const valid = createExtract();
  assert.throws(() => validateOfflineRoadExtract({ ...valid, source: { ...valid.source, attribution:"no attribution" } }), /source metadata/);
  assert.throws(() => validateOfflineRoadExtract({ ...valid, source: { ...valid.source, url:"http://invalid.example/data" } }), /HTTPS/);
  assert.throws(() => validateOfflineRoadExtract({ ...valid, featureCount:valid.featureCount+1 }), /featureCount/);
});
test("rejects invalid width, duplicate IDs and bad coordinate geometry", () => {
  const valid = createExtract();
  assert.throws(() => validateOfflineRoadExtract({ ...valid, roads:[{ ...valid.roads[0], widthMeters:0 }], featureCount:1 }), /invalid width/);
  assert.throws(() => validateOfflineRoadExtract({ ...valid, roads:[{ ...valid.roads[0], coordinates:[[90,23]] }], featureCount:1 }), /invalid coordinate geometry/);
  assert.throws(() => validateOfflineRoadExtract({ ...valid, roads:[valid.roads[0],valid.roads[0]], featureCount:2 }), /duplicate feature IDs/);
});
test("loads/cache-validates an extract by path metadata and reloads when file changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),"offline-road-extract-"));
  const filePath = path.join(directory,"roads.json");
  try {
    const extract=createExtract(); await writeFile(filePath,JSON.stringify(extract));
    const first=await loadOfflineRoadExtract(filePath), second=await loadOfflineRoadExtract(filePath);
    assert.strictEqual(first,second); assert.equal(first.featureCount,extract.featureCount);
    const raw=JSON.parse(await readFile(filePath,"utf8")); raw.source.extractDate="2026-09-20"; raw.source.sourceSha256="b".repeat(64);
    await writeFile(filePath,JSON.stringify(raw));
    const updated=await loadOfflineRoadExtract(filePath);
    assert.notStrictEqual(updated,first); assert.equal(updated.source.extractDate,"2026-09-20");
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test("rejects malformed JSON and invalid documents when loading", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),"offline-road-extract-invalid-"));
  const filePath=path.join(directory,"roads.json");
  try {
    await writeFile(filePath,"{invalid-json");
    await assert.rejects(loadOfflineRoadExtract(filePath),/invalid JSON/);
    await writeFile(filePath,JSON.stringify({schemaVersion:1}));
    await assert.rejects(loadOfflineRoadExtract(filePath),/coverage bounds/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
