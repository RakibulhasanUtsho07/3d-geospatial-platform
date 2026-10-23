# Ahsan Manzil exterior model — parameter-by-parameter deviation report

**Status:** Parametric heritage exterior draft. These are procedural meshes, not a photogrammetry scan, measured point cloud, or survey; pixel-perfect accuracy is not claimed.

## Assets

| File | Purpose |
|---|---|
| `public/models/ahsan-manzil-lod1.glb` | Low-detail massing |
| `public/models/ahsan-manzil-lod2.glb` | Roofline, parapet, dome and simplified facade rhythm |
| `public/models/ahsan-manzil-lod3.glb` | Recessed arches, bay pilasters, timber/glazed central door, louvered end-pavilion windows, upper-arch balustrades, central oculus and pinnacles, open eight-sided dome drum, tapered ceremonial stair and full roof/parapet detail |
| `public/models/ahsan-manzil.glb` | Convenience alias of LOD3 |
| `public/models/ahsan-manzil.manifest.json` | Runtime building manifest / LOD parameters |
| `data/heritage/ahsan-manzil.parameters.json` | Confidence-tagged parameter source |
| `scripts/build-ahsan-manzil-model.mjs` | Reproducible source-controlled GLB generator |
| `tests/heritage-model.test.mjs` | GLB/node/parameter/navigation/LOD integrity tests |

Build assets with `npm run build:heritage-model`. All models include nodes `Plinth`, `Rangmahal_GF`, `Rangmahal_FF`, `Portico_S`, `Portico_N`, `Stair_S`, `Veranda_S`, `Veranda_N`, `Parapet`, `Dome_Drum`, `Dome`, `Finial`, `Andarmahal`.

## Coordinate system and runtime behavior

- GLB units are meters, Y is up, X is the approximate east-west long axis, and +Z is the south/river-front side. Natural ground is Y=0; plinth top is Y=1.0 m.
- The provisional anchor is 23.7086, 90.40606 [C]; it is not yet proven to be the traced footprint centroid.
- The initial map view and Home control focus the main river-facing Rangmahal. **Top view** is a north-up whole-footprint view, and **360° tour** starts a slow guided orbit from the south facade. Manual rotation controls return to a low oblique inspection angle.
- The model uses the 183 ft (55.8 m) working Rangmahal frontage [C] and derives the adjoining west Andarmahal length as 69.6 m [E] so the full reported east-west extent is 125.4 m. Andarmahal is provisionally set back to the north by 14.375 m in a stepped/L-shaped footprint [E]. This is a reconciliation hypothesis, not a traced survey footprint.
- The dome, upper portal and broad staircase share the centreline of the 55.8 m Rangmahal front. The overall-footprint camera origin remains at the provisional extents centre; the front camera has a separate 34.8 m eastward view offset [E] and does not change the georeferenced building anchor.
- The exposed Rangmahal west end is modelled only where it is visible beside the rear-set Andarmahal; short-end walls and the north/south parapets follow the stepped plan rather than occupying the same volume twice.
- LOD3 includes recessed arches/pilasters, timber-and-glass portal door, upper louvered end windows, small upper-arch balustrades, central balcony/oculus/pinnacles, an eight-sided open drum, stair cheek rails/lamp posts, and the salmon-pink palette. The precise historical mouldings, glazing pattern, colours, and bay counts remain [E]/[?]. The older Andarmahal's floor-height stack uses a provisional 0.94 scale (about 0.65 m lower at the roof deck) to separate its roofline from Rangmahal; this is an estimate, not a surveyed dimension.
- The central portico continues through the upper storey with a second triple-arched loggia and a triangular pediment above it; the pediment peak is parameterized at 15.2 m [E] pending a rectified facade.
- Camera presets are intentionally split: Front frames the south-facing Rangmahal; Full model and every manual orbit step frame the complete stepped footprint; Top view shows the north-up plan; the guided 360° tour revolves around the footprint centre at a 205 m range. The tour pauses on direct pointer, touch, or wheel input so users can take control.
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
| footprint.rangmahalBlockLength | [C] | 55.8 m | 183 ft (55.8 m) whole-frontage width reported by Daily Star / Adnan Zillur Morshed | Working river-facing Rangmahal length. It intentionally does not equal half of the 125.4 m overall extent; verify from a top-down trace. |
| footprint.andarmahalBlockLength | [E] | 69.6 m | 125.4 m overall extent minus the 55.8 m Rangmahal frontage | Derived working western/rear block length; not independently surveyed. |
| footprint.interiorGridEW | [V] | 4 bays | Supplied brief | Recorded separately; not treated as exterior opening count. |
| footprint.interiorGridNS | [V] | 5 bays | Supplied brief | Recorded separately; not treated as exterior opening count. |
| footprint.exteriorBayCount | [E] | 15 bays per Rangmahal long facade | Single south-elevation reference photo, composition 2 + 4 + 3 + 4 + 2 | Provisional symmetric front pattern; recount from a straight-on elevation. |
| footprint.averageBayPitch | [E] | 3.72 m | 55.8 m / 15 estimated Rangmahal bays | Derived pitch; it differs from the initial generic 4.5–5.5 m estimate and needs calibration from a rectified facade. |
| footprint.andarmahalDepth | [E] | 14.375 m | Half the reported 28.75 m total depth | Provisional shallower Andarmahal depth for the stepped footprint. |
| footprint.andarmahalNorthOffset | [E] | -7.1875 m | Derived from half the 28.75 m overall depth | Moves the Andarmahal to the rear/north so its south edge is 14.375 m behind the Rangmahal river-front facade. |
| footprint.andarmahalBayCount | [E] | 8 bays | Procedural estimate for the older western Andarmahal block | Keep distinct from the 15-bay Rangmahal facade until a measured plan/photo confirms it. |
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
| facade.porticoWidth | [E] | 18.6 m | 15-bay Rangmahal frontage estimate: 55.8 m / 15 = 3.72 m bay pitch | Five estimated bay pitches align the central triple-arch pavilion with the openings it replaces; verify from a rectified south elevation. |
| facade.porticoDepth | [E] | 4 m | Procedural placeholder until footprint/photo calibration | Projection depth of the central portico. | 
| facade.balustradeHeight | [E] | 0.9 m | Visible upper-veranda guardrail proportion in exterior photographs | Approximate guardrail height above veranda floor. |
| facade.balusterSpacing | [E] | 0.85 m | Procedural rendering parameter | Approximate post interval; replace after elevation/photo calibration. |
| facade.rooflinePinnacleHeight | [E] | 1.5 m | Visible small roofline finials/pinnacles in exterior photographs | Stylized height above parapet; not a measured ornamental profile. |
| facade.pedimentPeakHeightAboveGround | [E] | 15.2 m | Approximate exterior-photo proportion for the roof pediment above the first-floor triple-arched loggia | Updated from the earlier too-low placeholder; recalibrate against a rectified south facade. |
| facade.doorBayInterval | [E] | 4 bays | Procedural modeling default until a rectified facade image is counted | Every fourth exterior bay is treated as a glazed door in LOD2/LOD3; actual count and placement require photo calibration. |
| facade.stoneInlayBandWidth | [?] | 0.08 m | Procedural placeholder for the stone inlay described in the heritage brief | Band width and exact stone pattern are unknown; replace after close-up door photographs. |
| facade.doorGlazingPattern | [?] | simple multi-panel colored glazing with vertical center stile | Placeholder derived from documented colored-glass doors | Do not treat panel count/color pattern as verified. |
| stair.riserHeight | [E] | 0.2286 m | 6.4 m upper portal datum / 28 estimated risers | Twenty-eight estimated risers align with the 6.4 m upper portal datum; verify the actual step count from a straight-on photograph. |
| stair.treadDepth | [E] | 0.5714 m | 16.0 m horizontal run / 28 estimated steps | Restores the broad ceremonial run; the previous 0.34 m tread / 9.52 m run compressed the stair. Verify against measured plan imagery. |
| stair.stepCount | [E] | 28 steps | Single front reference photo estimate (25–30 steps) | Count from a straight-on photograph to replace this estimate. |
| stair.width | [E] | 39.0 m | Approximate base-to-frontage ratio from the south-elevation reference image | Lower flight is provisionally about 70% of the 55.8 m Rangmahal frontage; an image-based estimate, not a measured width. |
| stair.sideRail | [?] | simple low side rails | Stylized placeholder |  |
| stair.runLength | [E] | 16 m | Single front reference photo estimate | Horizontal garden run toward the river; not site-surveyed. |
| stair.topWidth | [E] | 18.6 m | Aligned to the provisional triple-arched portico width | The top landing aligns to the central portico and tapers from the broad base; verify from rectified elevation. |
| dome.peakHeight | [V] | 27.13 m above ground | Bangladesh Tourism Board heritage newsletter |  |
| dome.drumHeight | [E] | 5 m | Supplied placeholder |  |
| dome.bodyHeight | [E] | 6.53 m | Derived to meet 27.13 m peak with 13.6 m roofline and 2 m finial |  |
| dome.finialHeight | [E] | 2 m | Supplied placeholder |  |
| dome.drumWidth | [?] | 14 m | Placeholder; calibrate from elevation photo |  |
| dome.profile | [V] | square base room → octagonal drum → lotus-bud dome → finial | Supplied brief | Curvature and ribs remain stylized. |
| dome.drumOpeningCount | [E] | 8 open bays around octagonal drum | Reference-image interpretation of an open/fenestrated drum | One open arch per octagonal face is a procedural reconstruction; verify from oblique and elevation photographs. |
| dome.drumOpeningWidth | [E] | 2.7 m | Single reference photo estimate for open colonnade bays | Wider openings deliberately read as a colonnade rather than small glazed windows. |
| dome.drumOpeningCrownHeight | [E] | 2.8 m | Single reference photo estimate | Opening crown within the 5 m drum; measure from a rectified elevation. |
| dome.profileRings | [E] | [[6.9,0],[6.7,0.35],[6.1,1.1],[5.4,2],[4.55,2.9],[3.55,3.8],[2.55,4.65],[1.55,5.45],[0.28,6.53]] [radius_m, height_above_dome_base_m] pairs | Procedural lotus-bud profile constrained to the 27.13 m peak | Control points are illustrative; replace with samples from a rectified elevation photo. |
| materials.facadePink | [E] | #E1917D | User-supplied daylight photo estimate | Warm salmon pink; final colour still needs a calibrated daylight sample. |
| materials.trimOffWhite | [E] | #E99C8A | User-supplied daylight photo estimate | Trim intentionally stays in the same pink family; the old off-white trim was incorrect. |
| materials.glass | [?] | #583943 | Generic dark glazing proxy |  |
| materials.roof | [E] | #CC8274 | User-supplied daylight photo estimate | Muted rose parapet/roof proxy; the roof covering itself remains unknown. |
| materials.verandaFloor | [V] | #EFE6D5 | Supplied brief; light marble proxy |  |
| materials.stairStone | [E] | #6E625A | User-supplied reference photo estimate | Dark grey-brown exterior stair material. |
| materials.doorWood | [E] | #6B4A32 | User-supplied reference photo estimate | Brown wood for the upper portal door and shutters. |
| roof.covering | [?] | flat roof behind parapet; covering material unknown | Supplied brief |  |
| roof.structure | [V] | timber/iron beams, interior only | Supplied brief | Not included in exterior mesh. |
| runtimeLod.lod1MaxDistance | [E] | 18000 m from view centre to provisional anchor | Rendering heuristic in heritage-landmarks.mjs | Show only when the view centre is within 18 km and camera height is at most 20 km. |
| runtimeLod.lod1MaxCameraHeight | [E] | 20000 m | Rendering heuristic in heritage-landmarks.mjs | Rendering threshold, not a building measurement. |
| runtimeLod.lod2MaxDistance | [E] | 6500 m from view centre to provisional anchor | Rendering heuristic in heritage-landmarks.mjs | Show when closer than this and camera height is at most 8 km unless LOD3 threshold is met. |
| runtimeLod.lod2MaxCameraHeight | [E] | 8000 m | Rendering heuristic in heritage-landmarks.mjs | Rendering threshold, not a building measurement. |
| runtimeLod.lod3MaxDistance | [E] | 2000 m from view centre to provisional anchor | Rendering heuristic in heritage-landmarks.mjs | Show detail mesh when closer than this and camera height is at most 2.5 km. |
| runtimeLod.lod3MaxCameraHeight | [E] | 2500 m | Rendering heuristic in heritage-landmarks.mjs | Rendering threshold, not a building measurement. |
| runtimeCamera.frontFocusOffsetEastMeters | [E] | 34.8 m | Centreline of the 55.8 m Rangmahal front, relative to overall-footprint centre | View-only offset; it does not move the georeferenced model anchor. |
| runtimeCamera.frontCameraRangeMeters | [E] | 112 m | Camera-framing estimate for the 55.8 m south-facing Rangmahal, projecting portico, dome and ceremonial stair | This is the focused facade view; use Full model or the guided tour for the entire stepped footprint. |
| runtimeCamera.footprintCameraRangeMeters | [E] | 205 m | Camera-framing estimate for the 125.4 m stepped overall extent | Used by Full model, manual orbit steps, guided 360° tour and north-up Top view to keep Andarmahal and Rangmahal inside frame. |
| runtimeCamera.orbitPitchDegrees | [E] | -24 degrees | Oblique-view estimate | Keeps the upper dome/drum and the side depth visible without flattening the facade. |
| runtimeCamera.orbitDegreesPerSecond | [E] | 8 degrees/second | Camera interaction choice | A lap takes about 45 seconds, giving more time to inspect the side and rear elevations. |
| runtimeCamera.frontBoundingSphereRadiusMeters | [E] | 50 m | Focused framing estimate around the south-facing Rangmahal, central portico, dome and stair | Rear-set Andarmahal is intentionally covered by the separate overall-footprint camera sphere. |
| runtimeCamera.footprintBoundingSphereRadiusMeters | [E] | 72 m | Whole-footprint framing estimate | Used for Full model, manual orbit steps, guided 360° tour and Top view. |

## Deviations and remaining calibration work

1. Footprint polygon, building centroid and exact azimuth still need tracing from satellite imagery/OSM. Anchor stays [C], rotation [E].
2. The current plan uses a 55.8 m Rangmahal frontage [C] from the 183 ft architectural description and a derived 69.6 m Andarmahal extent [E] to reconcile the 125.4 m overall length. Andarmahal is set back to the north in a provisional stepped footprint; a north-up satellite trace or measured plan must confirm this before survey-grade placement.
3. The 15-bay 2 + 4 + 3 + 4 + 2 Rangmahal facade rhythm and 8-bay Andarmahal estimate are from a single reference photo and are intentionally distinct from the 4 × 5 reported interior grid.
4. Door positions use every fourth facade bay [E]; stone-inlay width and colored-glazing pattern are [?]. Replace from close-up photographs.
5. Capitals, fluting, arch moulds, stone patterns, roofline pinnacles and dome ribs are stylized, not measured historic mouldings. Short-end opening rhythm and balustrade spacing are estimates.
6. Dome apex is constrained to 27.13 m [V], while drum width/openings and the ring profile still need a rectified elevation photo.
7. Body #E1917D, trim #E99C8A, stair #6E625A and wood #6B4A32 are user-supplied visual estimates; none have been sampled from colour-managed daylight photography.
8. Interior wooden staircase, timber/iron roof structure, and interior tile floors are outside the exterior LODs.
9. LOD distance/altitude cut-offs are render-performance heuristics [E].
10. Local browser renders have not been visually verified from this environment. Use Top view to capture a north-up footprint screenshot and the 360° tour to inspect all elevations; then recalibrate [E]/[?] parameters against rectified photos.

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
