# BRF-31 — bounded CityGML file metadata and envelope screening

**Status:** implementation under CI verification; no building selected.  
**Tracking:** [issue #240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240).

## Why this step exists

BRF-30 established a pinned catalog of 27 `DEBY_LOD3_*.gml` paths and recorded the data repository root LICENSE. The filenames follow LDBV GML IDs, but a catalog filename alone does not prove the physical building identity or the coordinate frame encoded in that file.

TUM2TWIN's [3D City Database guide](https://tum2t.win/tutorials/cm-3dcitydb) documents an example import configuration using SRID 25832 and HEIGHT_EPSG 7837, and shows a sample point at `POINT(691045.978 5336015.44 519.269)`. The same guide mentions `DEBY_LOD3_4959460` as a geometry-heavy model. These are useful research clues, not proof that this model corresponds to the 2024 ULS crop or any specific UAS image. Our ULS LAZ header instead declares WGS 84 / UTM zone 32N, EPSG:32632; therefore the horizontal datum/frame and vertical semantics must be compared explicitly.

## What the inspector does

- Reads the checked-in BRF-30 snapshot and rejects a mismatched commit, invalid blob ID or file outside the pinned GML catalog.
- For each of the 27 files, requests only an initial 128 KiB HTTP Range. It accepts the body only when the server returns HTTP 206 with a valid Content-Range and matching content length. If the server returns HTTP 200, it does not read the body.
- Detects a Git LFS pointer. If present, it asks the LFS batch endpoint for a download action and then makes the same bounded range request to the object URL; it does not download the complete LFS object.
- Extracts only metadata visible in a valid bounded XML prefix: root element/id, early Building/BuildingPart IDs, SRS names and complete GML Envelope lower/upper corners. It does not validate the whole XML document or parse all building geometry.
- Compares XY envelopes to the broad ULS header bounds only as a screening signal. EPSG:25832 is not silently rewritten as EPSG:32632; the report marks overlapping ETRS89/UTM envelopes as requiring explicit transformation review.
- Records prefix SHA-256 separately from the model's LFS-declared full-object SHA-256, and explicitly says that the latter is not verified without reading/hash-checking the whole object.

## What it must not do

A candidate envelope overlapping the broad ULS extent is not evidence that it is the same building. A filename suffix is an LDBV model identifier, not a human-confirmed building mapping. No GML model is automatically selected. The report keeps `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false.

## Next gate after this probe

Once one or more bounded envelopes have been extracted, use their true file SRS, dimensions and coordinates to build a shortlist. Then, only with the rights scope reviewed, inspect the selected model’s actual CityGML geometry and same-building evidence against a ULS crop and selected candidate image frames. Resolve ETRS89/WGS84 horizontal transforms and the named vertical datum before generating the engine candidate GLB or reporting any metric accuracy.
