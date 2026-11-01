# P3.8 — Full Dhaka Overture architecture coverage audit

## Objective

Measure the architecture metadata in the complete repository Dhaka FeatureCollection before implementing roof, facade or parent/part geometry. The report is source-hash-bound and deterministic for the same source bytes and code revision.

## Run

~~~bash
npm run test:dhaka-overture-architecture-coverage
npm run audit:dhaka-overture-architecture-coverage -- --source data/overture/dhaka-buildings-3d-pilot.geojson --output artifacts/dhaka-overture-architecture-coverage.json
~~~

The JSON report includes input SHA-256 and byte length, normalized role counts, source-field coverage by role, Overture source provenance, parent/part linkage results, and four disabled release flags.

## Evidence interpretation

- Overture's original properties.type field is counted separately from the extractor-added properties._renderRole field.
- The role audit uses the normalized extractor role to classify building, building_parent and building_part. It never claims that an extractor field was present in the original Overture properties.
- building_id and _parentBuildingId must agree when both are present. A part is linked only when exactly one parent feature resolves.
- Field states are source, absent, invalid, extractor-derived, or missing-evidence. No malformed value is coerced into a valid field.
- A roof shape and positive roof_height identify metadata coverage only. No roof mesh is emitted by this task.

## Full extract inspection — 2026-11-01

The committed extract contains 17,008 features: 16,986 regular building roles, 7 building_parent roles and 15 building_part roles. All 15 parts resolve to one of the seven parent-role features using building_id, and all 15 extractor _parentBuildingId values agree with building_id.

Initial metadata inspection across all 17,008 features found:
- facade_material: 2,495 features
- facade_color: 1 feature
- roof_color: 9 features
- roof_material: 2 features
- roof_shape: 10 features
- roof_direction: 1 feature
- roof_orientation: 0 features
- roof_height: 1 feature

These are metadata presence counts, not geometry or correctness counts. The dedicated CI workflow uploads the complete machine-generated report; its byte hash and report hash are authoritative for the tested extract revision. If the source extract changes, regenerate the report before using the counts.

## Release boundary

No roof/facade mesh, window, door, texture, imagery match or parent/part geometry assembly is generated. This task does not establish physical truth, survey accuracy, imagery rights, architectural likeness or 90% reconstruction accuracy. Keep acceptanceEligible, publicationEligible, mapReady and automaticApproval false.
