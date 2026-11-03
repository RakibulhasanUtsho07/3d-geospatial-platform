# P3.7 — Overture building composition and architectural metadata evidence

**Status:** Implemented as a source-bound metadata intake and validation slice; roof/facade geometry and parent/part assembly are not implemented here.  
**Branch:** `feat/p3-7-building-composition-evidence-20261102`  
**Parent implementation:** [P3.6 multi-building 3D Tiles package](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/275)

## Why this gate exists

P3.6 emits a deterministic footprint extrusion. The next stage must not infer roof shape, facade material, colors or separate building volumes simply because the renderer can draw them. Overture's current Buildings schema exposes typed fields for these values, and it separates a parent `building` from `building_part` features linked by `building_id`. A parent can set `has_parts=true`; its footprint is not proof that a single uniform extrusion is a complete model.

This slice records and validates those inputs before geometry generation. It is deliberately metadata-only.

## Current schema contract

The resolver pins its interpretation to Overture Buildings schema v2.0.0:
- `type`: `building` or `building_part`.
- `building_id`: parent identity for a building-part feature.
- `has_parts`: boolean part-presence declaration on a parent.
- `facade_color`: source hex color (`#rgb` or `#rrggbb`).
- `facade_material`: Overture facade-material enum.
- `roof_color`, `roof_material`, `roof_shape`, `roof_direction`, `roof_orientation`, and `roof_height`: validated source roof metadata.

References:
- [Building schema](https://docs.overturemaps.org/schema/reference/buildings/building/)
- [BuildingPart schema](https://docs.overturemaps.org/schema/reference/buildings/building_part/)
- [FacadeMaterial enum](https://docs.overturemaps.org/schema/reference/buildings/types/facade_material/)
- [RoofMaterial enum](https://docs.overturemaps.org/schema/reference/buildings/types/roof_material/)
- [RoofShape enum](https://docs.overturemaps.org/schema/reference/buildings/types/roof_shape/)
- [RoofOrientation enum](https://docs.overturemaps.org/schema/reference/buildings/types/roof_orientation/)

## Implementation

- `src/core/buildings/building-architecture-evidence.mjs` resolves source metadata with strict field typing and explicit per-field status: `source`, `absent`, or `invalid`.
- Unknown enum values, partial/coerced numbers, malformed colors, string booleans, and invalid roof directions are rejected as invalid evidence. The resolver does not use the generic visual-style palette as a substitute for missing source attributes.
- Parent `has_parts=true` is recorded as `parent-declares-associated-parts`; it is not marked as assembled. A `building_part` with a `building_id` is marked `building-part-parent-join-required`; a full parent/part assembly has not been generated.
- Every GLB extras record and build-manifest tile includes the same `architectureEvidence` object. The build manifest and tileset also include a summary of field coverage, composition states, and geometry completeness.
- The independent alignment reviewer recomputes architecture metadata from the exact source feature hash and rejects drift in the manifest or GLB. It also recomputes the aggregate field-coverage summary from the per-tile evidence.
- Regression tests cover valid enums, colors, roof dimensions and orientation, missing/invalid fields, parent/part declarations, coverage aggregation, manifest-only tampering, and GLB+manifest values rebound consistently but inconsistent with the source feature.

## Explicit limitations

This slice does **not** create gabled/hipped/domed roof meshes, facade panels, openings, balconies, windows, textures, or multi-part assembled buildings. The P3.6 GLB geometry remains `footprint-extrusion-only`; `renderedArchitecturalDetailCount` remains zero.

A `source` status proves that a value exists and matches the pinned schema shape. It does not prove that the source attribute describes the physical building accurately, and it is not human visual verification. An `absent` field must remain absent; an `invalid` field must not be coerced into a plausible-looking value.

The next geometry gate must first join parent and part records by `building_id`, check that part geometries are present and non-contradictory, then generate only roof/facade forms supported by validated source attributes or separately reviewed image evidence. Keep release flags false until rights, building identity, vertical reference, independent dimensions, and visual review are complete.
