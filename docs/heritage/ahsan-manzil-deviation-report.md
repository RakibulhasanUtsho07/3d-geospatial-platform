# Ahsan Manzil exterior model — deviation report

**Status:** Provisional parametric exterior, not a survey or photogrammetry reconstruction.

## Model assets
- `public/models/ahsan-manzil-lod1.glb` — low-detail massing.
- `public/models/ahsan-manzil-lod2.glb` — facade rhythm, roofline, parapet and dome with simplified arches.
- `public/models/ahsan-manzil-lod3.glb` — repeated arched openings, simplified trim/pilasters, porticos, veranda arcades, broad staircase, octagonal drum, lotus-bud dome and finial.
- Required semantic nodes: `Plinth`, `Rangmahal_GF`, `Rangmahal_FF`, `Portico_S`, `Portico_N`, `Stair_S`, `Veranda_S`, `Veranda_N`, `Parapet`, `Dome_Drum`, `Dome`, `Finial`, `Andarmahal`.
- Local units: meters; Y up; natural ground y=0; +Z is south / river-front facade.
- Map default: Shat Gombuj Mosque, Bagerhat. Ahsan Manzil remains at a provisional Old Dhaka anchor.

## Parameter register

| Parameter | Tag | Current value | Source / rationale |
|---|---:|---:|---|
| Overall footprint | [C] | 125.4 × 28.75 m | Bangladesh Tourism Board; trace final footprint |
| Rangmahal block length | [C] | 55.8 m | 183 ft hypothesis from supplied brief |
| Andarmahal length | [E] | 69.6 m | Derived remainder |
| Interior structural grid | [V] | 4 × 5 bays | Supplied brief; separate from exterior openings |
| Exterior bay count / pitch | [E] | 24 / 5.225 m | Procedural estimate pending elevation-photo count |
| Plinth | [V] | 1.0 m | Tourism source; 1.2 m alternate [C] |
| Storey clear heights | [V] | 5.0 m / 5.8 m | Bangladesh Tourism Board / Parjatan |
| Wall / reveal depth | [V] | 0.78 m | Bangladesh Tourism Board |
| Slab / parapet | [E] | 0.4 m / 1.0 m | Supplied placeholders |
| Roofline | [E] | 13.6 m | Derived vertical stack |
| Portico height | [V] | 5.0 m | Bangladesh Tourism Board |
| GF openings | [E] | 1.2 m wide, 3.2 m to crown | Supplied placeholder |
| FF openings | [E] | 1.3 m wide, 3.8 m to crown | Supplied placeholder |
| Veranda arcade span | [E] | 3.3 m | Midpoint of 3.0–3.5 m range |
| Stair | [E]/[?] | 12 m wide; 0.16 m riser; 0.4 m tread; 40 steps | Provisional route to upper portal |
| Dome peak | [V] | 27.13 m above ground | Bangladesh Tourism Board heritage newsletter |
| Drum / dome body / finial | [E] | 5.0 m / 6.53 m / 2.0 m | Dome body derived to meet the verified overall peak |
| Drum width | [?] | 14 m | Placeholder pending rectified elevation |
| Facade / trim | [E] | #E7A3AE / #F4EDE0 | Supplied color placeholders |
| Glazing / roof cover | [?] | Generic glazing; cover unknown | Not presented as verified historic material |
| Georeference | [C] | 23.70860, 90.40606 | User-supplied anchor; not traced centroid |
| Long-axis azimuth | [E] | 90° | Approximate east-west assumption |

## Deviations / calibration backlog

1. Footprint is not yet traced. The anchor is provisional and may not be the footprint centroid.
2. Long-axis azimuth is approximate; it must be measured from satellite/OSM imagery.
3. The 55.8 m Rangmahal / 69.6 m Andarmahal split is a hypothesis, not a verified plan dimension.
4. The exterior bay count and opening sizes are estimates; the 4 × 5 grid is recorded independently and is not silently treated as a facade opening count.
5. LOD3 capitals, fluting, glazing, railing, and dome ribs are stylized geometry, not measured mouldings.
6. Dome peak is constrained to 27.13 m; drum width and curvature still need elevation-photo calibration.
7. Pink/trim colors are not daylight-sampled.
8. Interior stair, interior finish tiles, and roof beams are not included in this exterior-only GLB.
9. No survey, point cloud, photogrammetry, or pixel-perfect accuracy is claimed.

**Next:** trace footprint → rectify south elevation with 5.0 m / 5.8 m storey heights and 27.13 m dome peak → count openings → recalibrate every [E]/[?] value → regenerate and inspect in Cesium.
