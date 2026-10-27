# BRF-16 — Resolve a USGS TNM LAS/LAZ point-cloud asset

**Date:** 27 October 2026  
**Status:** live product discovery on branch `feat/brf-16-usgs-lidar-product-discovery`; exact point-cloud product and header must be verified before acceptance.  
**Tracking:** [Issue #208](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/208).

## Proven facts carried forward

- BRF-14 pinned 16 same-capture candidate imagery files and verified exact source bytes (16/16). It did not generate a candidate GLB or independently validate geometry.
- BRF-15 queried the official MnGeo flight-swath service at approximately `45.0518, -93.391` and returned feature ID `1358`, collection date `2022-05-15`, work unit `Central Mississippi River Block 4`, and the metadata link `https://gis.data.mn.gov/datasets/acfbbbdac1d2403b95ee3be95c4710f8/about`.
- Opening the referenced official metadata shows the item title is **Central Mississippi River Work Unit 4; Hydro-Flattened Bare-Earth DEM**. It describes a 0.5 m GeoTIFF raster made from Class 2 ground returns, so that item is not a building-surface point cloud. It separately says that the source project delivered classified LAS 1.4 files as 500 m × 500 m tiles.
- The work-unit metadata describes NAD83(2011) / UTM Zone 15N, metres, and NAVD88 Geoid18, metres for that work-unit product. These values are project/DEM metadata; the chosen LAZ header still must be checked before using the frame for a candidate/reference comparison.

References:
- Official [MnGeo Second Generation Lidar data page](https://mn.gov/mngeo/gis-data-and-maps/info-by-topic/elevation/lidar/lidar-gen2.jsp) lists the work units and directs users to original, unblended work-unit resources.
- Official [USGS TNM API help](https://www.usgs.gov/faqs/there-api-accessing-national-map-data) describes the TNM Access API for searchable downloadable products.
- Official [USGS download overview](https://www.usgs.gov/the-national-map-data-delivery/gis-data-download) describes the downloadable 3DEP lidar-point-cloud products and product metadata.

## Implementation

`scripts/discover-usgs-tnm-lidar-products.mjs` queries the official TNM Access API endpoint `https://tnmaccess.nationalmap.gov/api/v1/products` for the dataset `Lidar Point Cloud (LPC)`, output formats LAS/LAZ, and a bounded WGS84 search box centered on the source image GPS point. It emits product titles, returned format metadata, source IDs, dates, sizes, URLs, any reported bounds and whether the product footprint overlaps the query box.

The resolver is discovery-only: it does not download large point-cloud files. It rejects invalid coordinates, unexpected response shapes, oversized responses, untrusted download URLs and incomplete pagination. If the API returns a bare-earth DEM instead of a recognized LAS/LAZ product, the query is marked blocked rather than accepted as building geometry truth.

Tests in `tests/discover-usgs-tnm-lidar-products.test.mjs` cover request construction, LAS/LAZ detection, trusted links, missing products, incomplete pagination, malformed payloads, bad coordinates and footprint mismatch. CI runs those tests; the dedicated BRF-16 workflow queries the live public API and uploads only the small JSON product-search report.

Run locally:

```sh
node scripts/discover-usgs-tnm-lidar-products.mjs \
  --latitude 45.0518 \
  --longitude -93.391 \
  --buffer-meters 100 \
  --report artifacts/brf-16/tnm-lidar-products.json
```

## Next evidence gate

After a point-cloud tile is identified, download only the smallest LAZ file whose authoritative footprint covers the photographed structure. Then verify the actual file's byte size and SHA-256, inspect its LAS header (version, point format, CRS/WKT, units, bounds, point count and classification), and quantify the roof/building-point coverage. A tile footprint intersecting the search box is not enough: spatially confirm that the building is present and that the point cloud is independent from the image-derived model.

The source images' GPS altitude has no declared vertical datum, and no valid transform between the source COLMAP frame and the LiDAR frame has been established. Do not fit candidate geometry to all available LiDAR points and then reuse the same points as "held-out" validation. Fit controls and held-out checks must be distinct; target at least six independently measured held-out checkpoints, with an independent reference source hash and documented transform.

**Decision:** no candidate GLB or real-building accuracy score is produced by BRF-16. All `acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval` flags remain false. This branch must not be promoted to `main` just because a product URL was discovered.

## Exact tile header-inspection extension

The live TNM query returned two LAZ products. The selected project-consistent tile candidate is:

- Title: `USGS Lidar Point Cloud MN_CentralMissRiver_B22 4690_49885`
- TNM/ScienceBase source ID: `65078ad9d34eb6693be8c524`
- Direct LAZ: `https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/MN_CentralMissRiver_B22/MN_CentralMissRiver_4_B22/LAZ/USGS_LPC_MN_CentralMissRiver_B22_4690_49885.laz`
- Catalog-declared size: `83,659,396` bytes
- TNM catalog bounds: `[-93.3936931281, 45.0492784113, -93.3873130068, 45.0538008501]`, which include the sample GPS point.
- Metadata: https://www.sciencebase.gov/catalog/item/65078ad9d34eb6693be8c524

Manifest: `benchmarks/building-reconstruction/brf-16-central-mississippi-laz-tile.json`.

`scripts/inspect-usgs-laz-tile.py` downloads no data by itself; the dedicated workflow fetches the single allowlisted 83.7 MB LAZ file into ephemeral runner storage, checks its declared size, computes SHA-256, parses the LAS header/CRS, verifies the sample GPS point transforms into the actual header bounds, and records classification counts for the whole tile and a 50 m neighbourhood around the sample point. It uploads only the small JSON report, never the point-cloud file.

The TNM catalogue did not supply a SHA-256. On the first run the inspector therefore records the observed hash as `tile-inspected-hash-needs-pinning`. After reviewing that report, pin the observed digest in the source manifest and rerun the workflow so the downloaded bytes can be verified against the committed hash. This makes retrieval repeatable but is not an upstream publisher signature.

The 50 m sample-radius classification counts are a location/return-density diagnostic only. They do not independently confirm that the exact photographed building is the one being measured. If the header lacks a vertical CRS, if the expected EPSG differs from the exact tile header, or if no class-6 building returns exist near the capture point, the report records those as warnings/blockers for later review.

Run manually against a downloaded local copy:

```sh
python -m pip install "laspy[lazrs]" pyproj
python scripts/inspect-usgs-laz-tile.py \
  --manifest benchmarks/building-reconstruction/brf-16-central-mississippi-laz-tile.json \
  --file path/to/USGS_LPC_MN_CentralMissRiver_B22_4690_49885.laz \
  --report artifacts/brf-16/central-mississippi-laz-header-report.json
```

The output remains intake evidence only. Even with a pinned hash, valid header CRS and nearby building returns, the GPS↔COLMAP registration, source building identity, separate fit-vs-held-out measurements, engine-generated candidate GLB, and independent held-out metric report must still be completed before acceptance/publication/map readiness is allowed.

## Public EPT fallback after HTTP 429

The raw LAZ staging download returned HTTP 429 on the GitHub Actions runner. This is an access/rate-limit response, not evidence that the LAZ object is missing or invalid. The raw LAZ full-tile workflow is therefore manual-only and has bounded retries/timeouts; its report is retained even when inspection fails.

A better bounded option is the official USGS public Entwine Point Tile dataset for the same work unit:

- EPT metadata: https://s3-us-west-2.amazonaws.com/usgs-lidar-public/MN_CentralMissRiver_4_B22/ept.json
- Dataset citation: Woolpert (2022), “MN Central Mississippi River 4 2022 Lidar; Project ID: 230951 - WU300158; Classified Point Cloud”, U.S. Geological Survey 3DEP.
- NOAA InPort 73145 lists the exact EPT URL and says the original classified point cloud was restructured as EPT and reprojected horizontally to Web Mercator (EPSG:3857), retaining vertical units of metres NAVD88 Geoid18.
- USGS' [3DEP LiDAR Point Clouds public AWS registry](https://registry.opendata.aws/usgs-lidar/) identifies the public `usgs-lidar-public` EPT bucket and states the USGS 3DEP source licence is U.S. Government public domain. The original full-resolution LAZ is a separate requester-pays bucket; this PR uses only the public EPT version, not the requester-pays bucket.

Manifest: `benchmarks/building-reconstruction/brf-16-central-mississippi-ept-reference.json`.

`scripts/inspect-usgs-ept-reference.py` fetches the small EPT metadata and only the hierarchy pages / LASzip point nodes that intersect a bounded 50 m XY neighbourhood around the camera GPS-derived sample point. It checks the EPT SRS, transforms the point to EPSG:3857, hashes each fetched hierarchy/node byte payload, reads LASzip classification counts, and records how many class-6 (building) returns exist inside the sample radius. It caps HTTP response sizes, number of hierarchy documents, node count and total point-node bytes, validates S3 paths/redirects, and never commits or uploads raw point-node bytes. CI uploads the small JSON report only, even when the inspection is blocked, so reviewers can see the reason.

This EPT sample is an efficient point-cloud preflight; it is not yet a proof of the exact photographed building. The root and selected node hashes are captured in the report; the EPT root metadata digest can subsequently be pinned in the manifest for repeatable source-version checking. EPT node hashes refer to the restructured source nodes, not the raw `.laz` product previously returned by TNM.

Manual invocation:

```sh
python -m pip install "laspy[lazrs]" pyproj numpy
python scripts/inspect-usgs-ept-reference.py \
  --manifest benchmarks/building-reconstruction/brf-16-central-mississippi-ept-reference.json \
  --report artifacts/brf-16/central-mississippi-ept-reference-report.json
```

**Interpretation gate:** if the EPT says EPSG:3857 and the observed neighbourhood contains class-6 returns, that supports presence of building-class point returns near the GPS location; it still does not prove image-to-building identity, metric transform accuracy, independent fit/checkpoint separation, or candidate GLB accuracy. Those checks remain required before any accuracy claim or release flag can be enabled.

## EPT point-return finding and widened diagnostic — 27 October 2026

The first successful bounded inspection pinned the EPT metadata SHA-256 to `ac14abdc2600e8af08f59569eb1b873ebda03e46fe59b8ee188a197ce1cd4d3f` and verified the actual horizontal CRS in the public EPT metadata as EPSG:3857. The inspector initially used the tighter `boundsConforming` extent for octree subdivision; this was corrected to use EPT tree `bounds` for node partitioning and `boundsConforming` only for source-extent containment.

On the correctly partitioned 50 m neighbourhood, 3 actual EPT point nodes contained 83,955 point records, with 3,371 points falling within 50 m. The nearby classification totals were class 1 = 1,283, class 2 = 2,084, class 7 = 2, and class 18 = 2; **there were zero class-6 building returns inside the 50 m validation radius**. This is an important negative source-match finding, not a geometry score.

The manifest now expands the diagnostic neighbourhood to 50, 100, 250 and 500 m while retaining 50 m as the strict initial same-building-return gate. The inspector reports class counts for each concentric radius and the nearest class-6 point found in all inspected nodes. This helps decide whether the selected GPS point is offset from a building or whether this same-work-unit point cloud is simply not a valid reference for the photographed structure. Any class-6 points found only at a wider radius are not automatically accepted as the same building.

Live EPT inspection: [workflow run #40506476743](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40506476743) completed successfully as a **bounded data-read**, but it recorded zero class-6 returns inside 50 m and kept `acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval` false. The widened rerun must be reviewed before choosing whether to continue on this location or abandon this LiDAR sample as an identity mismatch.

If no suitable class-6 points appear within the camera-position/possible-building vicinity, do not force a transform or use neighbouring structures as the building reference. Move to a different capture with a validated building-level correspondence. The raw LAZ source still receives HTTP 429 from the staging host, so this preflight uses only small, selected LASzip/EPT nodes; it is not proof of the raw LAZ full-file hash.
