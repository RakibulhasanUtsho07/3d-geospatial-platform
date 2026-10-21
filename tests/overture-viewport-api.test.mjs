import assert from "node:assert/strict";
import { before, test } from "node:test";

const baseUrl = (
  process.env.GEOSPATIAL_API_BASE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");
const viewportPath = "/api/geospatial/overture-buildings/viewport";
const smallViewport = new URLSearchParams({
  west: "90.405",
  south: "23.775",
  east: "90.415",
  north: "23.785",
});

let serverAvailable = false;

before(async () => {
  try {
    const response = await fetch(baseUrl + viewportPath);
    await response.arrayBuffer();
    serverAvailable = true;
  } catch {
    serverAvailable = false;
  }
});

function skipWithoutServer(context) {
  if (!serverAvailable) {
    context.skip(
      "Start the app with npm run dev in another terminal before running this integration suite.",
    );
    return true;
  }

  return false;
}

test("viewport API rejects missing bounds", async (context) => {
  if (skipWithoutServer(context)) return;

  const response = await fetch(baseUrl + viewportPath + "?west=90.4");
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /west, south, east, and north/i);
});

test("viewport API rejects a viewport wider than the supported range", async (context) => {
  if (skipWithoutServer(context)) return;

  const query = new URLSearchParams({
    west: "90",
    south: "23",
    east: "93",
    north: "24",
  });
  const response = await fetch(baseUrl + viewportPath + "?" + query);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /cannot exceed/i);
});

test("viewport API returns features from generated spatial tiles", async (context) => {
  if (skipWithoutServer(context)) return;

  const response = await fetch(
    baseUrl + viewportPath + "?" + smallViewport,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Building-Data-Source"), "generated-tiles");
  assert.ok(Array.isArray(body.features));
  assert.ok(body.features.length > 0, "expected features for the Dhaka viewport");
  assert.ok(
    Number(response.headers.get("X-Building-Tile-Count")) > 0,
    "expected at least one selected tile",
  );
  assert.ok(
    Number(response.headers.get("X-Building-Total-Feature-Count")) >= body.features.length,
    "total source feature count should cover the viewport result",
  );
  assert.ok(
    Number(response.headers.get("X-Building-Candidate-Feature-Count")) >= body.features.length,
    "candidate feature count should cover the deduplicated result",
  );
  assert.notEqual(
    response.headers.get("X-Building-Tile-Cache-Hits"),
    null,
    "expected tile-cache diagnostics",
  );
});

test("repeated viewport requests reuse parsed tile data", async (context) => {
  if (skipWithoutServer(context)) return;

  const url = baseUrl + viewportPath + "?" + smallViewport;
  const firstResponse = await fetch(url);
  assert.equal(firstResponse.status, 200);
  await firstResponse.arrayBuffer();

  const secondResponse = await fetch(url);
  assert.equal(secondResponse.status, 200);
  const body = await secondResponse.json();

  assert.ok(body.features.length > 0);
  assert.ok(
    Number(secondResponse.headers.get("X-Building-Tile-Cache-Hits")) > 0,
    "expected a repeated request to hit the in-memory tile cache",
  );
});


test("viewport API caps response features and reports truncation diagnostics", async (context) => {
  if (skipWithoutServer(context)) return;

  const query = new URLSearchParams({
    west: "90.405",
    south: "23.775",
    east: "90.415",
    north: "23.785",
    limit: "500",
  });

  const response = await fetch(
    baseUrl + viewportPath + "?" + query,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body.features));
  assert.ok(body.features.length <= 500);

  assert.equal(
    response.headers.get("X-Building-Feature-Limit"),
    "500",
  );

  const matched = Number(
    response.headers.get("X-Building-Matched-Feature-Count"),
  );
  const returned = Number(
    response.headers.get("X-Building-Feature-Count"),
  );

  assert.ok(Number.isInteger(matched) && matched >= returned);
  assert.equal(returned, body.features.length);
  assert.equal(
    response.headers.get("X-Building-Truncated"),
    String(matched > returned),
  );
  assert.equal(
    response.headers.get("X-Building-Sampling-Strategy"),
    matched > returned ? "spatial-grid-round-robin" : "none",
  );
});

test("viewport API rejects malformed and out-of-range feature limits", async (context) => {
  if (skipWithoutServer(context)) return;

  for (const limit of ["0", "-1", "1.5", "NaN", "5001"]) {
    const query = new URLSearchParams({
      west: "90.405",
      south: "23.775",
      east: "90.415",
      north: "23.785",
      limit,
    });

    const response = await fetch(
      baseUrl + viewportPath + "?" + query,
    );
    const body = await response.json();

    assert.equal(response.status, 400, `limit ${limit} should be rejected`);
    assert.match(body.error, /feature limit/i);
  }
});


test("building search API rejects a query that is too short", async (context) => {
  if (skipWithoutServer(context)) return;

  const response = await fetch(
    baseUrl + "/api/geospatial/overture-buildings/search?q=x",
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /between 2 and 100 characters/i);
});

test("building search API enforces a bounded result limit", async (context) => {
  if (skipWithoutServer(context)) return;

  const query = new URLSearchParams({ q: "example", limit: "21" });
  const response = await fetch(
    baseUrl + "/api/geospatial/overture-buildings/search?" + query,
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /limit.*between 1 and 20/i);
});

test("building search API returns a valid empty result envelope for unmatched queries", async (context) => {
  if (skipWithoutServer(context)) return;

  const searchText = "zz-search-no-match-9f81a6c3";
  const query = new URLSearchParams({ q: searchText, limit: "3" });
  const response = await fetch(
    baseUrl + "/api/geospatial/overture-buildings/search?" + query,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.query, searchText);
  assert.equal(body.limit, 3);
  assert.equal(body.returnedCount, 0);
  assert.equal(body.totalMatches, 0);
  assert.deepEqual(body.results, []);
});
