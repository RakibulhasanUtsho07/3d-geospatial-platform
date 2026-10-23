import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { calculateFootprintAreaM2 } from "../src/core/geospatial/footprint-area.mjs";
import { resolveFeaturePickGeometry } from "../src/core/map-engine/feature-pick-geometry.mjs";

const radiansToDegrees = (value) => value * 180 / Math.PI;
const point = (longitude, latitude, height = 0) => ({ longitude, latitude, height });

function fakeCesium(center = point(0.0005, 0.0005, 0)) {
  return {
    JulianDate: { now: () => ({ now: true }) },
    Cartographic: { fromCartesian: (position) => position },
    Math: { toDegrees: radiansToDegrees },
    BoundingSphere: {
      fromPoints(positions) {
        assert.ok(positions.length >= 3);
        return { center };
      },
    },
  };
}

function squareHierarchy() {
  return {
    positions: [
      point(0, 0),
      point(0.001, 0),
      point(0.001, 0.001),
      point(0, 0.001),
    ],
    holes: [{
      positions: [
        point(0.0003, 0.0003),
        point(0.0007, 0.0003),
        point(0.0007, 0.0007),
        point(0.0003, 0.0007),
      ],
    }],
  };
}

function makePolygon(hierarchy) {
  return { hierarchy: { getValue: () => hierarchy } };
}

function degreesRings(hierarchy) {
  const convert = (positions) => positions.map((position) => ({
    longitude: radiansToDegrees(position.longitude),
    latitude: radiansToDegrees(position.latitude),
  }));
  return [
    convert(hierarchy.positions),
    ...(hierarchy.holes ?? []).map((hole) => convert(hole.positions)),
  ];
}

test("depth-picked click coordinates and building focus include rendered height", () => {
  const clickPosition = point(0.0002, 0.0003, 21);
  let ellipsoidFallbackCalls = 0;
  const viewer = {
    scene: {
      pickPositionSupported: true,
      pickPosition: (screenPosition) => {
        assert.deepEqual(screenPosition, { x: 20, y: 30 });
        return clickPosition;
      },
      globe: { ellipsoid: {} },
    },
    camera: {
      pickEllipsoid() {
        ellipsoidFallbackCalls += 1;
        return null;
      },
    },
  };
  const hierarchy = squareHierarchy();
  const result = resolveFeaturePickGeometry({
    viewer,
    Cesium: fakeCesium(),
    screenPosition: { x: 20, y: 30 },
    polygon: makePolygon(hierarchy),
    baseHeight: 4,
    heightMeters: 32,
  });

  assert.deepEqual(result.coordinates, {
    longitude: radiansToDegrees(clickPosition.longitude),
    latitude: radiansToDegrees(clickPosition.latitude),
    height: 21,
  });
  assert.deepEqual(result.focusCoordinates, {
    longitude: radiansToDegrees(0.0005),
    latitude: radiansToDegrees(0.0005),
    height: 36,
  });
  const withHole = calculateFootprintAreaM2(degreesRings(hierarchy));
  const withoutHole = calculateFootprintAreaM2([degreesRings(hierarchy)[0]]);
  assert.equal(result.footprintAreaM2, withHole);
  assert.ok(result.footprintAreaM2 > 0);
  assert.ok(result.footprintAreaM2 < withoutHole);
  assert.equal(ellipsoidFallbackCalls, 0);
});

test("ellipsoid fallback works when depth picking is unsupported", () => {
  const ellipsoidPosition = point(0.004, 0.006, 12);
  let depthPickCalls = 0;
  const viewer = {
    scene: {
      pickPositionSupported: false,
      pickPosition() {
        depthPickCalls += 1;
        throw new Error("must not call unsupported depth picking");
      },
      globe: { ellipsoid: { id: "earth" } },
    },
    camera: {
      pickEllipsoid(screenPosition, ellipsoid) {
        assert.deepEqual(screenPosition, { x: 5, y: 6 });
        assert.deepEqual(ellipsoid, { id: "earth" });
        return ellipsoidPosition;
      },
    },
  };
  const result = resolveFeaturePickGeometry({
    viewer,
    Cesium: fakeCesium(),
    screenPosition: { x: 5, y: 6 },
    polygon: makePolygon({ positions: [point(0, 0), point(0.1, 0)] }),
    baseHeight: 0,
    heightMeters: 10,
  });

  assert.equal(depthPickCalls, 0);
  assert.deepEqual(result.coordinates, {
    longitude: radiansToDegrees(0.004),
    latitude: radiansToDegrees(0.006),
    height: 12,
  });
  assert.equal(result.focusCoordinates, null);
  assert.equal(result.footprintAreaM2, null);
});

test("coordinate lookup failure does not suppress footprint calculation", () => {
  const hierarchy = squareHierarchy();
  const result = resolveFeaturePickGeometry({
    viewer: {
      scene: {
        pickPositionSupported: true,
        pickPosition() {
          throw new Error("depth buffer unavailable");
        },
        globe: { ellipsoid: {} },
      },
      camera: { pickEllipsoid: () => null },
    },
    Cesium: fakeCesium(),
    screenPosition: { x: 1, y: 2 },
    polygon: makePolygon(hierarchy),
    baseHeight: 3,
    heightMeters: 7,
  });

  assert.equal(result.coordinates, null);
  assert.equal(result.focusCoordinates.height, 10);
  assert.ok(result.footprintAreaM2 > 0);
});

test("empty polygon hierarchy returns null focus and footprint values", () => {
  const result = resolveFeaturePickGeometry({
    viewer: {
      scene: {
        pickPositionSupported: false,
        globe: { ellipsoid: {} },
      },
      camera: { pickEllipsoid: () => null },
    },
    Cesium: fakeCesium(),
    screenPosition: { x: 0, y: 0 },
    polygon: makePolygon({ positions: [] }),
    baseHeight: 0,
    heightMeters: 0,
  });

  assert.equal(result.coordinates, null);
  assert.equal(result.focusCoordinates, null);
  assert.equal(result.footprintAreaM2, null);
});

test("CesiumAdapter delegates geometry calculation to the extracted helper", async () => {
  const adapter = await readFile(
    new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url),
    "utf8",
  );
  assert.match(adapter, /from "\.\/feature-pick-geometry\.mjs"/);

  const start = adapter.indexOf("private handleFeaturePick(");
  const end = adapter.indexOf("\n  destroy(): void {", start);
  assert.ok(start >= 0 && end > start, "feature-picking handler should exist");
  const handler = adapter.slice(start, end);
  assert.match(handler, /resolveFeaturePickGeometry\(\{/);
  assert.match(handler, /screenPosition: movement\.position/);
  assert.doesNotMatch(handler, /BoundingSphere\.fromPoints/);
  assert.doesNotMatch(handler, /calculateFootprintAreaM2/);
  assert.match(handler, /this\.emitFeatureSelection\(\{/);
});
