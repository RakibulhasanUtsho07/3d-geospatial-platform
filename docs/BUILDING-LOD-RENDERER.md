# Building LOD Renderer

## Purpose

Keep Cesium-specific facade/roof graphics and style-cache transitions out of `CesiumAdapter`, while preserving the existing adapter API and camera-driven LOD policy.

## Renderer responsibilities

- Create and reuse polygon style properties, textured facade walls and illustrative roof equipment.
- Apply lightweight extrusion and detailed facade graphics transitions.
- Preserve cache telemetry for polygon styles, facade walls and roof equipment.
- Calculate facade texture repetition and stable entity-ID variation.

## Adapter responsibilities retained

- Decide when to recompute LOD and which records are detailed.
- Own selected-building state and original materials.
- Provide selection/highlight callbacks so transitions do not overwrite the selected building's source materials.
- Own viewport fetch/staging, camera state, layer visibility and render requests.

## Verification

Run `npm run test:building-lod-renderer` and `npm run test:building-lod-policy`. The standard CI also runs the facade-budget, optimization, browser/API and production-build checks.

This is an ownership refactor; no FPS improvement is claimed without a real-data benchmark.
