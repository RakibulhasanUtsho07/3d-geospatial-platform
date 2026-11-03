import assert from "node:assert/strict";
import test from "node:test";
import { discoverTnmLidarProducts } from "../scripts/discover-usgs-tnm-lidar-products.mjs";

const ENDPOINT = "https://tnmaccess.nationalmap.gov/api/v1/products";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function lpcItem({
  title = "Central Mississippi River Work Unit 4 LAZ tile 4375_49700",
  format = "LAZ",
  downloadURL = "https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/MN_CentralMissRiver_4_B22/4375_49700.laz",
  bbox = [-93.392, 45.051, -93.389, 45.054],
} = {}) {
  return {
    title,
    sourceId: "source-123",
    sourceName: "USGS TNM",
    format,
    publicationDate: "2023-02-08",
    lastUpdated: "2024-06-10T00:00:00Z",
    sizeInBytes: 42_000_000,
    metaUrl: "https://www.sciencebase.gov/catalog/item/123456",
    vendorMetaUrl: "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/metadata/example.xml",
    downloadURL,
    bbox,
  };
}

test("queries the exact TNM LPC dataset for LAS/LAZ in a bounded WGS84 bbox", async () => {
  let request;
  const result = await discoverTnmLidarProducts({
    latitude: 45.0518,
    longitude: -93.391,
    bufferMeters: 100,
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return jsonResponse({ total: 1, items: [lpcItem()] });
    },
  });

  assert.equal(request.url.origin + request.url.pathname, ENDPOINT);
  assert.equal(request.url.searchParams.get("datasets"), "Lidar Point Cloud (LPC)");
  assert.equal(request.url.searchParams.get("prodFormats"), "LAS,LAZ");
  assert.equal(request.url.searchParams.get("max"), "50");
  const bbox = request.url.searchParams.get("bbox").split(",").map(Number);
  assert.equal(bbox.length, 4);
  assert.ok(bbox[0] < -93.391 && bbox[2] > -93.391);
  assert.ok(bbox[1] < 45.0518 && bbox[3] > 45.0518);
  assert.equal(request.options.headers.accept, "application/json");

  assert.equal(result.status, "products-discovered");
  assert.deepEqual(result.counts, {
    totalProductsReported: 1,
    productsReturned: 1,
    pointCloudProducts: 1,
    productsWithAllowlistedDownloadUrl: 1,
    productsWithReportedBounds: 1,
    readyCandidateProducts: 1,
  });
  assert.equal(result.products[0].title, "Central Mississippi River Work Unit 4 LAZ tile 4375_49700");
  assert.equal(result.products[0].downloadUrls[0], "https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/MN_CentralMissRiver_4_B22/4375_49700.laz");
  assert.equal(result.products[0].boundsOverlapQuery, true);
  assert.equal(result.candidateGlbGenerated, false);
  assert.equal(result.independentReferenceVerified, false);
  assert.equal(result.acceptanceEligible, false);
  assert.equal(result.publicationEligible, false);
  assert.equal(result.mapReady, false);
  assert.equal(result.automaticApproval, false);
});

test("recognizes LAS/LAZ links when format metadata is absent", async () => {
  const result = await discoverTnmLidarProducts({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({
      total: 1,
      items: [{
        title: "Lidar Point Cloud LAS tile",
        downloadURL: "https://rockyweb.usgs.gov/vdelivery/Datasets/example.las",
        bbox: [-93.4, 45.0, -93.3, 45.1],
      }],
    }),
  });
  assert.equal(result.status, "products-discovered");
  assert.equal(result.counts.pointCloudProducts, 1);
});

test("blocks products without any trusted direct LAS/LAZ download URL", async () => {
  const result = await discoverTnmLidarProducts({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({
      total: 1,
      items: [lpcItem({ downloadURL: "https://example.com/data.laz" })],
    }),
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("one-or-more-point-cloud-products-lack-an-allowlisted-download-url"));
  assert.equal(result.products[0].downloadUrls.length, 0);
  assert.equal(result.products[0].rejectedDownloadUrls.length, 1);
  assert.equal(result.mapReady, false);
});

test("does not mistake bare-earth DEM products for LAS/LAZ point clouds", async () => {
  const result = await discoverTnmLidarProducts({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({
      total: 1,
      items: [{
        title: "Central Mississippi River Work Unit 4 bare-earth DEM",
        format: "GeoTIFF",
        downloadURL: "https://prd-tnm.s3.amazonaws.com/example.tif",
      }],
    }),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.counts.pointCloudProducts, 0);
  assert.ok(result.blockers.includes("returned-products-do-not-identify-las-or-laz"));
});

test("blocks empty search results and incomplete pagination", async () => {
  const empty = await discoverTnmLidarProducts({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({ total: 0, items: [] }),
  });
  assert.equal(empty.status, "blocked");
  assert.ok(empty.blockers.includes("no-lidar-point-cloud-products-returned"));

  const incomplete = await discoverTnmLidarProducts({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({
      total: 51,
      items: [lpcItem()],
    }),
  });
  assert.equal(incomplete.status, "blocked");
  assert.ok(incomplete.blockers.includes("tnm-result-pagination-incomplete"));
});

test("rejects malformed API payloads, HTTP errors and invalid coordinates", async () => {
  await assert.rejects(
    () => discoverTnmLidarProducts({
      latitude: 45.0518,
      longitude: -93.391,
      fetchImpl: async () => jsonResponse({ total: 0 }),
    }),
    /items array/,
  );
  await assert.rejects(
    () => discoverTnmLidarProducts({
      latitude: 45.0518,
      longitude: -93.391,
      fetchImpl: async () => jsonResponse({ message: "unavailable" }, 503),
    }),
    /HTTP status 503/,
  );
  await assert.rejects(
    () => discoverTnmLidarProducts({ latitude: 86, longitude: 0, fetchImpl: async () => jsonResponse({ total: 0, items: [] }) }),
    /latitude/,
  );
  await assert.rejects(
    () => discoverTnmLidarProducts({ latitude: 45, longitude: 181, fetchImpl: async () => jsonResponse({ total: 0, items: [] }) }),
    /longitude/,
  );
  await assert.rejects(
    () => discoverTnmLidarProducts({ latitude: 45, longitude: -93, bufferMeters: 9, fetchImpl: async () => jsonResponse({ total: 0, items: [] }) }),
    /bufferMeters/,
  );
});

test("blocks item footprints explicitly outside the query bbox", async () => {
  const result = await discoverTnmLidarProducts({
    latitude: 45.0518,
    longitude: -93.391,
    fetchImpl: async () => jsonResponse({
      total: 1,
      items: [lpcItem({ bbox: [-94, 44, -93.8, 44.2] })],
    }),
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("one-or-more-products-do-not-overlap-query-bbox"));
  assert.equal(result.products[0].boundsOverlapQuery, false);
});
