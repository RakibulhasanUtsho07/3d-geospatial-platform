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

test("3D map initializes and layer switches remain in sync", async ({ page }) => {
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
  await expect(
    page.getByRole("button", { name: "Zoom in" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Zoom out" }),
  ).toBeEnabled();

  await imagery.uncheck();
  await expect(imagery).not.toBeChecked();
  await imagery.check();
  await expect(imagery).toBeChecked();

  await roads.uncheck();
  await expect(roads).not.toBeChecked();
  await roads.check();
  await expect(roads).toBeChecked();

  await buildings.uncheck();
  await expect(buildings).not.toBeChecked();
  await buildings.check();
  await expect(buildings).toBeChecked();

  expect(observed.buildings.length).toBeGreaterThan(0);
  expect(observed.roads.length).toBeGreaterThan(0);
});

test("zooming and dragging the map request fresh road viewport bounds", async ({ page }) => {
  const observed = await stubMapNetwork(page);
  await openReadyMap(page);
  await expect.poll(() => observed.roads.length, { timeout: 20_000 }).toBeGreaterThan(0);

  // Let the initial camera preset settle so the next requests belong to this test.
  await page.waitForTimeout(900);
  const initialUrl = observed.roads.at(-1);
  expect(initialUrl).toBeDefined();
  const initialBounds = roadBoundsKey(initialUrl!);
  const beforeZoomCount = observed.roads.length;

  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();

  await expect.poll(
    () => observed.roads.slice(beforeZoomCount).some(
      (url) => roadBoundsKey(url) !== initialBounds,
    ),
    { timeout: 20_000 },
  ).toBe(true);

  // Wait out any additional move-end event before recording the pan baseline.
  await page.waitForTimeout(400);
  const canvas = page.getByTestId("cesium-map-container").locator("canvas").first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();

  const lastRoadUrlBeforePan = observed.roads.at(-1);
  expect(lastRoadUrlBeforePan).toBeDefined();
  const boundsBeforePan = roadBoundsKey(lastRoadUrlBeforePan!);
  const beforePanCount = observed.roads.length;
  const startX = box!.x + box!.width * 0.45;
  const startY = box!.y + box!.height * 0.5;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 320, startY + 70, { steps: 10 });
  await page.mouse.up();

  await expect.poll(
    () => observed.roads.slice(beforePanCount).some(
      (url) => roadBoundsKey(url) !== boundsBeforePan,
    ),
    { timeout: 20_000 },
  ).toBe(true);
});
