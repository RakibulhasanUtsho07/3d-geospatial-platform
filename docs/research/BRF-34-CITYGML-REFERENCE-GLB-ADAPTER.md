# BRF-34 — deterministic CityGML source-reference GLB adapter

**Status:** converter implementation under synthetic CI validation; the real source model has not been converted by this workflow.  
**Dependency:** [BRF-33 full source geometry inspection / PR #246](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/246).  
**Source candidate:** \`DEBY_LOD3_4959323.gml\`; immutable source revision \`e032a71fc9b3c9c3d4869e3aca9677d1234086aa\`.

## Purpose

BRF-33 proved that the exact source object can be whole-file hash-verified and parsed. BRF-34 provides a deterministic adapter to convert supported CityGML polygon surfaces into a **source-reference GLB** for local review and future comparison. This is not a platform reconstruction and does not prove accuracy.

The dedicated workflow uses synthetic fixtures only. It does not download the real model and does not upload/commit generated GLBs.

## Conversion contract

- Requires exact whole-object SHA-256 and byte-count match before parsing.
- Requires immutable source commit/path and explicit source CRS \`EPSG:25832\`.
- Supports 3D planar polygon exterior LinearRings and deterministic ear-clipping triangulation.
- Rejects holes/interior rings, 2D/4D coordinates, malformed XML, DTD/entity declarations, non-finite values, degenerate/self-intersecting/non-planar surfaces and over-limit inputs.
- Preserves a reversible local origin and axis mapping. No CRS reprojection, scale fitting or vertical datum conversion is applied.
- Exports a self-contained GLB 2.0 with POSITION/NORMAL buffers, a neutral material and provenance metadata.
- By default it refuses conversion while exact-file rights are pending. \`--local-review-only\` allows private diagnostics only; it is not publication or redistribution permission.

## Local command

Use only after reviewing the exact file rights, or use private diagnostic mode while the decision remains pending:

\`\`\`bash
python scripts/convert_citygml_to_reference_glb.py ./DEBY_LOD3_4959323.gml ./private-review/citygml-reference.glb \\
  --source-commit e032a71fc9b3c9c3d4869e3aca9677d1234086aa \\
  --source-path citygml/lod3-building-datasets/DEBY_LOD3_4959323.gml \\
  --expected-sha256 a7b30f1596683837329e7b674e16d0dada2c98e3640092129d9092479a67ba37 \\
  --expected-bytes 51178520 \\
  --source-crs EPSG:25832 \\
  --rights-review-status pending-exact-file-scope-review \\
  --local-review-only
\`\`\`

Keep outputs outside version control. Do not upload, commit, or serve the derived GLB until exact-file rights and attribution are approved.

## Limitations

The adapter does not establish real-world building identity, match image frames to a ULS crop, approve EPSG:25832-to-EPSG:32632 operations, infer vertical datum, bake source textures, generate the platform's reconstructed GLB, or calculate held-out accuracy. All release flags remain false.

## Acceptance criteria

Synthetic CI must pass GLB layout, source pinning, origin/axis mapping and fail-closed tests for rights, CRS, holes, malformed XML, unsupported dimensions, and invalid geometry. A real-source run remains a separate authorized human action.
