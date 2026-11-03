# P3.6–P3.8 — Main-based reconciliation note

Based on the current D3M-01→D3M-07 main candidate. Non-overlap P3 files are included from the cumulative P3.8 head. Workflow, package and roadmap conflicts are merged additively. Main's D3M tests and generation-queue capability tests are retained; P3's older shorter generation-queue script is not copied.

## Output-path safety
The package builder now uses `lstat` to reject symlinked path components, requires a regular source file and a directory output target, and rejects an output path equal to or containing the input GeoJSON before recursive replacement. Regression tests assert that the source and an existing package remain unchanged on rejection. This reduces path-alias risk but is not a race-free OS sandbox.

## P3 limits
The output is footprint extrusion/cuboid massing. P3.7 is source metadata/composition evidence, not generated roof/facade/window/door/texture geometry or parent/part assembly. P3.8 reports metadata coverage, not rights clearance. Of the 17,008 inspected source features, 15,868 have license metadata and 1,140 do not; exact source terms still require review. Height defaults remain labelled estimates; no surveyed vertical datum. `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` remain false.
