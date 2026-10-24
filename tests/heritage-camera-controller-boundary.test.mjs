import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const adapterPath = path.join(root, "src/core/map-engine/cesium-adapter.ts");
const controllerPath = path.join(root, "src/core/map-engine/heritage-camera-controller.ts");

test("CesiumAdapter delegates heritage camera actions and initial camera setup", async () => {
  const source = await readFile(adapterPath, "utf8");
  assert.match(source, /import\s+\{\s*HeritageCameraController\s*\}\s+from\s+["']\.\/heritage-camera-controller["']/);
  assert.match(source, /private readonly heritageCameraController\s*=\s*new HeritageCameraController/);
  assert.match(source, /this\.heritageCameraController\.configureInitialCamera\(\)/);
  assert.match(source, /focusAhsanManzil\(durationMs = 1200\): void\s*\{\s*this\.heritageCameraController\.focusFront\(durationMs\);/);
  assert.match(source, /focusAhsanManzilRear\(durationMs = 850\): void\s*\{\s*this\.heritageCameraController\.focusRear\(durationMs\);/);
  assert.match(source, /focusAhsanManzilSide\(durationMs = 850\): void\s*\{\s*this\.heritageCameraController\.focusSide\(durationMs\);/);
  assert.match(source, /focusAhsanManzilWhole\(durationMs = 900\): void\s*\{\s*this\.heritageCameraController\.focusWhole\(durationMs\);/);
  assert.match(source, /focusAhsanManzilTopDown\(durationMs = 850\): void\s*\{\s*this\.heritageCameraController\.focusTopDown\(durationMs\);/);
  assert.match(source, /startAhsanManzilOrbitTour\(onStopped\?: \(\) => void\): void\s*\{\s*this\.heritageCameraController\.startOrbitTour\(onStopped\);/);
  assert.match(source, /stopAhsanManzilOrbitTour\(\): void\s*\{\s*this\.heritageCameraController\.stopOrbitTour\(\);/);
});

test("HeritageCameraController owns animation/input cleanup and guards stale viewers", async () => {
  const source = await readFile(controllerPath, "utf8");
  for (const expected of [
    "requestAnimationFrame",
    "cancelAnimationFrame",
    'canvas.removeEventListener("pointerdown"',
    'canvas.removeEventListener("wheel"',
    'canvas.removeEventListener("touchstart"',
    "activeViewer !== viewer",
    "this.stoppedCallback = null;",
    "destroy(): void",
    "this.getViewer()",
    "this.getCesium()",
  ]) assert.ok(source.includes(expected), "Missing camera lifecycle guard: " + expected);
  assert.match(source, /if \(wasActive\) callback\?\.\(\)/);
});
