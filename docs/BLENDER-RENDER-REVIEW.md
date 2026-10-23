# Multi-view Blender render review

This stage renders a reviewed GLB to a repeatable set of inspection images. It creates five orthographic views (`front`, `back`, `left`, `right`, `top`) plus eight orthographic turntable views at 45-degree intervals. Because a GLB does not intrinsically label the real-world front facade or true north, the view names are Blender-world axes after import, not verified architectural directions.

## Prerequisites

Install Blender with the glTF 2.0 import/export support enabled, and make its command-line executable available on PATH. On Windows, if the executable is not in PATH, pass its full path using `--blender=`. This command uses Blender in background mode; it does not need the Blender GUI.

## Render a model

```powershell
npm run test:render-review-manifest
npm run render:building-review -- ".\\building.glb" ".\\building-review" --resolution=1024
```

Run the end-to-end integration check on a machine with Blender installed:

```powershell
$env:BLENDER_BIN = "blender"
npm run test:render-review-integration
```

The integration check creates a synthetic BuildingSpec GLB, invokes the headless Blender CLI, and verifies the source model hash, all 13 real PNG outputs, their dimensions and SHA-256 hashes, the fixed-camera manifest, and `renderConfigSha256`. CI installs Blender and runs this integration check; a Python syntax check alone is not considered proof that rendering works.

Use a new output directory that does not already exist. Resolution must be a power of two from 256 through 2048. The tool will not overwrite an existing review directory.

Before creating the output directory or launching Blender, the command runs structural GLB geometry/topology QA. Malformed buffers, accessors, vertex coordinates or triangle indices cause the command to fail closed; topology warnings remain review findings rather than automatic rejection of legitimate separate architectural parts.

The output directory contains 13 PNG images and `render-review-manifest.json`. The manifest records the source GLB SHA-256, geometry-QA summary, renderer version, imported-model bounds, output-image hashes, sampled luminance statistics, texture-binding QA summary, fixed camera poses, declared render settings and a human-review checklist. The validator checks that each named view actually has the expected Blender-world viewing direction, including all eight turntable angles. `renderConfigSha256` fingerprints the renderer version/profile, camera poses and settings; each PNG has its own SHA-256. This makes the declared render recipe auditable, but does not guarantee pixel-identical output across different Blender builds or hardware. Image statistics only identify basic technical risks such as nearly uniform or mostly transparent renders; they are not image similarity scores.

## Human review

Open the generated views alongside source photos and check silhouette/proportions, facade orientation, windows/doors/columns/roof, UV alignment/seams, image sharpness, lighting, and any hidden or unobserved surfaces. Mark each checklist item only after that visual inspection. This automation does not infer the real-world front, georeference the building, correct geometry, bake new textures, or certify a match to source photographs. `publicationEligible` stays false.

If Blender is missing or exits unsuccessfully, the command reports the error and preserves partial outputs for diagnosis. The GLB is not modified.
