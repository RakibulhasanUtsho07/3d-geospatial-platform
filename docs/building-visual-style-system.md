# Building Visual Style System

## Purpose

The first building-rendering pass converts Overture building footprints into lightweight extruded Cesium entities. This module adds a deterministic procedural facade style so nearby buildings look less like uniform blocks without requiring downloaded textures or a separate 3D model for every footprint.

## Current pipeline

1. Read Overture feature properties and resolve the best available height estimate.
2. Resolve a stable facade palette and pattern from the feature ID, approximate height, and available building-use metadata.
3. Sort building entities by distance from the initial Dhaka camera target before applying the detailed-facade budget.
4. Apply canvas-generated repeating wall textures to a limited number of nearby buildings. Remaining buildings retain lightweight polygon extrusion.
5. Preserve roof color separately from the facade texture and keep feature selection attached to the original Cesium entity.

## Style patterns

- `balcony`: framed windows with balcony rails, best for residential mid-rise buildings.
- `vertical-glass`: tall window bays and vertical accents, best for offices, hotels, and taller buildings.
- `urban-grid`: repeated window grid for general urban blocks.
- `compact`: smaller repeated windows for low-rise and industrial-style footprints.

Palette and pattern selection are deterministic. The same feature ID should retain its style across reloads, avoiding random visual flicker.

## Performance controls and camera-aware LOD

The map starts by styling the full Overture pilot with lightweight polygon extrusions in batches. It then promotes only a bounded set of buildings near the live view center to textured facades. The detail budget is selected from camera altitude:

| Camera height | Detailed facade budget |
| --- | ---: |
| Below 2.5 km | 650 |
| 2.5–6 km | 420 |
| 6–12 km | 220 |
| 12–25 km | 80 |
| 25 km and above | 0 |

After a camera move ends, the adapter picks the center of the current view on the ellipsoid, ranks eligible building footprints by distance, and updates only those whose LOD tier changed. The camera origin is only recomputed once the view center has moved by a small threshold, preventing unnecessary re-styling after tiny movements. A selected building is kept in the detailed tier while its details panel is open.

The LOD budget is a performance heuristic rather than a device benchmark. Tune it after measuring frame rate, memory, and visual quality on target hardware. This is client-side entity LOD; the pilot data is still loaded as GeoJSON and is not yet streamed as tiled city geometry.

## Important data limitations

- A building footprint is not a surveyed 3D model.
- If true height is missing, floor count is converted to an approximate height; if both are missing, a fallback estimate is used.
- Procedural facade textures are stylized placeholders, not real photographs. They do not recover the true window count, balcony layout, floor plan, or architectural details of an individual property.
- Overture building parts can improve shape segmentation when the source data contains them, but coverage is incomplete.

## Second visual pass

- The procedural facade canvas now uses a single approximately 3 m floor tile, so vertical repetition is tied to the estimated building height rather than a multi-floor texture tile.
- Facade patterns continue to distinguish balcony, vertical-glass, urban-grid, and compact styles; window layout and accents vary deterministically per feature.
- Selected detailed buildings may receive a small rooftop water-tank or HVAC-like silhouette based on broad building-use/height hints. These details are illustrative and intentionally sparse; source data does not confirm the real rooftop equipment.
- Roof equipment is only attached within the detailed-facade path, keeping the rest of the city lightweight.

## Building selection and camera focus

- Clicking an Overture building highlights the selected footprint and exposes the source attributes in the details panel.
- The selection event carries both the clicked surface coordinate and a footprint-center focus coordinate when the polygon geometry is available.
- “Focus on building” moves the camera toward the footprint center and adds a clearance based on the rendered height estimate.
- The panel distinguishes source-provided height from a floor-derived estimate or a fallback estimate. Procedural facades and rooftop silhouettes remain visual approximations, not verified property details.

## Next improvements

1. Replace the GeoJSON city pilot with streamed vector/3D Tiles as the coverage and dataset size grow.
2. Add device-capability-aware budgets and benchmark LOD thresholds on low- and mid-range hardware.
3. Support per-property GLB models and verified photogrammetry where high fidelity matters.
4. Add visual regression snapshots and a repeatable local frame-time/memory benchmark.
5. Revisit roof profiles and rooftop equipment only where geometry can remain within a measured entity budget.

## Verification

After pulling the branch, run:

```powershell
npm run lint
npm run build
npm run dev
```

Open `/map`, wait for the Overture pilot layer to finish loading, and inspect buildings around the initial Dhaka camera position. Check the browser console for the `[Overture] Pilot dataset rendered.` message and confirm the detailed facade count is non-zero.
