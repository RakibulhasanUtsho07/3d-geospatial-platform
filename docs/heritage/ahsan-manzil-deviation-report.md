# Ahsan Manzil exterior model — parameter-by-parameter deviation report

**Status:** Parametric heritage exterior draft. This is procedural geometry, not a photogrammetry scan, measured point cloud, survey, or pixel-perfect reconstruction.

## Generated assets and build command

| Asset | Purpose |
|---|---|
| `public/models/ahsan-manzil-lod1.glb` | Low-detail massing |
| `public/models/ahsan-manzil-lod2.glb` | Massing, real window apertures, roof/parapet and simplified dome |
| `public/models/ahsan-manzil-lod3.glb` | Detailed arched apertures, trims/pilasters, porticos, veranda arcades, staircase, octagonal drum, dome ribs and finial |
| `public/models/ahsan-manzil.glb` | Convenience alias of LOD3 |
| `public/models/ahsan-manzil.manifest.json` | Runtime asset manifest and LOD thresholds |
| `data/heritage/ahsan-manzil.parameters.json` | Tagged parameter registry |
| `scripts/build-ahsan-manzil-model.mjs` | Reproducible Node.js GLB generator |
| `tests/heritage-model.test.mjs` | GLB, parameter, navigation and LOD integrity checks |

Generate all model files from the repository root with `npm run build:heritage-model`. Every generated model has the required named nodes: `Plinth`, `Rangmahal_GF`, `Rangmahal_FF`, `Portico_S`, `Portico_N`, `Stair_S`, `Veranda_S`, `Veranda_N`, `Parapet`, `Dome_Drum`, `Dome`, `Finial`, `Andarmahal`.

## Coordinate frame and LOD behavior

- Units: meters; GLB Y-up; X east-west; +Z south/river-front; natural ground Y=0.
- Anchor: 23.7086, 90.40606 [C]. It is a provisional reference point, **not yet verified as the traced building-footprint centroid**.
- Axis azimuth: 90° [E], approximate east-west.
- Cesium explicitly uses Y-up / X-forward axis alignment and the model is loaded at the provisional anchor.
- Default map opens at Shat Gombuj Mosque; the map controls include a direct Ahsan Manzil jump button. Ahsan LOD assets load/unload according to estimated view distance and camera height.

## Complete parameter register

Every entry from the JSON georeference and model parameters is listed with its confidence tag, value, source and current note. [V] verified; [C] source conflict or untraced georeference; [E] estimate/placeholder; [?] unknown.

| Parameter | Tag | Current value | Source | Notes / deviation |
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
| facade.porticoWidth | [E] | 16 m | Procedural placeholder until elevation is measured | Width of the central projecting portico/pediment proxy. |
| facade.porticoDepth | [E] | 4 m | Procedural placeholder until footprint/photo calibration | Projection depth of the central portico. |
| facade.pedimentPeakHeightAboveGround | [E] | 8.35 m | Procedural pediment proxy | Absolute top of the triangular pediment. Recalibrate against a rectified south facade. |
| stair.riserHeight | [E] | 0.16 m | Supplied brief |  |
| stair.treadDepth | [E] | 0.4 m | Procedural placeholder |  |
| stair.stepCount | [?] | 40 steps | Derived from 6.4 m rise / 0.16 m riser |  |
| stair.width | [E] | 12 m | Portal-width approximation |  |
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

## Known deviations and calibration backlog

1. **Footprint tracing is still pending.** The anchor was selected from the supplied brief and agrees closely with Wikipedia's coordinate, but an OSM/satellite polygon-centroid trace has not been performed in this pass.
2. **Orientation remains approximate.** Due east-west is used as a provisional long-axis orientation; replace with a measured azimuth from the traced polygon.
3. **Block split is a hypothesis.** The 55.8 m Rangmahal length follows the 183 ft interpretation in the brief. Andarmahal length is derived by subtraction.
4. **Opening rhythm is not photo-calibrated.** The exterior bay count derives from the estimated pitch; the separate 4 × 5 structural grid is not treated as an exterior window count.
5. **Ornament is stylized.** Capital/fluting, colored glass pattern, stone inlay, railing, some arch profiles and the pediment are procedural proxies.
6. **Dome profile is only peak-constrained.** Peak is 27.13 m; drum width and window count remain [?/E] placeholders, while ring radii/heights are a provisional profile.
7. **Colors are placeholders.** The pink and trim values have not been sampled from a color-managed daylight image.
8. **Interior is excluded.** Inner wooden staircase, timber/iron roof structure, and white/green/yellow interior tile floor are recorded but not included in exterior GLBs.
9. **Rendering thresholds are estimates.** They tune loading cost; they are not historic-building measurements.
10. **Local build/lint/browser check is outstanding.** Do not claim that the live Cesium scene has passed visual inspection until the commands and browser check are completed.

## Calibration order

Trace OSM/satellite footprint → shift origin to its centroid → measure long-axis azimuth → rectify the south elevation against the 5.0 m / 5.8 m storey heights and 27.13 m dome peak → count openings and veranda arches → overwrite [E]/[?] values → sample daylight colors → regenerate GLBs → inspect all LODs in Cesium.

## Source register

- **Ahsan Manzil — Bangladesh Tourism Board** — https://beautifulbangladesh.gov.bd/cat/heritage/3
- **Ahsan Manzil: an aristocracy of the ancient era — Bangladesh Tourism Board** — https://beautifulbangladesh.gov.bd/newsletter/single/479
- **Ahsan Manzil — Bangladesh Parjatan Corporation** — https://parjatan.portal.gov.bd/pages/static-pages/6922ddbe933eb65569e16134
- **Historic Mosque City of Bagerhat — UNESCO World Heritage Centre** — https://whc.unesco.org/en/list/321/
- **Historic Mosque City of Bagerhat — UNESCO geographic information** — https://whc.unesco.org/document/216536
- **Ahsan Manzil — Wikipedia** — https://en.wikipedia.org/wiki/Ahsan_Manzil — Coordinates near 23.7085972 N, 90.4060583 E agree closely with supplied anchor. Anchor still remains [C] until footprint polygon centroid is traced.
- **A Palace on the River: Ahsan Manzil — The Daily Star, Adnan Zillur Morshed** — https://www.thedailystar.net/slow-reads/focus/news/palace-the-river-ahsan-manzil-1598293
