# Map viewport UX repair

**Scope:** narrow UI/camera reliability batch on `feat/map-viewport-ux-repair`, based on the current `development` baseline. This is not a release-completion claim.

## Problems found in the 2026-10-25 real-Dhaka browser baseline

- The map layer list at the lower left expanded into the search/nearby-place controls.
- The property discovery form opened tall by default at the upper right while camera controls were also pinned to the same corner.
- The camera "Home" action sent users to the Ahsan Manzil heritage preset even though the application startup view is the Dhaka Overture/property-discovery camera. "Reset orientation" made the same inappropriate navigation instead of only resetting the current camera orientation.
- The map loading overlay said "Loading Ahsan Manzil" even during Dhaka property discovery.

## Changes

- Camera controls are collapsed behind an accessible toggle and placed below the top edge.
- The layer list is collapsed by default; layer visibility is unchanged until the user changes a checkbox.
- Property discovery opens collapsed by default; all filter fields remain available when expanded.
- Home cancels active camera/selection/navigation state and returns to the configured Dhaka property-discovery preset.
- Reset orientation now invokes the camera orientation reset without flying to a landmark.
- Loading status now refers to the Dhaka map.

## Verification and non-goals

The `tests/map-viewport-ux.test.mjs` source-contract tests protect these behaviors in CI. Full ESLint, TypeScript/production build, map integration and browser checks must pass on the exact reviewed head before merge.

This batch does **not** fix or explain the one-off bright red imagery/overlay artifact observed in an earlier real-Dhaka screenshot. That issue remains open for a separate reproduction and layer/material lifecycle investigation. It also does not claim surveyed building accuracy or visual acceptance for heritage proxy models.

## Additional readiness correction

The real-Dhaka browser benchmark previously recognized only the old text "Loading Ahsan Manzil 3D map". Once the app label was corrected to "Loading Dhaka 3D map", that string check could incorrectly treat a still-loading map as ready. The benchmark now watches the actual loading-overlay test ID and requires the Cesium viewer, at least one imagery layer, and `scene.globe.tilesLoaded`. It also requires imagery readiness to remain true for 750 ms before writing a screenshot, and records that readiness state in each result. This reduces timing-related ambiguity for the red ground artifact seen in one earlier capture, but does not declare its root cause fixed until a rerun confirms it disappears.
