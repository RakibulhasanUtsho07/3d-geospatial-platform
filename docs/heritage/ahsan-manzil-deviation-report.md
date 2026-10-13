# Ahsan Manzil exterior model — parameter-by-parameter deviation report

**Status:** Parametric heritage exterior draft. These are procedural meshes, not a photogrammetry scan, measured point cloud, or survey; pixel-perfect accuracy is not claimed.

## Assets

| File | Purpose |
|---|---|
| `public/models/ahsan-manzil-lod1.glb` | Low-detail massing |
| `public/models/ahsan-manzil-lod2.glb` | Roofline, parapet, dome and simplified facade rhythm |
| `public/models/ahsan-manzil-lod3.glb` | Openings, trim/pilasters, porticos, end elevations, upper-veranda balustrades, roofline pinnacles, staircase, drum, dome ribs and finial |
| `public/models/ahsan-manzil.glb` | Convenience alias of LOD3 |
| `public/models/ahsan-manzil.manifest.json` | Runtime building manifest / LOD parameters |
| `data/heritage/ahsan-manzil.parameters.json` | Confidence-tagged parameter source |
| `scripts/build-ahsan-manzil-model.mjs` | Reproducible source-controlled GLB generator |
| `tests/heritage-model.test.mjs` | GLB/node/parameter/navigation/LOD integrity tests |

Build assets with `npm run build:heritage-model`. All models include nodes `Plinth`, `Rangmahal_GF`, `Rangmahal_FF`, `Portico_S`, `Portico_N`, `Stair_S`, `Veranda_S`, `Veranda_N`, `Parapet`, `Dome_Drum`, `Dome`, `Finial`, `Andarmahal`.

## Coordinate system and runtime behavior

- GLB units are meters, Y is up, X is the approximate east-west long axis, and +Z is the south/river-front side. Natural ground is Y=0; plinth top is Y=1.0 m.
- The provisional anchor is 23.7086, 90.40606 [C]; it is not yet proven to be the traced footprint centroid.
- The initial map view and Home control focus Ahsan Manzil. Dedicated left/right Orbit controls rotate the camera around the building in 45-degree increments while framing the full palace.
- The central round room/dome is aligned with the origin, between two 62.7 m working halves derived from the published 125.4 m overall length and description of two equal palace halves. This is an explicit improvement to the earlier visibly off-centre dome/stair/portico.
- The east and west short elevations now include recessed arched openings and storey belt courses; LOD3 also includes upper-veranda balustrades and stylized roofline pinnacles.
- The central portico now continues through the upper storey with a second triple-arched loggia, capitals/impost bands, cornice and a triangular pediment above it; the pediment peak is parameterized at 15.2 m [E] pending a rectified facade.
- LOD model loading/unloading uses camera distance and camera altitude thresholds [E] to avoid loading detailed geometry when the view is in Bagerhat or far from Old Dhaka.
- The Cesium loader sets Y-up and Z-forward for the generated GLB; the model uses a local east-north-up reference frame with south as its +Z face.

## Complete parameter register

Every geographic and model parameter from the JSON is listed below with its confidence tag, source, current value and note. [V] = verified published value; [C] = conflicting/provisional; [E] = estimate; [?] = unknown.

| Parameter | Tag | Current value | Source | Note / deviation |
|---|---|---|---|---|
| Georeference.latitude | [C] | 23.7086 degrees_north | User-supplied anchor; Wikipedia coordinates (23.7085972 N, 90.4060583 E) agree closely; alternate listings reported in the brief conflict | Retain [C] until the outline is traced and the origin is moved to the actual footprint centroid. |
| Georeference.longitude | [C] | 90.40606 degrees_east | User-supplied anchor; Wikipedia coordinates (23.7085972 N, 90.4060583 E) agree closely; alternate listings reported in the brief conflict | Retain [C] until the outline is traced and the origin is moved to the actual footprint centroid. |
| Georeference.longAxisAzimuthDegrees | [E] | 90 degrees | Approximate east-west direction in supplied brief | Measure from satellite/OSM imagery. |
| Georeference.axes | [E] | X east-west; Y up; +Z south / river-front | Local model coordinate convention |  |
| Georeference.riverFacade | [V] | south | Bangladesh Tourism Board and supplied brief |  |
| Georeference.rearFacade | [V] | north | Supplied brief |  |
| Georeference.units | [V] | meters | User request |  |
| footprint.overallLength | [C] | 125.4 m | Bangladesh Tourism Board / Parjatan | Working dimension pending footprint trace. |
| footprint.overallDepth | [C] | 28.75 m | Bangladesh Tourism Board | Working dimension; resolve against satellite/plan. |
| footprint.rangmahalBlockLength | [C] | 62.7 m | Half of the 125.4 m overall length; central round-room/equal-halves description | Working eastern half so the dome/round room can sit at the central joint; confirm by footprint tracing. |
| footprint.andarmahalBlockLength | [E] | 62.7 m | 125.4 m / 2, using the published equal-halves description | Derived working western half; not independently surveyed. |
| footprint.interiorGridEW | [V] | 4 bays | Supplied brief | Recorded separately; not treated as exterior opening count. |
| footprint.interiorGridNS | [V] | 5 bays | Supplied brief | Recorded separately; not treated as exterior opening count. |
| footprint.exteriorBayCount | [E] | 24 bays per long facade | Procedural placeholder | Replace by counting openings on rectified elevation photos. |
| footprint.averageBayPitch | [E] | 5.225 m | 125.4 m / 24 estimated bays | Section pitch differs slightly to fit assumed Rangmahal/Andarmahal split. |
| vertical.naturalGround | [V] | 0 m | Supplied coordinate convention |  |
| vertical.plinthHeight | [V] | 1 m | Bangladesh Tourism Board / Parjatan |  |
| vertical.alternatePlinth | [C] | 1.2 m | Alternative value in supplied brief | Not used in current model. |
| vertical.groundFloorClearHeight | [V] | 5 m | Bangladesh Tourism Board / Parjatan |  |
| vertical.firstFloorClearHeight | [V] | 5.8 m | Bangladesh Tourism Board / Parjatan |  |
| vertical.slabThickness | [E] | 0.4 m | Supplied brief |  |
| vertical.wallThickness | [V] | 0.78 m | Bangladesh Tourism Board | Used as facade reveal-depth proxy. |
| vertical.parapetHeight | [E] | 1 m | Supplied brief |  |
| vertical.rooflineHeight | [E] | 13.6 m | Calculated vertical stack including slabs and parapet | Derived, not surveyed. |
| vertical.porticoHeight | [V] | 5 m | Bangladesh Tourism Board |  |
| facade.openingsHead | [V] | semicircular arches | Supplied brief |  |
| facade.gfOpeningWidth | [E] | 1.2 m | Supplied brief |  |
| facade.gfOpeningCrownHeight | [E] | 3.2 m | Supplied brief |  |
| facade.ffOpeningWidth | [E] | 1.3 m | Supplied brief |  |
| facade.ffOpeningCrownHeight | [E] | 3.8 m | Supplied brief |  |
| facade.verandaArchSpan | [E] | 3.3 m | Midpoint of supplied 3.0–3.5 m range |  |
| facade.pilasterOrder | [V] | simplified Corinthian-type | Supplied brief | Fine capital and fluting geometry simplified. |
| facade.capitalFluting | [?] | smooth simplified capital | Placeholder; needs close-up |  |
| facade.coloredGlazing | [?] | dark rose/amber panels with simple mullions | Placeholder; exact pattern unknown |  |
| facade.porticoWidth | [E] | 20 m | Exterior photo proportion | Widened central portico proxy; calibrate against a rectified elevation. |
| facade.porticoDepth | [E] | 4 m | Procedural placeholder until footprint/photo calibration | Projection depth of the central portico. | 
| facade.balustradeHeight | [E] | 0.9 m | Visible upper-veranda guardrail proportion in exterior photographs | Approximate guardrail height above veranda floor. |
| facade.balusterSpacing | [E] | 0.85 m | Procedural rendering parameter | Approximate post interval; replace after elevation/photo calibration. |
| facade.rooflinePinnacleHeight | [E] | 1.5 m | Visible small roofline finials/pinnacles in exterior photographs | Stylized height above parapet; not a measured ornamental profile. |
| facade.pedimentPeakHeightAboveGround | [E] | 15.2 m | Approximate exterior-photo proportion for the roof pediment above the first-floor triple-arched loggia | Updated from the earlier too-low placeholder; recalibrate against a rectified south facade. |
| facade.doorBayInterval | [E] | 4 bays | Procedural modeling default until a rectified facade image is counted | Every fourth exterior bay is treated as a glazed door in LOD2/LOD3; actual count and placement require photo calibration. |
| facade.stoneInlayBandWidth | [?] | 0.08 m | Procedural placeholder for the stone inlay described in the heritage brief | Band width and exact stone pattern are unknown; replace after close-up door photographs. |
| facade.doorGlazingPattern | [?] | simple multi-panel colored glazing with vertical center stile | Placeholder derived from documented colored-glass doors | Do not treat panel count/color pattern as verified. |
| stair.riserHeight | [E] | 0.16 m | Supplied brief |  |
| stair.treadDepth | [E] | 0.4 m | Procedural placeholder |  |
| stair.stepCount | [?] | 40 steps | Derived from 6.4 m rise / 0.16 m riser |  |
| stair.width | [E] | 22 m | Approximate front-elevation proportion from public exterior photographs | Widened so the broad stair reads proportionately against the central portal; trace before survey-grade claims. |
| stair.sideRail | [?] | simple low side rails | Stylized placeholder |  |
| stair.runLength | [E] | 16 m | Procedural placeholder | Horizontal garden run from the upper portal toward the river; not site-surveyed. |
| dome.peakHeight | [V] | 27.13 m above ground | Bangladesh Tourism Board heritage newsletter |  |
| dome.drumHeight | [E] | 5 m | Supplied placeholder |  |
| dome.bodyHeight | [E] | 6.53 m | Derived to meet 27.13 m peak with 13.6 m roofline and 2 m finial |  |
| dome.finialHeight | [E] | 2 m | Supplied placeholder |  |
| dome.drumWidth | [?] | 14 m | Placeholder; calibrate from elevation photo |  |
| dome.profile | [V] | square base room → octagonal drum → lotus-bud dome → finial | Supplied brief | Curvature and ribs remain stylized. |
| dome.drumOpeningCount | [?] | 4 openings | Placeholder on north and south drum faces | Two arched openings on each of the north and south drum faces; count needs elevation imagery. |
| dome.drumOpeningWidth | [E] | 0.95 m | Procedural placeholder | Width of each drum arch opening. |
| dome.drumOpeningCrownHeight | [E] | 2 m | Procedural placeholder | Opening height to arch crown, pending elevation photo. |
| dome.profileRings | [E] | [[6.9,0],[6.7,0.35],[6.1,1.1],[5.4,2],[4.55,2.9],[3.55,3.8],[2.55,4.65],[1.55,5.45],[0.28,6.53]] [radius_m, height_above_dome_base_m] pairs | Procedural lotus-bud profile constrained to the 27.13 m peak | Control points are illustrative; replace with samples from a rectified elevation photo. |
| materials.facadePink | [E] | #E7A3AE | Supplied placeholder | Not sampled from color-managed daylight photography. |
| materials.trimOffWhite | [E] | #F4EDE0 | Supplied placeholder |  |
| materials.glass | [?] | #583943 | Generic dark glazing proxy |  |
| materials.roof | [?] | #D28E98 | Placeholder; roof covering material unknown |  |
| materials.verandaFloor | [V] | #EFE6D5 | Supplied brief; light marble proxy |  |
| roof.covering | [?] | flat roof behind parapet; covering material unknown | Supplied brief |  |
| roof.structure | [V] | timber/iron beams, interior only | Supplied brief | Not included in exterior mesh. |
| runtimeLod.lod1MaxDistance | [E] | 18000 m from view centre to provisional anchor | Rendering heuristic in heritage-landmarks.mjs | Show only when the view centre is within 18 km and camera height is at most 20 km. |
| runtimeLod.lod1MaxCameraHeight | [E] | 20000 m | Rendering heuristic in heritage-landmarks.mjs | Rendering threshold, not a building measurement. |
| runtimeLod.lod2MaxDistance | [E] | 6500 m from view centre to provisional anchor | Rendering heuristic in heritage-landmarks.mjs | Show when closer than this and camera height is at most 8 km unless LOD3 threshold is met. |
| runtimeLod.lod2MaxCameraHeight | [E] | 8000 m | Rendering heuristic in heritage-landmarks.mjs | Rendering threshold, not a building measurement. |
| runtimeLod.lod3MaxDistance | [E] | 2000 m from view centre to provisional anchor | Rendering heuristic in heritage-landmarks.mjs | Show detail mesh when closer than this and camera height is at most 2.5 km. |
| runtimeLod.lod3MaxCameraHeight | [E] | 2500 m | Rendering heuristic in heritage-landmarks.mjs | Rendering threshold, not a building measurement. |

## Deviations and remaining calibration work

1. Footprint polygon, building centroid and exact azimuth still need tracing from satellite imagery/OSM. Anchor stays [C], rotation [E].
2. The current model sets Rangmahal and Andarmahal to two 62.7 m halves so the dome/round room and main stair align with the central joint described in heritage references. This is a provisional equal-half interpretation until a georeferenced footprint or floor plan is traced.
3. The 24-bay exterior rhythm is provisional and intentionally distinct from the 4 × 5 reported interior grid.
4. Door positions use every fourth facade bay [E]; stone-inlay width and colored-glazing pattern are [?]. Replace from close-up photographs.
5. Capitals, fluting, arch moulds, stone patterns, roofline pinnacles and dome ribs are stylized, not measured historic mouldings. Short-end opening rhythm and balustrade spacing are estimates.
6. Dome apex is constrained to 27.13 m [V], while drum width/openings and the ring profile still need a rectified elevation photo.
7. The facade pink/trim samples have not been calibrated from color-managed daylight photography; visual colors are still approximate.
8. Interior wooden staircase, timber/iron roof structure, and interior tile floors are outside the exterior LODs.
9. LOD distance/altitude cut-offs are render-performance heuristics [E].
10. Local visual comparison with rectified photos has not been performed. After regenerating assets, test in browser and recalibrate all [E]/[?] values.

## Calibration order

Trace OSM/satellite footprint → set centroid and azimuth → rectify south facade using 5.0 m and 5.8 m storey heights plus the 27.13 m dome apex → count bays/doors/arches → replace [E]/[?] inputs → sample daylight colors → regenerate models → compare in Cesium.

## Sources

- **Ahsan Manzil — Bangladesh Tourism Board** — https://beautifulbangladesh.gov.bd/cat/heritage/3
- **Ahsan Manzil: an aristocracy of the ancient era — Bangladesh Tourism Board** — https://beautifulbangladesh.gov.bd/newsletter/single/479
- **Ahsan Manzil — Bangladesh Parjatan Corporation** — https://parjatan.portal.gov.bd/pages/static-pages/6922ddbe933eb65569e16134
- **Historic Mosque City of Bagerhat — UNESCO World Heritage Centre** — https://whc.unesco.org/en/list/321/
- **Historic Mosque City of Bagerhat — UNESCO geographic information** — https://whc.unesco.org/document/216536
- **Ahsan Manzil — Wikipedia** — https://en.wikipedia.org/wiki/Ahsan_Manzil — Coordinates near 23.7085972 N, 90.4060583 E agree closely with supplied anchor. Anchor still remains [C] until footprint polygon centroid is traced.
- **A Palace on the River: Ahsan Manzil — The Daily Star, Adnan Zillur Morshed** — https://www.thedailystar.net/slow-reads/focus/news/palace-the-river-ahsan-manzil-1598293
