# Building selection lifecycle regression checks

The selection material controller owns temporary highlight snapshots only. `CesiumAdapter` remains the source of truth for the selected entity and must restore temporary material state before selection, preview geometry, style baseline, or viewport data-source ownership changes.

## Verified lifecycle contracts

- A repeated highlight for the same entity must retain the first unhighlighted polygon material rather than snapshotting the cyan highlight.
- Clearing a selection restores the snapshot and is safe to call again.
- If an unexpected selection change reaches the controller before the normal adapter restore path, the previous snapshot owner is restored before the new entity is highlighted.
- Before selected-building LOD geometry is replaced, the original polygon material is restored and the snapshot is cleared; the next LOD can capture its own base material.
- The facade wall is not highlighted, so a wall's researched texture/material is not overwritten by selection tint.
- Preview reset restores the current selection before cached polygon/wall geometry is invalidated, then reapplies selection highlighting after the new representation is rendered.
- Viewport data-source replacement restores and clears the selected feature before the previous data source is removed.
- The controller must not fetch data, select LODs, control camera/layers, or request renders.

Run `npm run test:building-selection-materials` for executable controller behavior tests and adapter lifecycle-order regression checks.
