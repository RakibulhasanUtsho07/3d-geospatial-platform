# Bangabhaban reference-to-render correction matrix

**Decision:** provisional candidate only; not release-ready. Source photographs have uncalibrated camera poses; model dimensions and footprint are estimates.

## Licensed reference pack

- [2006 aerial — Naira Al Husain, CC BY-SA 4.0](https://commons.wikimedia.org/wiki/File:Bangabhaban.jpg): compound orientation and broad massing cues only.
- [2017 exterior — ASaber91, CC BY 2.0](https://commons.wikimedia.org/wiki/File:Bangabhaban_(33310655331).jpg): dome, facade rhythm and loggia silhouette.
- [2017 elevated aerial — ASaber91, CC BY 2.0](https://commons.wikimedia.org/wiki/File:Bangabhaban,_Dhaka_April_(33244270994).jpg): roof blocks and wing arrangement.

## Main open visual/geometry issues

| ID | Issue | Current disposition | Required next action |
|---|---|---|---|
| BGB-V01 | Dome, pavilion and roof silhouette use provisional proportions | Estimate only | Compare top/oblique images; keep heights unverified until rectified views or a measured plan exist |
| BGB-V02 | Wing arrangement and stepped footprint are interpretive | Estimate only | Trace a suitable aerial footprint; do not infer hidden structure from a single oblique photo |
| BGB-G01 | Stepped plinth topology | Regression-gated | Require one connected component and zero boundary/non-manifold edges in all LODs |
| BGB-G02 | Facade parts/arches/windows may overlap or remain separate | Review required | Inspect per-primitive warnings; preserve all findings |
| BGB-T01 | No texture atlas or UVs | Not implemented | Do not claim photographic realism; add licensed calibrated texture work only with view/occlusion evidence |
| BGB-M01 | Model dimensions and centroid are not surveyed | Blocked | Obtain an independently traced footprint, rectified facade and/or survey control points |

## Release policy

No architectural-accuracy pass follows from a successful build, valid GLB or deterministic render. Keep this candidate provisional until the geometry and evidence gates have been reviewed.


## Geometry correction gate from first visual review

- [x] Source generator updated to close the dome shell's final ring with a top cap fan; acceptance requires zero dome boundary edges across LOD1/LOD2/LOD3.
- [x] Entrance stair changed from elevated over-height slabs to ground-based filled stair blocks whose top stays at the configured total rise.
- [ ] Confirm the new candidate hash, per-LOD topology/test result and fresh 13-view renders before accepting the correction.
- [ ] Human visual review of stair treads and dome profile against the licensed, uncalibrated images remains required.
