# Procedural building facade placement

## Selecting the entrance facade

A BuildingSpec may set `architecture.frontFacadeEdgeIndex` to an integer edge index from the normalized outer GeoJSON footprint ring. The closing duplicate coordinate is removed during normalization, so valid indexes range from `0` through `vertexCount - 1`.

When omitted, the generator preserves the legacy behavior and selects the longest footprint edge. The report records this as `longest-edge-inferred` with `confidence: estimated`, emits a warning and keeps the candidate review-required. An explicit selection is recorded as `explicit-edge-index` with `confidence: operator-specified`; the selection is an operator declaration, not independently verified building orientation.

The selected edge controls the entrance door, front balconies, central dome inset and front arcade. Windows continue to be generated along all supported exterior edges.

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
