import { expect, test, type Page } from "@playwright/test";

type ObservedRequests = {
  buildings: URL[];
  roads: URL[];
};

const SAMPLE_BUILDING_FEATURE_COLLECTION = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "qa-building-01",
      properties: {
        id: "qa-building-01",
        height: 16,
        building: "residential",
        "building:colour": "#2F6C96",
        "roof:colour": "#D8B044",
        "facade:material": "brick",
        architecture_style: "painted-mid-rise-apartment",
        facade_features: "symmetrical blue and yellow facade with balconies",
        subtype: "residential",
        _renderRole: "building",
        _renderPartCount: 0,
      },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [90.40598, 23.70854],
          [90.40612, 23.70854],
          [90.40612, 23.70867],
          [90.40598, 23.70867],
          [90.40598, 23.70854],
        ]],
      },
    },
  ],
};

const SAMPLE_ROADS = [
  {
    id: "qa-arterial-road",
    name: "QA Main Road",
    highway: "primary",
    roadClass: "arterial",
    widthMeters: 8,
    surface: "asphalt",
    layer: 0,
    bridge: false,
    tunnel: false,
    coordinates: [[90.4057, 23.70845], [90.4060, 23.70860], [90.4063, 23.70874]],
  },
  {
    id: "qa-local-road",
    name: "QA Local Street",
    highway: "residential",
    roadClass: "local",
    widthMeters: 3.2,
    surface: "concrete",
    layer: 0,
    bridge: false,
    tunnel: false,
    coordinates: [[90.4060, 23.70840], [90.4061, 23.70857], [90.4062, 23.70878]],
  },
  {
    id: "qa-bridge-road",
    name: "QA Elevated Connector",
    highway: "secondary",
    roadClass: "collector",
    widthMeters: 5,
    surface: "paving_stones",
    layer: 2,
    bridge: true,
    tunnel: false,
    coordinates: [[90.4058, 23.70850], [90.4059, 23.70864], [90.4060, 23.70880]],
  },
  {
    id: "qa-tunnel-path",
    name: "QA Underpass Walkway",
    highway: "footway",
    roadClass: "path",
    widthMeters: 1.2,
    surface: "gravel",
    layer: -1,
    bridge: false,
    tunnel: true,
    coordinates: [[90.4062, 23.70843], [90.40615, 23.70858], [90.4061, 23.70874]],
  },
];

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
      body: JSON.stringify(SAMPLE_BUILDING_FEATURE_COLLECTION),
    });
  });

  await page.route("**/api/geospatial/roads**", async (route) => {
    observed.roads.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results: SAMPLE_ROADS }),
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

  // Re-enable and reuse the same deterministic sample-road response.
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
      (url) => roadBoundsKey(url) !== boundsBeforeZoom,
    ),
    { timeout: 20_000 },
  ).toBe(true);
});

test("fixture building and roads pass through Cesium geometry staging with expected visual counts", async ({ page }) => {
  const summaries: {
    buildings: Array<{
      returnedFeatures?: number;
      renderedBuildings?: number;
      renderedExtrusions?: number;
      visualStyleSummary?: { facadePatterns?: string[]; facadeColors?: string[]; roofColors?: string[] };
    }>;
    roads: Array<{
      returnedWays?: number;
      renderedWays?: number;
      labelledRoads?: number;
      styleSummary?: {
        byClass?: Partial<Record<"arterial" | "collector" | "local" | "path", number>>;
        centreLineRoads?: number;
        taggedSurfaceRoads?: number;
        elevatedRoads?: number;
        tunnelRoads?: number;
        uniqueColors?: number;
        minWidthMeters?: number | null;
        maxWidthMeters?: number | null;
      };
    }>;
  } = { buildings: [], roads: [] };

  page.on("console", (message) => {
    const args = message.args();
    void Promise.all(args.map((arg) => arg.jsonValue().catch(() => null))).then((values) => {
      if (values[0] === "[Overture] Building viewport rendered." && values[1] && typeof values[1] === "object") {
        summaries.buildings.push(values[1] as typeof summaries.buildings[number]);
      }
      if (values[0] === "[Roads] Vector road viewport rendered." && values[1] && typeof values[1] === "object") {
        summaries.roads.push(values[1] as typeof summaries.roads[number]);
      }
    });
  });

  await stubMapNetwork(page);
  await openReadyMap(page);

  await expect.poll(
    () => summaries.buildings.some((summary) =>
      summary.returnedFeatures === 1 &&
      summary.renderedBuildings === 1 &&
      summary.renderedExtrusions === 1
    ),
    { timeout: 20_000 },
  ).toBe(true);

  await expect.poll(
    () => summaries.roads.some((summary) =>
      summary.returnedWays === 4 &&
      summary.renderedWays === 4 &&
      (summary.labelledRoads ?? 0) >= 1
    ),
    { timeout: 20_000 },
  ).toBe(true);

  // Inspect the runtime summaries emitted after the Cesium entities are built.
  // This checks actual style-policy application, not only the standalone style function.
  await expect.poll(
    () => summaries.buildings.some((summary) =>
      summary.visualStyleSummary?.facadePatterns?.includes("painted-balcony") &&
      summary.visualStyleSummary?.facadeColors?.includes("#2f6c96") &&
      summary.visualStyleSummary?.roofColors?.includes("#d8b044")
    ),
    { timeout: 20_000 },
  ).toBe(true);

  await expect.poll(
    () => summaries.roads.some((summary) => {
      const styles = summary.styleSummary;
      if (!styles?.byClass) return false;
      return styles.byClass.arterial === 1 &&
        styles.byClass.collector === 1 &&
        styles.byClass.local === 1 &&
        styles.byClass.path === 1 &&
        styles.centreLineRoads === 1 &&
        styles.taggedSurfaceRoads === 4 &&
        styles.elevatedRoads === 1 &&
        styles.tunnelRoads === 1 &&
        styles.uniqueColors === 4 &&
        styles.minWidthMeters === 1.2 &&
        styles.maxWidthMeters === 8;
    }),
    { timeout: 20_000 },
  ).toBe(true);
});


test("selecting a building then a road clears the previous details panel", async ({ page }) => {
  test.setTimeout(60_000);
  const observed = await stubMapNetwork(page);
  await openReadyMap(page);
  await expect.poll(() => observed.buildings.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => observed.roads.length, { timeout: 15_000 }).toBeGreaterThan(0);

  // Center the test fixture in the viewport so canvas clicks are deterministic.
  await page.getByRole("button", { name: "North-up top-down view of Ahsan Manzil" }).click();
  await page.waitForTimeout(1_000);

  const canvas = page.getByTestId("cesium-map-container").locator("canvas").first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const center = { x: box!.width / 2, y: box!.height / 2 };

  // The fixture footprint is centered on the map's provisional Ahsan Manzil
  // anchor; in top-down mode the centre pixel should select its roof.
  // Use absolute page coordinates so the canvas locator's actionability
  // checks do not mask an actual Cesium pointer/pick regression.
  await page.mouse.click(box!.x + center.x, box!.y + center.y);
  const buildingDetails = page.getByRole("complementary", { name: "Building details" });
  await expect(buildingDetails).toBeVisible({ timeout: 10_000 });
  await expect(buildingDetails.getByRole("heading", { name: "Selected 3D Building" })).toBeVisible();

  // Hide the selected footprint to expose the road corridor beneath it.
  // A click on that same fixture location should replace—not stack—the panel.
  const buildings = page.getByRole("checkbox", { name: "Overture 3D buildings" });
  await buildings.uncheck({ noWaitAfter: true });
  await expect(buildings).not.toBeChecked();
  await page.mouse.click(box!.x + center.x, box!.y + center.y);

  const roadDetails = page.getByRole("complementary", { name: "Selected road details" });
  await expect(roadDetails).toBeVisible({ timeout: 10_000 });
  await expect(roadDetails.getByRole("heading", { name: "QA Main Road" })).toBeVisible();
  await expect(buildingDetails).toHaveCount(0);

  await roadDetails.getByRole("button", { name: "Close road details" }).click();
  await expect(roadDetails).toHaveCount(0);
});
