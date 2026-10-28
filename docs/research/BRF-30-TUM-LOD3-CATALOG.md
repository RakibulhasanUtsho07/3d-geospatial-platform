# BRF-30 — TUM2TWIN LOD3 reference catalog inventory

**Status:** metadata inventory in progress; no building selected.  
**Tracking:** [BRF-29 / issue #240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240).

## Goal

Resolve the next concrete blocker without downloading a bulk model repository: enumerate the individual CityGML/LOD3 file paths, pin the GitLab repository commit, and capture the repository LICENSE bytes as a separate provenance fact.

The official [TUM2TWIN semantic building-model page](https://tum2t.win/datasets/cm-buildings) says the individual LOD3 CityGML models are manually modelled based on official LOD2 building models plus additional mobile laser scan point clouds. The [GT-LOD3 benchmark README](https://github.com/gdslab/GT-LOD3-Benchmark) separately documents a TUM subset of 28 manually modelled LOD3 building instances and its own CC BY 4.0 dataset statement. These are useful sources, but they must not be assumed to refer to the same exact GML IDs or imply the same provenance for every source file.

## What the automation does

## Live inventory result (28 October 2026)

Workflow [#40641848479](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40641848479) completed successfully. It resolved `main` to commit `e032a71fc9b3c9c3d4869e3aca9677d1234086aa` (committed 5 December 2025), paged through the catalog in two requests, and found **27 GML files**, all with the `DEBY_LOD3_` filename prefix. The full metadata report is [artifact #12795532392](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40641848479/artifacts/12795532392); its JSON SHA-256 is `d2398630dc00175e40310fc567dd18cd3d4f2e72f8b0e955cdb72cd5b8baf64a`.

The repository's root `LICENSE` was fetched separately: it begins `Attribution 4.0 International`, and SHA-256 is `9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411`. That verifies the content of the licence file at the pinned revision, not automatically the intended rights for an exact derived model or unrelated image/ULS asset. The catalog names are stored as inventory records, not accepted building identities.

- Resolves the public GitLab project's `main` branch to a commit SHA, then queries the tree at that immutable commit.
- Paginates the `citygml/lod3-building-datasets` path with strict response-size and page-count limits.
- Inventories filenames, paths, blob IDs, suffixes and prefix counts; it does not download any GML/CityGML or model payload.
- Fetches only the small root `LICENSE` text, records its SHA-256 and first lines, and leaves interpretation of the licence scope pending human review.
- Emits a machine-readable report and keeps building identity and all release flags unselected/false on both success and failure.

## Acceptance criteria for a later exact-building choice

1. A candidate GML file must be selected by exact path and immutable commit, then downloaded under its applicable rights and parsed for its actual CityGML building identifier, CRS/envelope and geometry bounds.
2. The chosen reference model must be matched to the same building in the ULS crop and selected image frames using explicit evidence, not filename similarity alone.
3. The licence of the exact model asset, its attribution, and whether derived model files may be publicly redistributed or used commercially must be recorded.
4. The source's “local XYZ” / EPSG:32632 ambiguity and vertical reference must be independently resolved for metric evaluation.
5. The engine must generate its own candidate GLB; actual geometry, independent controls, fixed-view render evidence and human visual review remain separate acceptance gates.

The inventory is a catalog-discovery tool, not model acceptance and not a licence ruling.