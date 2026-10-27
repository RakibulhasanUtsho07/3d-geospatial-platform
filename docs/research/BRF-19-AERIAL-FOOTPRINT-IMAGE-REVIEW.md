# BRF-19 — Aerial-image review packet for footprint candidates

**Date:** 27 October 2026  
**Status:** implementation in review; visual identity review remains pending.  
**Tracking:** https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/220  
**Dependency:** https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/219

## Purpose

BRF-18 ranks Overture building polygons by distance and overlap against EPT elevated-return component AABBs. That is useful spatial triage, but an AABB is not a roof outline and proximity does not prove that the source photo depicts the same building.

BRF-19 adds a derived visual-review artifact: it requests a bounded USGS NAIP imagery crop in Web Mercator and overlays the top-ranked Overture footprint candidates and corresponding EPT component AABBs in the same extent. The rendered image is accompanied by a JSON manifest binding it to the exact input and imagery byte hashes.

## Data and attribution

- Imagery service: https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer
- General service description: https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer
- USGS licensing FAQ: https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map

The report records the service request URL, EPSG:3857 crop extent, requested pixel dimensions, retrieval timestamp, raw imagery SHA-256, input-file hashes, rendered overlay hash and requested attribution. USGS describes the NAIP service as a mosaic and notes that imagery sources and dates can vary. The exact acquisition date of a returned crop is therefore recorded as not resolved, rather than guessed.

Attribution rendered in the overlay:

> U.S. Geological Survey, National Geospatial Program; USGS NAIP imagery service (NAIP provided in partnership with USDA FSA).

## Run

    python -m unittest discover -s tests -p "test_prepare_brf18_footprint_image_review.py"

    python scripts/prepare_brf18_footprint_image_review.py \
      --manifest benchmarks/building-reconstruction/brf-18-overture-building-footprint-crosscheck.json \
      --ept-report artifacts/brf-18/ept-report.json \
      --footprints artifacts/brf-18/overture-footprints.geojson \
      --crosscheck-report artifacts/brf-18/footprint-crosscheck-report.json \
      --output-image artifacts/brf-18/footprint-image-review.png \
      --output-report artifacts/brf-18/footprint-image-review.json

The utility caps input and imagery sizes, validates the PNG signature and dimensions, pins all geometry to EPSG:3857 for overlay drawing, and rejects component/candidate IDs that cannot be mapped back to the exact input feature index. Unit tests use synthetic local fixtures and do not make network calls.

## Interpretation and boundaries

- Red, cyan and amber outlines indicate ranks 1–3 from the BRF-18 cross-reference. Purple dashed boxes are EPT component AABBs; they are not roof footprints.
- This is a map-view visual cross-reference. It does not project the footprint into the 16 oblique drone frames because a validated GPS-to-COLMAP transform and calibrated per-image projection are still absent.
- The NAIP mosaic may not share the drone capture date. A building/roof may have changed between captures, and the service crop may not have enough resolution for small details.
- Human review must record whether a candidate is visibly the same physical building, any ambiguity/occlusion, the reviewer, and timestamp. An image overlay alone cannot validate independent survey geometry.
- Overture feature geometry is not promoted to survey truth. USGS EPT AABBs remain spatial diagnostics. Candidate GLB generation, independent reference geometry, independent held-out checkpoints and their accuracy evaluation remain separate tasks.

The generated JSON explicitly keeps sameBuildingIdentityVerified, candidateGlbGenerated, independentReferenceVerified, heldOutCheckpointAccuracyVerified, acceptanceEligible, publicationEligible, mapReady and automaticApproval false. Only the rendered PNG and derived JSON reports may be uploaded; source imagery and raw Overture GeoJSON stay in the runner's temporary directory.
