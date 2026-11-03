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

These are metadata presence counts, not geometry or correctness counts. The exact dedicated-workflow artifact for this revision records:

- Source SHA-256: `f05f14b1cf983c823adf605dc3131f2cf3029afd8ac873d54017155d22fe5f90`
- Source bytes: `10,111,710`
- Report SHA-256: `c198c1ca00ba3f57f32bfac1a8c7fb9ab8182e3563a90bdb6cc78ce66b536b1f`
- Facade style (color or material present): 2,495 / 17,008 (14.6696%)
- Roof shape plus positive roof height: 1 / 17,008 (0.0059%)
- Feature IDs missing/invalid: 0; duplicate IDs: 0; source parent/part links: 15/15; extractor parent-ID conflicts: 0.
- Source provenance records: 17,008 across OpenStreetMap (15,657), Google Open Buildings (1,140) and Microsoft ML Buildings (211).
- A license value is present on 15,868 source records; 1,140 records have no license value in this extract. A source or provider record without a license value does not establish reuse permission.

These are metadata and provenance counts, not geometry, legal clearance or correctness counts. The dedicated CI workflow uploads the complete machine-generated report; its byte hash and report hash are authoritative for the tested extract revision. If the source extract changes, regenerate the report before using the counts.

## Release boundary

No roof/facade mesh, window, door, texture, imagery match or parent/part geometry assembly is generated. This task does not establish physical truth, survey accuracy, imagery rights, architectural likeness or 90% reconstruction accuracy. Keep acceptanceEligible, publicationEligible, mapReady and automaticApproval false.


## Final exact-head validation — PASS (2026-11-01)

The P3.8 implementation head `ff8a37b9ba1d75ea62259a7df6364a521fcdefa5` completed the exact-head checks:

- Full CI PR run [#41330328989](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41330328989): **PASS, 182/182 workflow steps; zero failures**. This includes lint, production build, production-server viewport API verification, browser integration and evidence artifact uploads.
- Dedicated P3.8/P3.6 PR workflow [#41330328994](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41330328994): **PASS, 31/31 steps**. The live Cesium multi-tile selective-fetch and controller lifecycle checks passed on that tested head.
- The PR #300 base is the P3.7 head `cd3eff7e7b557d2690a9d755bee1aef7d379b8be`; P3.7 Full CI [#41329725567](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41329725567) also completed successfully, 181/181.
- PR #300 remains Draft. There are no independent reviews or review threads. PR #299 also remains Draft and unreviewed. No merge was performed.

The validation establishes reproducible software/package behavior only. It does not create architectural geometry, prove source rights, confirm a real building's identity, establish survey accuracy, or authorize publication/map readiness. All four release flags remain false. A subsequent documentation-only commit changes the PR head and therefore requires its own exact-head CI before that updated head can be called fully validated.
