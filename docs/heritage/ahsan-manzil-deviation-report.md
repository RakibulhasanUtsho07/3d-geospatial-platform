# Ahsan Manzil exterior model — parameter-by-parameter deviation report

**Status:** Provisional parametric exterior reconstruction. These procedural meshes are not a survey, point-cloud or photogrammetry model and are not claimed to be pixel-perfect.

## Deliverables

| Asset | Purpose |
|---|---|
| `public/models/ahsan-manzil-lod1.glb` | Low-detail massing |
| `public/models/ahsan-manzil-lod2.glb` | Roofline, parapet, dome and simplified facade rhythm |
| `public/models/ahsan-manzil-lod3.glb` | Openings, simplified trim/pilasters, porticos, veranda arcades, staircase, dome ribs and finial |
| `public/models/ahsan-manzil.glb` | Convenience alias of LOD3 |
| `public/models/ahsan-manzil.manifest.json` | Runtime building manifest and LOD thresholds |
| `data/heritage/ahsan-manzil.parameters.json` | Tagged parameter registry |
| `tests/heritage-model.test.mjs` | GLB header/node and parameter/LOD integrity tests |

Required GLB node names: `Plinth`, `Rangmahal_GF`, `Rangmahal_FF`, `Portico_S`, `Portico_N`, `Stair_S`, `Veranda_S`, `Veranda_N`, `Parapet`, `Dome_Drum`, `Dome`, `Finial`, `Andarmahal`.

## Coordinate and LOD rules

- Units: meters. GLB local axes: X east-west, Y up, +Z south/river-front. Natural ground is Y=0; plinth top is Y=1.0 m.
- The current anchor is 23.7086, 90.40606 [C]. It has **not** been proven to be the traced footprint centroid.
- Long-axis rotation is approximately 90° [E]. It needs measurement from satellite/OSM geometry.
- Model loads only when view-centre distance and camera height meet the selected LOD threshold; it unloads outside all thresholds. The loader explicitly aligns GLB Y-up and +X long axis to the georeferenced east-west model frame. The threshold values are editable [E] parameters. Browser/build validation is still required.

## Parameter register

Each georeference/architectural/rendering parameter below includes the current value, confidence tag, source and note. [V] verified, [C] conflicting, [E] estimate/placeholder, [?] unknown.

| Parameter | Tag | Current value | Source | Notes / deviation |
|---|---|---|---|---|
| Georeference.latitude | [C] | 23.7086 degrees_north | User-supplied anchor; alternate map listings conflict | Shift to traced footprint centroid before calling final. |
| Georeference.longitude | [C] | 90.40606 degrees_east | User-supplied anchor; alternate map listings conflict | Shift to traced footprint centroid before calling final. |
| Georeference.longAxisAzimuthDegrees | [E] | 90 degrees | Approximate east-west direction in supplied brief | Measure from satellite/OSM imagery. |
| Georeference.axes | [E] | X east-west; Y up; +Z south / river-front | Local model coordinate convention |  |
| Georeference.riverFacade | [V] | south | Bangladesh Tourism Board and supplied brief |  |
| Georeference.rearFacade | [V] | north | Supplied brief |  |
| Georeference.units | [V] | meters | User request |  |
| footprint.overallLength | [C] | 125.4 m | Bangladesh Tourism Board / Parjatan | Working dimension pending footprint trace. |
| footprint.overallDepth | [C] | 28.75 m | Bangladesh Tourism Board | Working dimension; resolve against satellite/plan. |
| footprint.rangmahalBlockLength | [C] | 55.8 m | 183 ft hypothesis in supplied brief | Assumes this dimension is the eastern dome block. |
| footprint.andarmahalBlockLength | [E] | 69.6 m | 125.4 m minus 55.8 m | Derived remainder, not independently surveyed. |
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
| stair.riserHeight | [E] | 0.16 m | Supplied brief |  |
| stair.treadDepth | [E] | 0.4 m | Procedural placeholder |  |
| stair.stepCount | [?] | 40 steps | Derived from 6.4 m rise / 0.16 m riser |  |
| stair.width | [E] | 12 m | Portal-width approximation |  |
| stair.sideRail | [?] | simple low side rails | Stylized placeholder |  |
| dome.peakHeight | [V] | 27.13 m above ground | Bangladesh Tourism Board heritage newsletter |  |
| dome.drumHeight | [E] | 5 m | Supplied placeholder |  |
| dome.bodyHeight | [E] | 6.53 m | Derived to meet 27.13 m peak with 13.6 m roofline and 2 m finial |  |
| dome.finialHeight | [E] | 2 m | Supplied placeholder |  |
| dome.drumWidth | [?] | 14 m | Placeholder; calibrate from elevation photo |  |
| dome.profile | [V] | square base room → octagonal drum → lotus-bud dome → finial | Supplied brief | Curvature and ribs remain stylized. |
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

## Known deviations / calibration backlog

1. **Footprint not traced:** final width/depth edges, building centroid and exact OSM/satellite alignment remain pending. The supplied anchor is provisional.
2. **Orientation approximate:** due east-west is a modeling default, not a measured azimuth.
3. **Block split is a hypothesis:** the 55.8 m Rangmahal length assumes the 183 ft source applies to the eastern dome block; Andarmahal length is derived from the remainder.
4. **Facade rhythm estimated:** the exterior 24-bay count is an estimate and is not inferred from the separately reported 4 × 5 interior grid.
5. **Ornament is stylized:** Corinthian-type capitals, fluting, glass patterns, railing, moulding and arch geometry are simplified proxies.
6. **Dome profile constrained at peak:** 27.13 m is the scale target; drum width, drum openings and dome curvature are not elevation-photo calibrated.
7. **Colors not sampled:** pink and trim colors remain uncalibrated placeholders.
8. **Exterior only:** interior wooden staircase, timber/iron roof structure and white/green/yellow tile floors are not modeled in this exterior LOD set.
9. **LOD parameters estimated:** render thresholds tune performance; they do not describe a historical property of the palace.
10. **No local runtime verification yet:** GLB assets and code are committed, but a local `npm run test:heritage-model`, `npm run lint` and `npm run build` are required before claiming the complete branch is validated.

## Calibration order

Trace the footprint and centroid → measure the real long-axis azimuth → rectify the south facade against 5.0 m / 5.8 m storey heights and 27.13 m dome peak → count openings and pitches → overwrite [E]/[?] parameters → daylight-sample materials → regenerate and inspect all LODs in Cesium.

## Source register

- **Ahsan Manzil — Bangladesh Tourism Board** — https://beautifulbangladesh.gov.bd/cat/heritage/3
- **Ahsan Manzil: an aristocracy of the ancient era — Bangladesh Tourism Board** — https://beautifulbangladesh.gov.bd/newsletter/single/479
- **Ahsan Manzil — Bangladesh Parjatan Corporation** — https://parjatan.portal.gov.bd/pages/static-pages/6922ddbe933eb65569e16134
- **Historic Mosque City of Bagerhat — UNESCO World Heritage Centre** — https://whc.unesco.org/en/list/321/
- **Historic Mosque City of Bagerhat — UNESCO geographic information** — https://whc.unesco.org/document/216536
- **Ahsan Manzil — Wikipedia** — https://en.wikipedia.org/wiki/Ahsan_Manzil — Coordinates near 23.7085972 N, 90.4060583 E agree closely with supplied anchor. Anchor still remains [C] until footprint polygon centroid is traced.
- **A Palace on the River: Ahsan Manzil — The Daily Star, Adnan Zillur Morshed** — https://www.thedailystar.net/slow-reads/focus/news/palace-the-river-ahsan-manzil-1598293
