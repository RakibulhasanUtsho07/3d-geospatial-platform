import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [controls, layers, properties, canvas, controller, adapter, engineTypes, benchmark] = await Promise.all([
  readFile(new URL("../src/features/map/components/MapControls.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/features/map/components/MapLayersPanel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/features/map/components/PropertyListingsPanel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/features/map/components/MapCanvas.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/core/map-engine/heritage-camera-controller.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/core/map-engine/types.ts", import.meta.url), "utf8"),
  readFile(new URL("../scripts/benchmark-map-browser.mjs", import.meta.url), "utf8"),
]);

test("camera controls start collapsed and expose an accessible toggle", () => {
  assert.match(controls, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(controls, /aria-expanded=\{expanded\}/);
  assert.match(controls, /aria-controls="map-camera-controls"/);
  assert.match(controls, /id="map-camera-controls"/);
  assert.match(controls, /label="Return to Dhaka property-discovery view"/);
});

test("layer list starts collapsed so it does not cover discovery/search controls", () => {
  assert.match(layers, /const \[expanded, setExpanded\] = useState\(false\)/);
  assert.match(layers, /aria-expanded=\{expanded\}/);
  assert.match(layers, /aria-controls="map-layers-list"/);
  assert.match(layers, /className=\{expanded \? "space-y-1 border-t border-white\/10 p-2" : "hidden"\}/);
});

test("property discovery starts collapsed to preserve the map viewport", () => {
  assert.match(properties, /const \[expanded, setExpanded\] = useState\(false\)/);
});

test("home and orientation reset are separate actions; home clears stale selection state", () => {
  assert.match(canvas, /onHome=\{goHomeToDefaultMapView\}/);
  assert.match(canvas, /onResetOrientation=\{resetMapOrientation\}/);
  const homeStart = canvas.indexOf("function goHomeToDefaultMapView()");
  const orientationStart = canvas.indexOf("function resetMapOrientation()");
  const landmarkStart = canvas.indexOf("function goToAhsanManzil()");
  assert.ok(homeStart >= 0 && orientationStart > homeStart && landmarkStart > orientationStart);
  const home = canvas.slice(homeStart, orientationStart);
  const orientation = canvas.slice(orientationStart, landmarkStart);
  assert.match(home, /engine\.resetHomeView\(\)/);
  assert.match(home, /engine\.clearFeatureSelection\(\)/);
  assert.match(home, /setSelectedPlace\(null\)/);
  assert.match(orientation, /engineRef\.current\?\.resetOrientation\(\)/);
  assert.doesNotMatch(orientation, /focusAhsanManzil/);
  assert.match(canvas, /Loading Dhaka 3D map/);
  assert.doesNotMatch(canvas, /Loading Ahsan Manzil 3D map/);
});

test("reset home camera cancels any flight, stops the orbit, and reapplies the Dhaka preset", () => {
  const start = controller.indexOf("resetHomeView(): void");
  const end = controller.indexOf("/** Front facade preset. */", start);
  assert.ok(start >= 0 && end > start, "resetHomeView method should exist");
  const body = controller.slice(start, end);
  assert.match(body, /this\.stopOrbitTour\(\)/);
  assert.match(body, /viewer\.camera\.cancelFlight\(\)/);
  assert.match(body, /this\.configureInitialCamera\(\)/);
  assert.match(body, /viewer\.scene\.requestRender\(\)/);
  assert.match(adapter, /resetHomeView\(\): void \{\s*this\.heritageCameraController\.resetHomeView\(\);\s*\}/);
  assert.match(engineTypes, /resetHomeView\(\): void/);
});

test("browser benchmark uses the actual loading overlay and waits for settled imagery", () => {
  assert.match(canvas, /data-testid="map-loading-overlay"/);
  assert.match(benchmark, /data-testid="map-loading-overlay"/);
  assert.doesNotMatch(benchmark, /text\.includes\("Loading Ahsan Manzil 3D map"\)/);
  assert.match(benchmark, /imageryTilesLoaded === true/);
  assert.match(benchmark, /async function waitForStableImagery/);
  assert.match(benchmark, /stableForMs/);
});
