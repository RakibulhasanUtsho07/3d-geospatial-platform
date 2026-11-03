# BRF-32 — persisted CityGML envelope screening findings

**Status:** metadata screening is complete; candidate building identity and metric frame remain blocked.  
**Source PR:** [BRF-31 / PR #244](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/244)  
**Tracking issue:** [#240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240)

## Verified bounded probe result

The pinned GitLab source revision is `e032a71fc9b3c9c3d4869e3aca9677d1234086aa`. Workflow [#40644356209](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40644356209) returned an envelope from **27/27** model prefixes, each limited to 128 KiB. The JSON summary [brf-31-citygml-envelope-screening.json](../../benchmarks/building-reconstruction/brf-31-citygml-envelope-screening.json) retains each filename, pinned Git blob ID, declared LFS object hash/size, actual prefix SHA-256, early Building GML ID, `srsName`, envelope lower/upper corners, and explicit unverified flags.

All 27 envelopes use **EPSG:25832**. All 27 broadly overlap the ULS header XY extent, so that overlap does not discriminate among buildings. The ULS LAZ header declares **EPSG:32632**; no CRS transform has been applied. Vertical frame reconciliation also remains open.

## Candidate lead, not selected identity

The TUM2TWIN guide's example query point `(691045.978, 5336015.44, 519.269)` lies within the XYZ envelope for `DEBY_LOD3_4959457.gml` only. The point comes from a documentation example; it is **not** established as a survey checkpoint, footprint centroid, or known building identity. Therefore that model is a lead for further investigation, not a selected reference.

The early in-file Building ID is `DEBY_LOD2_4959457`, whereas the filename carries the LOD3 label. The same LOD2-prefix/same-numeric-suffix pattern appears in 26 of 27 files; one has a generated LOD3 ID. Preserve both values and resolve their provenance before identifying the physical building.

The example point's Z is 11.326 m below the LAZ header's global min-Z. This is a warning about frame correspondence, **not** a measured error: building identity and vertical datum are not matched.

## Next acceptance gates

1. Review the exact GitLab data-repository CC BY 4.0 scope and required attribution for the chosen model.
2. Determine the model's complete building/geometry IDs and coordinate axes, and approve ETRS89/WGS84 horizontal and named vertical operations with traceable evidence.
3. Establish the same-building identity against an explicitly selected and rights-cleared ULS crop plus permitted image frames; bounding-box overlap alone is insufficient.
4. Generate the candidate GLB through the platform engine, then compare its extracted footprint/mesh against independent held-out controls.
5. Keep acceptance, publication, map readiness and automatic approval false until human visual review and independent accuracy gates are complete.

No raw 27-model set, full GML, ULS or image archive is committed by this report.
