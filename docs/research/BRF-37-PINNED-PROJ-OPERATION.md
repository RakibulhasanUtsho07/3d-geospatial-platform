# BRF-37 — explicitly pinned PROJ operation execution

**Status:** executor contract and synthetic integration tests; the real BRF-36 operation manifest remains blocked pending human review and exact local byte pins.  
**Tracking:** [BRF-37 issue #252](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/252), parent [BRF-36 issue #250](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/250).

## Safety boundary

This runner executes only a locally supplied operation definition that has explicit review metadata and exact SHA-256/byte-size pins. It verifies the local operation definition, local proj.db, and every grid the definition references. It invokes cct without a shell and sets PROJ_NETWORK=OFF; it never downloads assets or grids. Missing, changed, unlisted or path-escaping inputs block execution. Definitions that contain vertical grid shifts, geocentric conversion, Helmert steps, or explicit Z-axis parameters are refused by this horizontal-only executor.

The review fields are recorded provenance, not a cryptographic proof that a reviewer or authority approved the operation. A caller-provided operation name, URL, registry listing or nominal accuracy alone is not accepted as proof of applied transformation. The full operation definition and all required bytes are the execution pins.

The executor is deliberately horizontal 2D and accepts easting/northing in metres. Each control vector also carries a reviewer-supplied longitude/latitude point checked against the operation area-of-use bounds. The runner verifies that geographic check point is in range; it does not independently prove that the point corresponds to the projected input pair, so that correspondence must be documented by the reviewer. No source height is sent to cct; the CLI receives literal zero placeholders only for its unused trailing Z/time columns, and the report evaluates XY only. Vertical datum and ULS height reference remain separate, unresolved evidence items. It records control-vector numerical differences but always reports accuracyPassed=false and all release flags false. Execution reproducibility is not physical-building identity, source rights, or real-building accuracy certification.

## Current real benchmark manifest

The file benchmarks/building-reconstruction/brf-37-proj-operation.json is intentionally pending review. It names the proposed CRS pair (EPSG:25832 to EPSG:32632) but does not choose a candidate operation, does not contain an operation pipeline or grids, and cannot execute until those are reviewed and pinned. Do not fill in a guessed vertical transform or infer it from a horizontal operation.

The declared database version is kept separately from the exact proj.db byte hash. The hash identifies the actual database bytes used; a version string on its own is not byte verification. All operation-definition, database and grid paths must be local, root-contained files without symlinks.

## Run

~~~bash
npm run test:brf37-proj-operation
node scripts/run-brf37-proj-operation.mjs \
  benchmarks/building-reconstruction/brf-37-proj-operation.json \
  --asset-root . \
  --report artifacts/brf37-proj-operation-report.json
~~~

The real benchmark command should return exit code 2 and a reason-coded blocked report until the operation review record, operation definition, PROJ version, database pin, required grid pins, area-of-use bounds and control vectors are supplied. A passing synthetic CI integration only verifies that the runner and cct plumbing operate; it does not turn this manifest into an approved operation.

## Reproducible workflow

1. Discover options with projinfo constrained to the source/target CRS and source-building area of use. Review the selected result rather than accepting the first candidate.
2. Capture the full chosen PROJ definition, operation ID, nominal accuracy, area of use, axis order, input/output units, PROJ version, database version and required grids.
3. Acquire the exact definition, proj.db and grids locally, then pin SHA-256 and byte counts. Do not fetch grids at runtime.
4. Provide reviewed, independently documented test vectors with source and expected target coordinates and a stated numeric tolerance. Repeat runs must yield the same pinned report hash.
5. Resolve the CityGML Z datum, ULS reference height, permitted source bytes and physical-building identity independently before any reconstruction-accuracy evaluation.

## Official PROJ references

- projinfo operation discovery, area bounds, missing-grid filtering and ballpark-operation filtering: https://proj.org/en/stable/apps/projinfo.html
- cct coordinate execution and object definitions: https://proj.org/en/stable/apps/cct.html
- Explicit operation pipeline semantics: https://proj.org/en/stable/operations/pipeline.html
