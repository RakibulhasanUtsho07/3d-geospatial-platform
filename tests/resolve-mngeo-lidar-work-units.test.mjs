import assert from "node:assert/strict";
import test from "node:test";
import { resolveMnGeoLidarWorkUnits } from "../scripts/resolve-mngeo-lidar-work-units.mjs";

const ENDPOINT = "https://enterprise.gisdata.mn.gov/aghost/rest/services/MnTOPO_Flight_Swaths/FeatureServer/0/query";

function feature(objectid, {
  name = "Metro West",
  work_unit = "Work Unit 2",
  date = Date.UTC(2023, 5, 1),
  metadata = "https://operations.gis.data.mn.gov/api/publicdownload/download/42/metadata.pdf",
} = {}) {
  return { attributes: { objectid, name, work_unit, date, metadata } };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("queries the official service in EPSG:4326 and groups duplicate swath rows", async () => {
  let requested;
  const result = await resolveMnGeoLidarWorkUnits({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async (url, options) => {
      requested = { url: new URL(url), options };
      return jsonResponse({
        features: [
          feature(9, { date: Date.UTC(2023, 5, 1) }),
          feature(3, { date: Date.UTC(2023, 5, 1) }),
          feature(12, { date: Date.UTC(2023, 5, 2) }),
          feature(18, { name: "Metro North", work_unit: "Work Unit 1" }),
        ],
      });
    },
  });

  assert.equal(requested.url.origin + requested.url.pathname, ENDPOINT);
  assert.equal(requested.url.searchParams.get("geometry"), "-93.391,45.0518");
  assert.equal(requested.url.searchParams.get("geometryType"), "esriGeometryPoint");
  assert.equal(requested.url.searchParams.get("inSR"), "4326");
  assert.equal(requested.url.searchParams.get("spatialRel"), "esriSpatialRelIntersects");
  assert.equal(requested.url.searchParams.get("outFields"), "objectid,name,work_unit,date,metadata");
  assert.equal(requested.url.searchParams.get("returnGeometry"), "false");
  assert.equal(requested.url.searchParams.get("f"), "json");
  assert.equal(requested.options.headers.accept, "application/json");

  assert.equal(result.status, "work-units-discovered");
  assert.equal(result.counts.returnedFeatures, 4);
  assert.equal(result.counts.uniqueWorkUnitMetadataGroups, 2);
  assert.equal(result.workUnits[0].name, "Metro North");
  assert.equal(result.workUnits[1].featureIds.length, 3);
  assert.deepEqual(result.workUnits[1].collectionDates, [
    new Date(Date.UTC(2023, 5, 1)).toISOString(),
    new Date(Date.UTC(2023, 5, 2)).toISOString(),
  ]);
  assert.equal(result.candidateGlbGenerated, false);
  assert.equal(result.independentReferenceVerified, false);
  assert.equal(result.acceptanceEligible, false);
  assert.equal(result.publicationEligible, false);
  assert.equal(result.mapReady, false);
  assert.equal(result.automaticApproval, false);
});

test("blocks when no flight-swath polygons intersect the sample point", async () => {
  const result = await resolveMnGeoLidarWorkUnits({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({ features: [] }),
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.blockers, ["no-flight-swath-intersects-sample-point"]);
  assert.equal(result.workUnits.length, 0);
});

test("blocks metadata URLs outside the trusted Minnesota government GIS hosts", async () => {
  const result = await resolveMnGeoLidarWorkUnits({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({
      features: [
        feature(1, { metadata: "https://example.com/metadata.pdf" }),
        feature(2, { metadata: "http://operations.gis.data.mn.gov/metadata.pdf" }),
        feature(3, { metadata: null }),
      ],
    }),
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("missing-or-untrusted-work-unit-metadata-url"));
  assert.equal(result.workUnits.every((unit) => unit.metadataUrl === null), true);
});

test("rejects malformed response shapes and service-side ArcGIS errors", async () => {
  await assert.rejects(
    () => resolveMnGeoLidarWorkUnits({
      latitude: 45.0518,
      longitude: -93.391,
      fetchImpl: async () => jsonResponse({ error: { code: 400, message: "invalid geometry" } }),
    }),
    /error code 400/,
  );
  await assert.rejects(
    () => resolveMnGeoLidarWorkUnits({
      latitude: 45.0518,
      longitude: -93.391,
      fetchImpl: async () => jsonResponse({ results: [] }),
    }),
    /features array/,
  );
});

test("rejects invalid coordinates, timeouts and HTTP errors", async () => {
  await assert.rejects(
    () => resolveMnGeoLidarWorkUnits({ latitude: 91, longitude: 0, fetchImpl: async () => jsonResponse({ features: [] }) }),
    /latitude/,
  );
  await assert.rejects(
    () => resolveMnGeoLidarWorkUnits({ latitude: 0, longitude: 181, fetchImpl: async () => jsonResponse({ features: [] }) }),
    /longitude/,
  );
  await assert.rejects(
    () => resolveMnGeoLidarWorkUnits({ latitude: 0, longitude: 0, timeoutMs: 999, fetchImpl: async () => jsonResponse({ features: [] }) }),
    /timeoutMs/,
  );
  await assert.rejects(
    () => resolveMnGeoLidarWorkUnits({
      latitude: 45.0518,
      longitude: -93.391,
      fetchImpl: async () => jsonResponse({ message: "temporary error" }, 503),
    }),
    /HTTP status 503/,
  );
});

test("blocks malformed feature records and reports incomplete work-unit metadata", async () => {
  const result = await resolveMnGeoLidarWorkUnits({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({
      features: [
        { attributes: null },
        feature(2, { metadata: "" }),
      ],
    }),
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("malformed-flight-swath-feature"));
  assert.ok(result.blockers.includes("missing-or-untrusted-work-unit-metadata-url"));
  assert.equal(result.counts.invalidFeatures, 1);
});
