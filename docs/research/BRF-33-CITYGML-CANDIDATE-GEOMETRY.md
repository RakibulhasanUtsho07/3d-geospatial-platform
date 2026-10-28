# BRF-33 — full-byte and geometry inspection of one CityGML candidate

**Status:** whole-object checksum and full XML/geometry extraction verified; building identity and metric frame remain blocked.  
**Source revision:** `e032a71fc9b3c9c3d4869e3aca9677d1234086aa`  
**Tracking:** BRF-29 / [issue #240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240)  
**PR:** [#246](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/246)

## Actual verified result

The workflow downloaded the complete pinned Git LFS object for `DEBY_LOD3_4959323.gml` and verified both exact size and whole-object SHA-256 before parsing:

- **Actual size:** 51,178,520 bytes
- **SHA-256:** `a7b30f1596683837329e7b674e16d0dada2c98e3640092129d9092479a67ba37`
- **Full XML document:** validated
- **3D coordinate tuples extracted:** 389,813
- **Coordinate tokens:** 1,169,439
- **Malformed/non-finite coordinate tokens:** 0
- **Declared CRS observed in source:** `EPSG:25832`
- **Geometry counts:** 62,576 Polygon, 63,160 LinearRing, 119 MultiSurface, 107 WallSurface, 11 RoofSurface, 102 Window, 1 Door, 1 GroundSurface and 1 Building.

The extracted source-coordinate bounds are:

| Axis | Minimum | Maximum |
|---|---:|---:|
| X | 691045.511 | 691090.284 |
| Y | 5336061.116 | 5336132.407 |
| Z | 514.588 | 537.723 |

These are coordinate extrema of this **source CityGML payload** in the declared source frame. They are not independently surveyed dimensions or an accuracy score.

## Provenance and persistent evidence

The pinned catalog snapshot records the GitLab repository blob ID; the BRF-31 bounded screening record provides the declared LFS SHA-256 and byte count. BRF-33 cross-checks both files against the same immutable source commit before it downloads the object. Only after size and whole-object SHA-256 match does it parse the full XML.

- [Successful full-geometry workflow](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40647004350)
- [Original JSON evidence artifact](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40647004350/artifacts/12798027293)
- [Persistent machine-readable result](../../benchmarks/building-reconstruction/brf-33-citygml-candidate-geometry.json)
- [Pinned source model](https://gitlab.lrz.de/tum-gis/tum2twin-datasets/-/blob/e032a71fc9b3c9c3d4869e3aca9677d1234086aa/citygml/lod3-building-datasets/DEBY_LOD3_4959323.gml)

The report's root is a CityModel, while the first extracted in-file Building ID is `DEBY_LOD2_4959323` even though the filename is labelled LOD3. Preserve both identifiers; do not equate the filename with verified physical-building identity.

## What remains blocked

1. **Exact-file rights:** the repository-level CC BY 4.0 evidence still needs human scope/attribution review for this exact GML and intended usage.
2. **Same-building linkage:** no matching permitted image subset and independent-sensor ULS crop are bound to this model. The full-campus ULS bounds and envelope overlap do not prove identity.
3. **Coordinate frame:** the source model reports `EPSG:25832`; the ULS LAZ header declares `EPSG:32632`. No transformation was applied. The named vertical datum/geoid and appropriate horizontal/vertical operation remain unverified.
4. **Engine output:** this is a source/reference-model geometry extraction, not a platform-generated candidate GLB.
5. **Accuracy:** no held-out survey checkpoints or candidate-vs-reference residuals exist for this sample.

## Release policy

The candidate stays `inspection-only-not-selected`. `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` all remain false. Passing hash and XML checks verifies the source bytes and parser result only; it does not approve this model as ground truth, select a real building, or establish reconstruction accuracy.
