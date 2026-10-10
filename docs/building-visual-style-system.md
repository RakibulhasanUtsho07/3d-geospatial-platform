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

## Performance controls

The initial detailed-facade budget is `MAX_DETAILED_FACADES = 650`. The dataset is still processed in batches, and the camera prioritization means the detail budget is spent near the initial Dhaka view rather than on whichever features happen to appear first in the GeoJSON file. Tune this cap only after checking browser memory, frame rate, and visual quality on the target machine.

## Important data limitations

- A building footprint is not a surveyed 3D model.
- If true height is missing, floor count is converted to an approximate height; if both are missing, a fallback estimate is used.
- Procedural facade textures are stylized placeholders, not real photographs. They do not recover the true window count, balcony layout, floor plan, or architectural details of an individual property.
- Overture building parts can improve shape segmentation when the source data contains them, but coverage is incomplete.

## Next improvements

1. Add explicit LOD tiers based on camera distance and device capability.
2. Add roof profiles and restrained rooftop equipment only when they can be generated without overwhelming entity count.
3. Move dense city geometry to streamed 3D Tiles rather than keeping the entire pilot as one GeoJSON data source.
4. Support per-property GLB models and verified photogrammetry for locations where high fidelity matters.
5. Add visual regression snapshots and a local performance benchmark before increasing the detailed facade budget.

## Verification

After pulling the branch, run:

```powershell
npm run lint
npm run build
npm run dev
```

Open `/map`, wait for the Overture pilot layer to finish loading, and inspect buildings around the initial Dhaka camera position. Check the browser console for the `[Overture] Pilot dataset rendered.` message and confirm the detailed facade count is non-zero.
