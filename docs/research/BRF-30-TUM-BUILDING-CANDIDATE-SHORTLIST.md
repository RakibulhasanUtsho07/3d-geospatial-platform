# BRF-30 — TUM building candidate shortlist

**Status:** research shortlist only; no model or building selected  
**Tracking issue:** [#240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240)  
**Machine-readable registry:** [BRF-29 rights and building mapping](../../benchmarks/building-reconstruction/brf-29-rights-and-building-mapping.json)

## Source-backed candidates

The public [GT-LOD3 Benchmark README](https://github.com/gdslab/GT-LOD3-Benchmark) describes its TUM subset as 28 ground-truth LOD3 building instances and 962 filtered images, and publishes a repository-level CC BY 4.0 statement for the benchmark dataset. Its public [evaluation notebook](https://github.com/gdslab/GT-LOD3-Benchmark/blob/main/pc2lod_predictor.ipynb) includes a commented local input path for `DEBY_LOD3_4959323.gml`. The public [TUM2TWIN LOD3 model directory](https://gitlab.lrz.de/tum-gis/tum2twin-datasets/-/tree/main/citygml/lod3-building-datasets) lists this file and two alternative IDs below.

The candidates are selected for **inspection priority**, not as final building identities:

| GML ID | Why it is on the list | What is not established |
|---|---|---|
| `DEBY_LOD3_4959323` | Explicitly appears as a TUM GML input path in the GT-LOD3 evaluation notebook and is listed in the TUM2TWIN directory. Inspect first because it has two traceable catalogue references. | Exact-file licensing, GML footprint, CRS/vertical reference, intersection with the selected ULS crop, and same-building image mapping are not verified. |
| `DEBY_LOD3_4959457` | Listed in the TUM2TWIN LOD3 directory and has a related appearance folder whose history includes a “main entrance building” commit message. | A folder-history message does not by itself prove that this GML is the named building or the building in the ULS crop. |
| `DEBY_LOD3_4959460` | Listed in the TUM2TWIN directory and named as a detailed-model example in the [TUM2TWIN 3D City Database tutorial](https://tum2t.win/tutorials/cm-3dcitydb). | The tutorial's example query point is generic and is not identified as this model's centroid; no model-to-image/ULS match is established. |

## Spatial-frame caution

The ULS LAZ's bounded header inspection reports source-file bounds:

- X: 690787.9737–691169.3342
- Y: 5335827.5318–5336383.1989
- Z: 530.5948–606.4986

These are whole-source bounds, not a selected-building crop. A sample point shown in the TUM2TWIN tutorial, `(691045.978, 5336015.44, 519.269)`, lies inside the header's XY envelope; the source does not say this point belongs to any one of the three candidates. It is not sufficient evidence to select a GML ID.

A second check is the coordinate system: the inspected LAZ header declares WGS 84 / UTM 32N (EPSG:32632), whereas the TUM2TWIN 3D City Database tutorial shows a database example using EPSG:25832. This does not prove every GML file is EPSG:25832, but it means the exact candidate GML `srsName` must be read and an explicit geodetic coordinate operation recorded. Do not assume coordinates are interchangeable merely because both are UTM zone 32N. The named vertical datum/geoid is also unresolved.


### Vertical-reference lead — not yet verified

The [TUM2TWIN 3D City Database tutorial](https://tum2t.win/tutorials/cm-3dcitydb) uses `HEIGHT_EPSG=7837` in an example database configuration. EPSG identifies code 7837 as [DHHN2016 height](https://epsg.io/7837), a German gravity-related height CRS in metres. This is a useful lead for frame investigation, **not proof** that the selected ULS LAZ or any candidate GML uses DHHN2016. The ULS metadata PDF only states “above mean sea level” and the inspected LAZ prefix has no VerticalCSTypeGeoKey. The exact file's vertical metadata and source-to-target vertical operation must still be reviewed; the blocker remains open.

## Required next steps

1. Read the selected GML's exact bytes only after the source's file-level licence/terms are verified; record actual byte size and SHA-256.
2. Parse its GML ID, `srsName`, `boundedBy` and footprint/roof/facade geometry. Record the horizontal CRS, axis order, units and any vertical reference exactly as declared.
3. Compare the parsed footprint against the ULS point cloud after resolving the source frame and CRS operation; then crop points by the footprint plus a documented margin.
4. Match candidate image frames using image poses, timestamps/flight path if available, and visible facade/roof evidence. Keep overlap/coverage evidence and the reviewed building identity with stable asset IDs.
5. Only then change `buildingSelection.status` from `not-selected` through a human-reviewed state. File-level rights and all model/metric checks stay independent gates.

## Fail-closed state

All three entries in the registry remain `candidate-not-selected`. Their file hashes, file-level licence status, footprint coordinates, GML CRS, vertical reference, ULS intersection, and image identity are explicitly unverified. The release flags `acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval` remain false.
