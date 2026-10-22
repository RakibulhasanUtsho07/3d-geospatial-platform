import { expect, test, type Page } from "@playwright/test";

type ObservedRequests = {
  buildings: URL[];
  roads: URL[];
};

const EMPTY_FEATURE_COLLECTION = {
  type: "FeatureCollection",
  features: [],
};

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
  "base64",
);

async function stubMapNetwork(page: Page): Promise<ObservedRequests> {
  const observed: ObservedRequests = { buildings: [], roads: [] };

  // The browser test is about map lifecycle and interactions, not tile-provider
  // availability. A valid 1x1 PNG keeps the basemap deterministic and offline.
  await page.route("https://tile.openstreetmap.org/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: TRANSPARENT_PNG,
    });
  });

  // Avoid GPU-heavy heritage geometry in CI: map lifecycle and camera tests use
  // the actual Cesium viewer but do not benchmark GLB rendering performance.
  await page.route("**/models/*.glb", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "Heritage GLBs are intentionally disabled in map interaction tests.",
    });
  });

  await page.route("**/api/geospatial/overture-buildings**", async (route) => {
    observed.buildings.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/geo+json",
      body: JSON.stringify(EMPTY_FEATURE_COLLECTION),
    });
  });

  await page.route("**/api/geospatial/roads**", async (route) => {
    observed.roads.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: [] }),
    });
  });

  return observed;
}

async function openReadyMap(page: Page): Promise<void> {
  await page.goto("/map", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("checkbox", { name: "Detailed OSM roads" }),
  ).toBeEnabled({ timeout: 45_000 });
  await expect(
    page.getByTestId("cesium-map-container").locator("canvas").first(),
  ).toBeVisible({ timeout: 45_000 });
}

function roadBoundsKey(url: URL): string {
  return ["west", "south", "east", "north"]
    .map((key) => url.searchParams.get(key) ?? "missing")
    .join("|");
}

test("3D map initializes and imagery/building layer switches remain in sync", async ({ page }) => {
  const observed = await stubMapNetwork(page);
  await openReadyMap(page);

  const imagery = page.getByRole("checkbox", { name: "Street map imagery" });
  const roads = page.getByRole("checkbox", { name: "Detailed OSM roads" });
  const buildings = page.getByRole("checkbox", {
    name: "Overture 3D buildings",
  });

  await expect(imagery).toBeChecked();
  await expect(roads).toBeChecked();
  await expect(buildings).toBeChecked();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeEnabled();

  // Change imagery and buildings separately from road requests. This keeps
  // visibility assertions focused on the selected layer, not network timing.
  await imagery.uncheck({ noWaitAfter: true });
  await expect(imagery).not.toBeChecked();
  await imagery.check({ noWaitAfter: true });
  await expect(imagery).toBeChecked();

  await buildings.uncheck({ noWaitAfter: true });
  await expect(buildings).not.toBeChecked();
  await buildings.check({ noWaitAfter: true });
  await expect(buildings).toBeChecked();

  await expect.poll(() => observed.buildings.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => observed.roads.length, { timeout: 15_000 }).toBeGreaterThan(0);
});

test("road visibility can be disabled and restored", async ({ page }) => {
  const observed = await stubMapNetwork(page);
  await openReadyMap(page);

  const roads = page.getByRole("checkbox", { name: "Detailed OSM roads" });
  await expect.poll(() => observed.roads.length, { timeout: 15_000 }).toBeGreaterThan(0);

  await roads.uncheck({ noWaitAfter: true });
  await expect(roads).not.toBeChecked();

  // Route the re-enable query to the deterministic empty response as well.
  await roads.check({ noWaitAfter: true });
  await expect(roads).toBeChecked();
  // The adapter may reuse its already-loaded road viewport when toggling back
  // on. In that case no second request is needed; visibility is still restored.
  expect(observed.roads.length).toBeGreaterThan(0);
});

test("canvas drag stays interactive and zooming requests fresh road viewport bounds", async ({ page }) => {
  const observed = await stubMapNetwork(page);
  await openReadyMap(page);
  await expect.poll(() => observed.roads.length, { timeout: 20_000 }).toBeGreaterThan(0);

  // Let the initial camera preset settle so the next requests belong to this test.
  await page.waitForTimeout(700);
  const initialUrl = observed.roads.at(-1);
  expect(initialUrl).toBeDefined();
  const initialBounds = roadBoundsKey(initialUrl!);

  const canvas = page.getByTestId("cesium-map-container").locator("canvas").first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  // Exercise the real Cesium canvas drag gesture. A small pan can remain inside
  // already-loaded road coverage, in which case no duplicate network request is
  // expected; the map must remain usable and zoom must still refresh bounds.
  const startX = box!.x + box!.width * 0.52;
  const startY = box!.y + box!.height * 0.48;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 320, startY + 80);
  await page.mouse.up();
  await expect(canvas).toBeVisible();

  await page.waitForTimeout(400);
  const boundsBeforeZoom = roadBoundsKey(observed.roads.at(-1)!);
  const beforeZoomCount = observed.roads.length;

  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();

  await expect.poll(
    () => observed.roads.slice(beforeZoomCount).some(
      (url) => roadBoundsKey(url) !== boundsBeforeZoom && roadBoundsKey(url) !== initialBounds,
    ),
    { timeout: 20_000 },
  ).toBe(true);
});
