# Facade selection and precise surface-insert placement

## Scope

This change improves the procedural generator's choice of front facade and aligns its generated window/door insert meshes to the exterior wall plane. It is a deterministic geometry-placement improvement, not image reconstruction or architectural truth.

## Selecting the front facade

BuildingSpec supports two optional, mutually exclusive selectors:

- `architecture.frontFacadeEdgeIndex`: zero-based index of an edge in the normalized outer footprint ring. Use this when the intended facade edge is known.
- `architecture.frontFacingAzimuthDegrees`: clockwise-from-north bearing from 0 through 360 degrees. The generator selects the outer edge whose outward normal is closest to the requested bearing.

If neither selector is supplied, the generator retains the longest-edge fallback. That result is explicitly marked `longest-edge-inferred`, reported with estimated confidence, emits a warning, and requires review. An azimuth more than 15 degrees away from its nearest footprint edge also emits a warning and requires review.

The normal calculation uses the signed area of the footprint ring, so clockwise and counter-clockwise ring winding both produce outward-facing facade frames. Evidence records attached to the selected edge/bearing are checked against the selector value; contradictory evidence downgrades confidence to `unknown`.

## Current coordinate-frame boundary

This task intentionally preserves the repository's existing `coordinateToLocalMeters` behavior: longitude/easting maps to model-local +X and latitude/northing maps to model-local +Z. A front bearing is therefore represented as `(sin(bearing), cos(bearing))` in the current local horizontal plane.

This is **not** a declaration that the current GLB axis convention is a validated canonical right-handed glTF map frame. The orientation conversion proposed by the historical PR #340 (including a +Z-south change and Blender camera changes) is deliberately not ported here. Any future frame migration must be handled as a separate cross-system change with Cesium placement, GLB metadata, renderer, camera, georeference and legacy-asset compatibility tests.

## Surface inserts

Window panes/frames and front doors/frames are placed in a facade-local frame:

- tangent offsets follow the selected edge;
- outward offsets follow its winding-aware exterior normal;
- the insert's inward-facing surface is kept 2 mm outside the wall's exterior plane;
- depth is retained independently for the glass/door and the thicker frame/jamb pieces.

The helper formula is `centerOffset = depth / 2 + faceClearance`. The default face clearance is 0.002 m. It rejects non-positive depths, non-finite values and clearances outside 0–0.05 m.

**Important geometry limitation:** the existing generator still emits solid wall panels. The glass and door meshes are positioned against the exterior face but the generator does not boolean-cut true wall openings. Do not describe this as BIM-grade openings or structural wall geometry.

## Validation

The focused BuildingSpec/generator tests cover:

- explicit edge index, azimuth selection and mutually exclusive/invalid selectors;
- nearest-edge azimuth matching and the 15-degree warning;
- door placement on the explicitly selected edge;
- window pane clearance/depth across every edge for both footprint windings;
- preservation of the existing +X east / +Z north local mapping.

The repository's existing `test:building-generation` CI script runs this regression suite. A passing test establishes the tested synthetic placement behavior only. It does not prove a real building's facade bearing, dimensions, orientation, architecture, image-to-model reconstruction, surveyed georeference or publication readiness. Non-verified facade selection keeps review required; `mapReady`, `publicationEligible` and `automaticApproval` remain fail-closed.
