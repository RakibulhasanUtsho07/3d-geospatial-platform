# BRF-33 — full-byte and geometry inspection of one CityGML candidate

**Status:** implementation under validation; the candidate is not a selected building.  
**Source revision:** e032a71fc9b3c9c3d4869e3aca9677d1234086aa  
**Tracking:** BRF-29 / issue #240

## Scope

This task advances beyond the 128 KiB envelope probe by inspecting the full payload of one pinned catalogue candidate: DEBY_LOD3_4959323.gml. The catalogue snapshot records a 51,178,520-byte Git LFS object and its declared SHA-256. The public GT-LOD3 notebook references this filename and the TUM2TWIN catalogue lists it, which makes it a traceable inspection candidate rather than a proven real-world building identity. See the [GT-LOD3 repository README](https://github.com/gdslab/GT-LOD3-Benchmark/blob/main/README.md) and the [TUM2TWIN CityGML catalogue](https://gitlab.lrz.de/tum-gis/tum2twin-datasets/-/tree/main/citygml/lod3-building-datasets).

## Verification contract

The workflow pins the immutable GitLab revision, repository blob ID, expected Git LFS SHA-256 and exact byte count. It rejects invalid pointer metadata, oversized objects, non-HTTPS download URLs, partial HTTP responses, content-length mismatches and whole-object digest mismatches. The raw GML exists only in the CI process; the uploaded artifact is a JSON summary with source hashes, parsed IDs, geometry counts, coordinate bounds and CRS declarations. Raw model bytes are not committed.

The streaming XML parser validates the complete document and counts available coordinate tuples, geometry primitives and common CityGML surface/opening elements. It preserves the source coordinate values and reports the declared CRS; it does not normalize axis order, transform coordinates, or claim metric alignment to the ULS.

## Important limitations

This workflow does not approve the exact file's licence scope or attribution. The TUM2TWIN repository-level CC BY 4.0 evidence is source-level information only; use-specific rights still require review. It does not establish that this model, any selected image subset and a crop of the independent-sensor ULS point cloud refer to the same physical building.

Even if byte verification and full XML parsing pass, this is only source-model geometry extraction. It is not a platform-generated candidate GLB, not independent held-out checkpoint accuracy, and not a release acceptance.

## Release policy

The four release flags remain false: acceptance, publication, map readiness and automatic approval. The next gate is an evidence-backed same-building match plus reviewed horizontal/vertical coordinate operations and rights for every intended source asset.
