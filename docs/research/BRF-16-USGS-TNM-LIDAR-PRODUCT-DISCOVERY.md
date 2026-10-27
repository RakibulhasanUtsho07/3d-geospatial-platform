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
