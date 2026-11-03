# Procedural building facade placement

## Selecting the entrance facade

A BuildingSpec may set `architecture.frontFacadeEdgeIndex` to an integer edge index from the normalized outer GeoJSON footprint ring. The closing duplicate coordinate is removed during normalization, so valid indexes range from `0` through `vertexCount - 1`.

When omitted, the generator preserves the legacy behavior and selects the longest footprint edge. The report records this as `longest-edge-inferred` with `confidence: estimated`, emits a warning and keeps the candidate review-required. An explicit edge selection is recorded as `explicit-edge-index` with `confidence: operator-specified`; the selection is an operator declaration, not independently verified building orientation.

Alternatively, `architecture.frontFacingAzimuthDegrees` may specify a compass bearing clockwise from north in the model frame (`x=east, y=up, z=north`). The generator selects the footprint edge whose outward normal is closest to that bearing. If the nearest edge differs by more than 15 degrees, it emits a warning and keeps the candidate review-required. Do not set both selectors; ambiguous input is rejected. The resolved geometric bearing and its provenance are stored in GLB extras for downstream multi-view rendering. This metadata is still model-authoring input/geometry-derived output, not survey proof.

The front-camera renderer consumes the GLB bearing when present; older GLBs without the extra retain the deterministic legacy camera direction. The render manifest records whether the direction came from GLB metadata or the renderer default. Neither source independently verifies the physical entrance orientation.

The selected edge controls the entrance door, front balconies, central dome front-inset and front arcade. Windows continue to be generated along all supported exterior edges.

The central dome supports two explicit anchors: `front-inset` (the backward-compatible default) and `footprint-bounds-center`. The latter uses the center of the local footprint axis-aligned bounds and is useful for centrally placed roof domes. The report records the chosen anchor, center coordinates and evidence confidence. A bounds-center anchor does not imply that the real dome is centered; the input confidence and independent review still govern that claim.

## Local facade coordinate frame

The generator derives a tangent along each edge and an exterior normal from the signed footprint area. The box local X axis follows the facade tangent; the insert offset follows the exterior normal. This keeps placement consistent when the input polygon winding is reversed.

Window panes, frames, door and jambs use depth-aware center offsets. Their inner face is placed 2 mm outside the facade plane by default. Jamb offsets are measured along the facade tangent, not the global X axis.

## Limits

This workflow assumes a valid, non-self-intersecting footprint and a single outer ring. The facade edge index does not infer a compass bearing or establish a true entrance from imagery. It is an explicit model-authoring hint. Generated doors and windows remain procedural boxes and are not proof of openings in the real building.

The focused regression suite is:

```bash
npm run test:building-generation
```

It covers rotated facade frames, surface clearance, both footprint windings, selected-front behavior and invalid edge indexes. Passing the tests proves these geometric contracts for the synthetic fixture only.
