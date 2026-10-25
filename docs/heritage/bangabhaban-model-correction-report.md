# Bangabhaban model correction pilot

**Status:** provisional visual proxy, not release-ready. This is a parametric exterior candidate for repeatable QA and visual comparison; it is not a photogrammetric reconstruction or survey-grade model.

## Evidence policy

The candidate uses three individually licensed Wikimedia Commons photos: the 2006 aerial photo (CC BY-SA 4.0) and two ASaber91 photos from 2017 (CC BY 2.0). Camera poses are uncalibrated. The 2006 photo's coordinate is a photo-location record, not a surveyed building centroid.

Published descriptions vary on storey count and floor-area definition. The model does not scale its geometry from the reported 84,000-square-foot figure or from the compound's acreage. All dimensions and the stepped footprint are explicitly tagged as estimates.

## Candidate strategy

- Source-controlled LOD1/LOD2/LOD3 parametric GLBs with semantic parts for the stepped plinth, main wings, roof decks, dome drum/dome, loggia, windows and exterior stair.
- Geometry QA checks GLB structure, degenerate triangles and per-primitive topology. Warnings remain visible.
- Thirteen fixed 1024×1024 Blender views, contact sheet, reference-byte hashes, exact model hash and QA-report hashes.
- No texture atlas or UVs are claimed. All materials are plain PBR colours.

## Acceptance gates

1. Current-head CI and render workflow pass on the exact source commit.
2. Every reference download has individual license, attribution, byte length and SHA-256 evidence.
3. Review front/oblique/top/side/back views against matching visible features and record occlusions.
4. Remaining topology warnings need primitive-by-primitive review; no automatic visual acceptance follows from a valid GLB.
5. A traced footprint, rectified facade views or independent survey/control points are required before real-world dimensional accuracy can be claimed.
