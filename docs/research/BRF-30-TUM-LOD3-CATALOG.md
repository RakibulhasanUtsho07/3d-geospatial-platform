# BRF-30 — TUM2TWIN LOD3 reference catalog inventory

**Status:** metadata inventory in progress; no building selected.  
**Tracking:** [BRF-29 / issue #240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240).

## Goal

Resolve the next concrete blocker without downloading a bulk model repository: enumerate the individual CityGML/LOD3 file paths, pin the GitLab repository commit, and capture the repository LICENSE bytes as a separate provenance fact.

The official [TUM2TWIN semantic building-model page](https://tum2t.win/datasets/cm-buildings) says the individual LOD3 CityGML models are manually modelled based on official LOD2 building models plus additional mobile laser scan point clouds. The [GT-LOD3 benchmark README](https://github.com/gdslab/GT-LOD3-Benchmark) separately documents a TUM subset of 28 manually modelled LOD3 building instances and its own CC BY 4.0 dataset statement. These are useful sources, but they must not be assumed to refer to the same exact GML IDs or imply the same provenance for every source file.

## What the automation does

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