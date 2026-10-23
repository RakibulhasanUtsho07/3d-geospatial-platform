# Feature-pick geometry

`resolveFeaturePickGeometry` owns the Cesium geometry work performed after a
building wins feature-pick routing:

- resolve click coordinates from depth picking, falling back to ellipsoid picking;
- derive a focus point from the building polygon's bounding sphere and rendered height;
- convert exterior and interior polygon rings to longitude/latitude and calculate
  approximate ground footprint area.

The helper returns data only. It does not choose which feature wins, update
selection state, emit UI events, mutate materials, or request a render; those
effects remain in `CesiumAdapter`.

Errors while resolving click coordinates are isolated from footprint calculation,
and footprint errors do not prevent a selection from being emitted. Footprint
area uses the existing local equirectangular approximation and is not intended
for survey or legal area certification.

Run `npm run test:feature-pick-geometry` for focused fallback, hole-area,
null-result, failure-isolation, and adapter-boundary regressions.
