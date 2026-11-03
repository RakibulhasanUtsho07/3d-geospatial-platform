# BRF-15 — MnGeo flight-swath work-unit discovery

**Date:** 27 October 2026  
**Status:** resolver and regression tests implemented on `feat/brf-15-mngeo-work-unit-discovery`; the exact point query must run on GitHub Actions before a work unit can be named.  
**Tracking:** [Issue #208](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/208).

## Why this stage exists

BRF-14 proved that sixteen candidate-view image files match their pinned upstream bytes. It did not locate an independent reference surface. The sample GPS point is approximately latitude `45.0518`, longitude `-93.391` in Minnesota. The next data-discovery stage queries the official Minnesota Second Generation Lidar Flight Swaths feature service at that point and records candidate work-unit metadata links.

Official discovery sources:
- MnGeo's [Second Generation Lidar page](https://mn.gov/mngeo/gis-data-and-maps/info-by-topic/elevation/lidar/lidar-gen2.jsp) documents the 2021–2024 statewide collection and explains that original, unblended data is organized by acquisition block/work unit.
- The [flight-swath layer](https://enterprise.gisdata.mn.gov/aghost/rest/services/MnTOPO_Flight_Swaths/FeatureServer/0) exposes polygon features and the `objectid`, `name`, `work_unit`, `date`, and `metadata` fields. The published layer declares a projected layer spatial reference; the query explicitly identifies the input point as EPSG:4326 and allows the service to perform the spatial query.
- USGS' [3DEP spatial metadata page](https://www.usgs.gov/3d-elevation-program/3dep-spatial-metadata) says work-unit metadata can identify available point-cloud and source-DEM products, acquisition dates and project reports. The [USGS 3DEP point-cloud collection](https://catalog.data.gov/dataset/lidar-point-cloud-usgs-national-map-3dep-downloadable-data-collection) describes the original point-cloud data as LAZ with source spatial reference/units preserved and public-domain terms.

## Implementation

`scripts/resolve-mngeo-lidar-work-units.mjs` sends a bounded point-intersection query to the official feature service, requests only the swath metadata fields, deduplicates swath features into groups keyed by acquisition block/work unit/metadata URL, and emits a small JSON report. It rejects invalid coordinates, oversized/non-JSON responses, service errors and non-HTTPS/untrusted metadata hosts. The raw polygons are not needed for this lookup.

`tests/resolve-mngeo-lidar-work-units.test.mjs` uses synthetic ArcGIS responses to verify request parameters, grouping, missing results, malformed payloads, URL trust policy, coordinate limits and HTTP errors. The dedicated GitHub Actions workflow runs the unit tests, calls the real public metadata endpoint for the sample point, and uploads only the JSON discovery report.

Run locally:

```sh
node scripts/resolve-mngeo-lidar-work-units.mjs \
  --latitude 45.0518 \
  --longitude -93.391 \
  --report artifacts/mngeo-work-unit-discovery.json
```

## Important interpretation

A flight-swath polygon only identifies a candidate acquisition swath; it is not itself a point cloud, not proof the building has sufficient returns, and not a reference measurement. A successful result means only that the public metadata service returned work-unit candidates with trusted HTTPS metadata links.

The following evidence is still required after the work-unit lookup:
1. Read the exact work-unit metadata and identify the downloadable LAS/LAZ point-cloud asset (not just a DEM/COG or image service).
2. Verify that the source asset's actual footprint covers the photographed building, and document acquisition date, file URL/version, file bytes/SHA-256, units, horizontal CRS and vertical datum from exact metadata/header.
3. Confirm point density and building-return coverage are sufficient for the planned geometric comparison.
4. Keep candidate and independent reference sources separate; register their frames with verified controls and reserve at least six genuinely held-out checkpoints that were not used for fitting.
5. Generate a candidate GLB with the platform's reconstruction workflow and evaluate the actual candidate bytes using BRF-09/BRF-08.

The source dataset's camera GPS altitude still has no declared vertical datum, and the source COLMAP world frame has no established transform to GPS from BRF-14. Do not infer this transform from proximity or the flight swath alone. The upstream GLB/OBJ and its 1.997 m AprilTag scale control remain inadmissible as independent held-out truth.

**Release status:** keep `acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval` false. No candidate GLB or real-building accuracy result is claimed by this discovery tooling. Do not promote to `main` on work-unit discovery alone.
