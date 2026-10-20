# Generated Model Layer

Status: first-stage implementation foundation; not yet connected to Admin authoring or durable storage.

## Purpose

Expose a generic Cesium model-layer contract so generated building assets can be added to the existing `/map` without adding a separate viewer or hard-coding every building in the heritage-model loader.

## Public contract

- `addGeneratedModel(definition)`: validates the asset URL, ID, coordinate, heading/pitch/roll, scale and axis orientation; loads GLB before exposing it in the map.
- `updateGeneratedModel(id, patch)`: applies transform/visibility changes in place; if the asset URL changes, loads the replacement first and keeps the current model if replacement fails.
- `setGeneratedModelVisibility(id, visible)`: toggles one model and requests a Cesium render.
- `removeGeneratedModel(id)`: removes model and invalidates any pending load for that ID.
- `getGeneratedModelIds()`: lists IDs currently managed by this adapter instance.

## Limitations in this phase

- Model definitions are currently in-memory only. They do not survive a page reload.
- This layer is not authorization; Admin-only API policies must be enforced by the server when the editor is built.
- Draft/published lifecycle, database records, asset storage, job queue, preview UI and rollback are not part of this commit.
- URLs are restricted to same-origin absolute paths or HTTPS URLs without embedded credentials. Keep private generated asset URLs behind the future authorized API/storage layer.

## Local verification

```powershell
npm install
npm run test:generated-model-policy
npm run lint
npm run build
```

After the build passes, manually load a small, known-dimension GLB in `/map`, check ground placement, rotation and scale, and verify the existing Overture and Ahsan Manzil layers still function.

## Suggested first integration

Use a temporary Admin-only development action only after authentication is verified. Feed a server-selected test asset into the layer; do not expose arbitrary user-controlled model URLs. The first milestone is a correct, repeatable GLB placement—not a complete AI architecture generator.
