# Ahsan Manzil exterior model — parameter-by-parameter deviation report

**Status:** Provisional parametric exterior reconstruction. The supplied assets are procedural meshes and are **not** a photogrammetry scan, surveyed model, or pixel-perfect reconstruction.

## Deliverables

| Asset | Purpose |
|---|---|
| `public/models/ahsan-manzil-lod1.glb` | Low-detail massing |
| `public/models/ahsan-manzil-lod2.glb` | Massing, roof/parapet, dome and simplified facade rhythm |
| `public/models/ahsan-manzil-lod3.glb` | Facade openings, simplified trim/pilasters, veranda arcades, porticos, staircase, dome ribs and finial |
| `public/models/ahsan-manzil.glb` | Convenience alias of LOD3 |
| `public/models/ahsan-manzil.manifest.json` | Runtime model manifest consumed by the Cesium adapter |
| `data/heritage/ahsan-manzil.parameters.json` | Parameter registry with confidence and source metadata |

All LODs provide the semantic node names requested: `Plinth`, `Rangmahal_GF`, `Rangmahal_FF`, `Portico_S`, `Portico_N`, `Stair_S`, `Veranda_S`, `Veranda_N`, `Parapet`, `Dome_Drum`, `Dome`, `Finial`, `Andarmahal`.

Local units are meters. Geometry uses local X east-west, Y up, +Z south/river-front; natural ground is y=0. The location and orientation remain provisional as noted below.

## Parameter register

Every parameter from `georeference` and `parameters` in the JSON is included here. [V] verified, [C] conflicting, [E] estimate/placeholder, [?] unknown.

| Parameter | Tag | Current/final model value | Source | Note / deviation |
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

## Runtime manifest summary

| Field | Current value | Confidence |
|---|---|---|
| Model ID | `ahsan-manzil-kumartuli-dhaka` | — |
| Display name | Ahsan Manzil (Pink Palace) (আহসান মঞ্জিল) | — |
| Anchor | 23.7086, 90.40606 | [C] |
| Long-axis azimuth | 90° | [E] |
| Default asset | `/models/ahsan-manzil-lod3.glb` | LOD3 |
| Unit | meters | — |
| Status | provisional-not-survey-verified | Not survey-verified |

## Known deviations and unverified items

1. **Footprint not traced:** the anchor point is from the provided brief, not a verified footprint centroid. Final location must be corrected after tracing OSM/satellite imagery.
2. **Orientation estimated:** a due east-west long axis is used as a placeholder. Measure the true azimuth from the traced footprint.
3. **Block split is a hypothesis:** the 55.8 m Rangmahal dimension has not been confirmed from a plan; Andarmahal length is the derived remainder.
4. **Exterior opening rhythm is estimated:** the 24-bay placeholder is independent of the specified 4 × 5 interior structural grid. Recount facade arches/openings from a perspective-rectified photo.
5. **Details are procedural:** capitals, fluting, arch profiles, colored glazing, stair rails, and dome ribs are simplified geometry rather than measured historic mouldings.
6. **Dome profile needs calibration:** the finial peak is constrained to 27.13 m, but drum diameter, curvature, and exact drum opening rhythm remain estimated/unknown.
7. **Colors are placeholders:** pink, trim and roof colors have not been sampled from color-managed daylight imagery.
8. **Exterior-only scope:** interior timber/iron structure, interior stairs and tiled rooms are not in this GLB.
9. **Map placement:** the model loads at its provisional [C] anchor; Shat Gombuj Mosque is the map's default camera target, so the Ahsan Manzil mesh will be visible after navigating back to Old Dhaka.
10. **LOD semantics:** three mesh assets are shipped. The current adapter loads LOD3 by default; automatic camera-distance swapping between the three assets is not yet implemented.
11. **No survey-grade claims:** there is no point cloud, photogrammetry, measured plan, orthophoto rectification or onsite ground-truth validation in this pass.

## Calibration order

Trace footprint and centroid → measure azimuth → rectify south elevation against the 5.0 m and 5.8 m storey heights and the 27.13 m dome peak → count openings and bays → replace [E]/[?] parameters → adjust sampled materials → regenerate the assets → inspect placement and facade details in Cesium.

## Source register

- **Ahsan Manzil — Bangladesh Tourism Board** — https://beautifulbangladesh.gov.bd/cat/heritage/3
- **Ahsan Manzil: an aristocracy of the ancient era — Bangladesh Tourism Board** — https://beautifulbangladesh.gov.bd/newsletter/single/479
- **Ahsan Manzil — Bangladesh Parjatan Corporation** — https://parjatan.portal.gov.bd/pages/static-pages/6922ddbe933eb65569e16134
- **Historic Mosque City of Bagerhat — UNESCO World Heritage Centre** — https://whc.unesco.org/en/list/321/
- **Historic Mosque City of Bagerhat — UNESCO geographic information** — https://whc.unesco.org/document/216536
