# Building Selection Material Controller

## Purpose

Own the original Cesium material snapshots used by selected-building highlighting, keeping material restore/highlight behavior out of `CesiumAdapter`.

## Responsibilities moved

- Keep the original polygon material snapshot for the selected entity.
- Apply the cyan roof highlight only for the currently selected entity, and only once until the saved snapshot is restored.
- Restore original materials before the selected building transitions between detailed and lightweight LOD.
- Clear saved snapshots after restore so a highlight cannot become the next transition's baseline.

## Responsibilities retained by CesiumAdapter

- Selected entity identity and feature-picking behavior.
- Preview and saved-style lifecycle.
- Choosing the building LOD and requesting a render.
- Layer visibility, viewport fetching/staging and map event subscription.

## Verification

Run `npm run test:building-selection-materials`. CI also runs the existing LOD policy, renderer boundary, style assignment policy, browser/API integration and production build checks.

This is a responsibility extraction; no FPS improvement is claimed.
