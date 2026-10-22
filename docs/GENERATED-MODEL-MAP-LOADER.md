# Loading a Generated Building GLB into the 3D Map

The `/map` view now exposes **Generated models** controls that use the existing `MapEngine.addGeneratedModel()` lifecycle. This closes the manual preview gap between a GLB asset and its Cesium map placement. It does not execute the building-generation pipeline in the browser and does not automatically publish candidate assets.

## Workflow

### 1. Generate a candidate

For a BuildingSpec with known footprint and dimensions:

```powershell
npm run test:building-generation
npm run generate:building-model -- .\building-spec.json .\artifacts\my-building.glb
```

For the staged media workflow, follow [Building Generation Engine](BUILDING-GENERATION-ENGINE.md) and the media rights/preflight requirements. The workflow writes a candidate package under `.building-engine/jobs/<buildingId>/<jobId>-workflow/`.

### 2. Review before making the asset available to the browser

Inspect the accompanying report, actual GLB geometry, source provenance, licence/permission status, dimensions, facade/texture quality, and georeferencing evidence. Use the render-review and release-readiness workflow where applicable.

The generated result is a candidate. Do **not** copy an unreviewed model into a public static directory. The loader is not a review or publishing gate, and its presence does not change `mapReady` or `publicationEligible`.

After the asset has passed the applicable independent review, put the approved file under the app's static `public/` directory. For example:

```powershell
New-Item -ItemType Directory -Force .\public\models\generated
Copy-Item .\artifacts\my-building.glb .\public\models\generated\my-building.glb
```

This copy is a deliberate local deployment step; no candidate file is copied automatically by the generator or the map UI.

### 3. Place it on the map

Start the app with `npm run dev` and open [http://localhost:3000/map](http://localhost:3000/map). Select **Generated models**, then enter:

- **Model asset URL:** `/models/generated/my-building.glb`
- **Model ID:** a unique stable identifier such as `old-dhaka-house-01`
- **Longitude / Latitude:** the reviewed WGS84 placement for the model origin
- **Height:** metres relative to the configured Cesium ellipsoid reference, not automatically a surveyed elevation
- **Heading:** the model's verified orientation in degrees
- **Scale:** an explicit multiplier; the loader never infers real dimensions from the GLB

The map engine validates the URL, coordinate ranges, transform angles, scale, and model axes before loading. The default axes are Y-up and Z-forward. If the GLB uses another axis convention, convert the asset or use the lower-level model definition API with the appropriate axis settings.

When the model loads, use **Focus**, **Hide/Show**, and **Remove** to review its placement. If the asset cannot be loaded, check the URL, that the file is actually under `public/`, the browser network/console messages, and that the GLB is valid.

## Current scope and limitations

- The loader displays existing same-origin static assets or explicitly provided HTTPS model URLs. It does not upload a GLB, read arbitrary paths on the workstation, or create model files.
- Loaded-model records exist only for the current map session. They are not saved to a server database or browser storage and are cleared when the map is re-initialized or the page is refreshed.
- Placement depends on the supplied coordinate, heading, height and scale. The loader does not reconstruct architecture, compute ground control, solve vertical datum, or verify dimensions.
- External HTTPS assets must be trusted and reachable by the browser; network policy or cross-origin restrictions may prevent a remote model from loading.
- Successful loading proves that Cesium could load that asset and transform, not that the model is historically/architecturally accurate or ready for public release.

## Verification

Run the existing checks before committing model-generation changes:

```powershell
npm run test:generated-model-policy
npm run test:building-generation
npm run test:media-to-model-workflow
npm run lint
npm run build
```

The generated-model policy tests cover same-origin/HTTPS URL constraints, invalid URL schemes and path traversal, WGS84 bounds, transforms, and model axis validation. CI also exercises the production build and other geospatial/building-generation tests.
