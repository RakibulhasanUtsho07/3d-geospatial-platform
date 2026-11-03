# BRF-18 — Overture footprint cross-check against elevated EPT components

## Purpose

BRF-18 adds a bounded, release-pinned external footprint cross-reference for the Central Mississippi EPT neighbourhood used by BRF-16 and the 16-view camera manifest used by BRF-14. It is a spatial triage step between point-cloud discovery and a properly registered image-to-building reconstruction.

It does **not** produce a candidate GLB, prove which building appears in the images, or replace independent survey truth.

## Reproducible source inputs

- EPT reference: USGS 3DEP, MN_CentralMissRiver_4_B22, with the source URL and metadata hash pinned in brf-16-central-mississippi-ept-reference.json.
- View manifest: brf-14-multiview-source.json, with 16 camera GPS coordinates. GPS altitude is not used because its vertical datum is undeclared.
- Footprints: Overture Maps Buildings release 2026-10-21.0, feature type building, queried only in the WGS84 bounding box recorded in the BRF-18 manifest.
- Geometry comparison: EPT component AABBs are transformed from EPSG:3857 into local UTM zone 15N (EPSG:26915); Overture footprint polygons are transformed from EPSG:4326 into the same metric CRS.
- Integrity: the derived report records SHA-256 hashes of the BRF-18 manifest, EPT report and downloaded GeoJSON bytes. Raw Overture polygons are neither committed nor uploaded as workflow artifacts.

The Overture Python client release is pinned to 1.0.2 and the workflow pins pyproj, numpy and shapely versions. The actual Overture data release is separately pinned to 2026-10-21.0.

## Metrics and interpretation

For each elevated-return component, the report ranks nearby Overture footprint polygons by positive-area intersection with the transformed component AABB, then distance. It reports:

- the source feature identifier where available, plus stable-in-report feature index;
- distance from footprint to component AABB and centroid;
- intersection area, fraction of component AABB covered, and fraction of footprint overlapped;
- the number of candidates and whether the candidate list was truncated.

A component AABB is **not** a roof outline or building footprint. A large box can intersect adjacent footprints. Candidate ordering is therefore evidence for human review, not an automatic selection.

## Fail-closed state

Every output retains:

- sameBuildingIdentityVerified: false;
- candidateGlbGenerated: false;
- independentReferenceVerified: false;
- heldOutCheckpointAccuracyVerified: false;
- acceptanceEligible, publicationEligible, mapReady and automaticApproval all false.

The dataset source documentation notes that Overture footprints are conflated from OpenStreetMap and other source families, can be roofprints, and are released under ODbL. This data is useful for cross-reference only; it is not assumed to be an independently surveyed control source. A real-data accuracy claim still requires a visually confirmed building match, verified asset rights, an engine-generated candidate GLB, a documented frame registration, separate fitting controls and independently surveyed held-out checkpoints.

## How to run

The dedicated GitHub Actions workflow “BRF-18 Overture building-footprint cross-check” runs regression tests, re-inspects the bounded EPT neighbourhood, downloads only the pinned Overture release and uploads the derived JSON report. It intentionally does not upload or commit the raw footprint file.

A successful workflow means the cross-reference calculation ran; it does not mean any candidate footprint is confirmed as the photographed building.
