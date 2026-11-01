# P3.7 — Overture Building Composition & Architectural Metadata Evidence

**Status:** Implemented as a metadata/provenance gate; geometry generation and architectural acceptance remain blocked.  
**Branch:** `feat/p3-7-building-composition-evidence-20261102`  
**Base:** P3.6 validated head `6e5fd3fd68905e5098303f37d6f3e83b983ffcf6`

## Goal

P3.6 emits bounded footprint extrusions with source-derived vertical intervals. P3.7 makes the architectural information already present in Overture explicit and traceable, and audits parent/building-part references before the next roof/facade geometry stage.

This stage does **not** turn a property tag into a verified physical observation, and it does not yet generate roof or facade geometry. A value recorded as `source` means only that the source field is present and conforms to the pinned schema shape.

## Pinned upstream contract

The implementation is aligned to the Overture Buildings theme schema **v2.0.0**, tag `overture-schema-theme-buildings-v2.0.0` (schema repository commit `cb69ac3`).

Official references:
- [Building schema](https://docs.overturemaps.org/schema/reference/buildings/building/)
- [BuildingPart schema](https://docs.overturemaps.org/schema/reference/buildings/building_part/)
- [Buildings guide](https://docs.overturemaps.org/guides/buildings/)
- [Pinned v2.0.0 model source — Appearance and enums](https://github.com/OvertureMaps/schema/blob/overture-schema-theme-buildings-v2.0.0/packages/overture-schema-theme-buildings/src/overture/schema/buildings/_common.py)
- [Pinned v2.0.0 BuildingPart model](https://github.com/OvertureMaps/schema/blob/overture-schema-theme-buildings-v2.0.0/packages/overture-schema-theme-buildings/src/overture/schema/buildings/building_part.py)

The evidence resolver validates the following schema fields without guessing defaults:

| Field | Validation / meaning |
|---|---|
| `type` | Exact `building` or `building_part` value |
| `has_parts` | Boolean claim on a parent Building feature |
| `building_id` | Non-empty, whitespace-free string reference from a BuildingPart to its parent Building ID |
| `facade_color`, `roof_color` | `#rgb` / `#rrggbb` hex colors |
| `facade_material` | Exact v2.0.0 FacadeMaterial enum |
| `roof_material` | Exact v2.0.0 RoofMaterial enum |
| `roof_shape` | Exact v2.0.0 RoofShape enum |
| `roof_direction` | Finite number in `[0, 360)` degrees |
| `roof_orientation` | `along` or `across` |
| `roof_height` | Finite numeric source value; v2.0.0 defines float64 without a positivity bound. A non-positive value is retained as source metadata but marked not renderable by this geometry stage. |

Unknown enum values, incorrect casing, whitespace-padded identifiers, stringified numerics, booleans encoded as strings, malformed colors and non-finite numbers are not coerced into a plausible value. Every field receives an explicit `source`, `absent` or `invalid` status.

## Parent and part composition audit

The source-wide audit runs before package feature selection. It builds a parent index from `type=building` feature IDs, then resolves every `type=building_part` `building_id` against that complete FeatureCollection.

Part link states:
- `parent-feature-resolved`
- `parent-feature-not-in-source-extract`
- `ambiguous-duplicate-parent-feature-id`
- `missing-or-invalid-parent-id`

Parent states distinguish:
- `parts-found-and-declared`
- `parts-declared-but-none-in-source-extract`
- `parts-found-despite-false-has-parts-claim`
- `parts-found-has-parts-claim-unavailable`
- `no-parts-declared`
- `part-association-unknown`
- `ambiguous-duplicate-parent-feature-id`

The package records source relationship resolution separately from tile-subset selection. For a linked part, `parentSelectedInPackage` says whether its parent was also included in the bounded tile package. A source-valid relationship does not imply that the parent and part geometries have been merged into a single building model.

## Evidence binding

For every emitted tile:
1. The builder computes architecture metadata from the source feature's `properties`.
2. The source-wide composition audit adds the parent/part link record and whether related features are selected in the same package.
3. The resulting object is copied to the GLB `extras.architectureEvidence` and the matching build-manifest tile record.
4. The package and tileset carry derived architecture coverage and source composition summaries.
5. The independent alignment reviewer loads the hash-matched source feature, recomputes the architecture object and complete parent/part audit, then requires exact agreement across source, GLB, manifest, and summary records.

A consistently modified GLB and manifest still fails when the evidence disagrees with source properties. The reviewer also keeps the existing source-geometry, GLB-integrity, vertical-provenance and ECEF placement checks.

## Regression coverage

- All supported source enum/color/numeric fields; strict no-coercion behavior.
- Missing/invalid architecture metadata remains explicit.
- Building versus building_part classification.
- Valid parent links, missing parent IDs, parent absent from source, duplicate parent IDs, false `has_parts` claims despite actual parts, and parent/part selection mismatch inside the bounded package.
- GLB/manifest evidence drift and consistent GLB+manifest tampering against the original source feature.
- Aggregate availability summary refuses missing evidence records.

Run:
```bash
npm run test:building-architecture-evidence
npm run test:dhaka-3d-tiles-package
npm run test:dhaka-3d-tiles-package-alignment
```

## What is still not generated

P3.7 does **not** generate:
- gabled, hipped, dome or other roof meshes;
- facade planes, window/door openings, balcony/arch/column elements;
- textures or image-derived facade appearance;
- a unified parent/part assembly mesh.

The GLBs remain footprint extrusions. The report explicitly keeps `renderedArchitecturalDetailCount=0` and `geometryCompleteness=footprint-extrusion-only`. Parent/part link evidence is not a completed assembly.

Before P3.8 roof/facade composition work, the next gate is to inspect real Dhaka extract coverage for roof/facade metadata and valid parent/part links, then add only geometry cases with valid measurements and deterministic tests. Where metadata is absent, imagery must be independently permissioned, hash-bound, camera/scale reviewed and human checked; do not invent a style or feature.

## Release boundary

This implementation is schema and provenance evidence only. It does not prove building identity, rights for additional imagery, physical correctness of source attributes, absolute elevation, architectural likeness or 90% reconstruction accuracy. Keep `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false.
