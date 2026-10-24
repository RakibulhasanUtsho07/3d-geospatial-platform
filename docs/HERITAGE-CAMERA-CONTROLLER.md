# P1.2 — Heritage Camera Controller

The Ahsan Manzil camera preset and guided-orbit lifecycle now has a dedicated owner instead of being embedded in the 130 KB Cesium adapter.

## Responsibilities

- Initial Dhaka property-discovery camera composition positioned inside the committed Overture building-data bounds.
- Explicit Ahsan Manzil front/rear/side/whole-footprint/top-down presets and guided orbit.
- Front, rear, side, whole-footprint and top-down presets.
- Manual heading orbit controls.
- Guided 360-degree orbit.
- Cancelling the animation frame and detaching pointer, wheel and touch listeners.
- Stopping safely if the current Viewer is destroyed or replaced.

## Compatibility and lifecycle

\`CesiumAdapter\` preserves its existing public \`focusAhsanManzil*\`, \`orbitAhsanManzil\`, \`startAhsanManzilOrbitTour\` and \`stopAhsanManzilOrbitTour\` methods as delegates. The initial camera uses `DEFAULT_DHAKA_MAP_CAMERA` from `src/core/geospatial/default-map-camera.mjs`. The target is checked against `data/overture/dhaka-buildings.geojson.state` so startup requests overlap known building-data coverage. Ahsan Manzil remains an explicit heritage preset; its provisional anchor is south of the current pilot coverage, so it is no longer the automatic first view.

The controller accesses the current Viewer/Cesium module through getters. A stale animation tick cannot continue controlling a replacement viewer. \`destroy()\` clears the stopped callback before cleaning up so React teardown does not schedule a stale state update.

## Validation

- \`npm run test:heritage-camera-controller-boundary\` checks delegation and the important lifecycle guardrails.
- CI lint and production build verify TypeScript integration.
- Existing browser tests exercise map initialization, mouse drag, zoom and layer toggles.

## Next extraction

The next separate slice is road rendering/request lifecycle. Keep road request cancellation and map viewport fetch/staging separate so each can be tested against the current cache and stale-request semantics.
