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

This does **not** certify the current GLB as a canonical geospatial frame or change any vertex coordinates. Generated GLBs now carry a versioned `extras.building.facadeOrientation` record containing the selected edge, outward normal, azimuth, selector source, confidence and review-required flag. The coordinate frame is explicitly recorded as `glTF-local:+X=east,+Y=up,+Z=north`.

The Blender review wrapper reads that metadata from the exact model bytes and converts the horizontal normal using the glTF-import convention `Blender X = glTF X`, `Blender Y = -glTF Z`, with Blender Z used for camera elevation. The five-degree front camera is aligned to that converted normal; the GLB vertices, Cesium placement, source-camera calibration and other review views are unchanged. The final render manifest records both the source normal and Blender camera direction, and adds a human-review warning when the orientation is not verified.

Legacy GLBs without this metadata retain the previous generic front-camera behavior. A malformed declared orientation is rejected rather than silently guessed. This camera alignment only tells the reviewer which facade the generator selected; it does not prove that the facade faces that compass direction in the real world.

The historical PR #340 +Z-south frame migration remains out of scope. A future full frame migration still requires coordinated Cesium placement, model transforms, georeference and legacy-asset compatibility tests.

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


## GLB orientation metadata and Blender review camera

The generator writes the same `facadeOrientation` object to GLB extras and the generation report. Its versioned record includes the coordinate frame, selection method, edge index, requested/actual azimuth, outward normal, confidence, selector source and review-required flag.

The review wrapper validates the GLB JSON chunk and metadata before launching Blender. It maps the model-local outward normal `(x, z)` to Blender's imported horizontal axes `(x, -z)`, adds a fixed five-degree camera elevation, and passes the result to Blender. The raw render manifest echoes the source normal and converted camera direction; the Node wrapper checks the metadata against the exact input GLB before the final manifest is accepted.

This is a review-camera alignment only. It does not generate a surveyed compass orientation, compare the render to a reference photograph, prove model correctness, or change publication gates. An inferred/operator-specified/non-verified direction is explicitly retained as review-required.


## Central-dome anchor selection

When `architecture.centralDome.enabled` is true, BuildingSpec supports two explicit placement rules:

- `front-facade-inset` (default): preserves the existing behavior by centering the dome on the selected front-facade edge and moving it inward by `insetFromFrontM`.
- `footprint-bounds-center`: places the dome at the midpoint of the footprint's axis-aligned local `minX/maxX/minZ/maxZ` bounds. In this mode `insetFromFrontM` is retained in the spec but does not affect the center.

The generated report records the selected anchor, model-local X/Z center, an estimated placement confidence and a review-required flag. A central dome is a procedural massing assumption even when its anchor is explicitly selected; the report therefore keeps review required and emits a warning. The bounds-center option is **not** a polygon centroid or an architectural measurement, and it can be inappropriate for an asymmetric/concave footprint. Verify it against an independent plan, survey or elevation before accepting the model.
