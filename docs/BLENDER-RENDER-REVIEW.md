# Multi-view Blender render review

This stage renders a reviewed GLB to a repeatable set of inspection images. Imported mesh names beginning with Site_ are hidden only during these renders, so large contextual ground/river planes and nearby illustrative buildings do not shrink the palace in the review frame. Those nodes remain in the source GLB and are not deleted or modified. It creates five orthographic views (`front`, `back`, `left`, `right`, `top`) plus eight orthographic turntable views at 45-degree intervals. Because a GLB does not intrinsically label the real-world front facade or true north, the view names are Blender-world axes after import, not verified architectural directions.

## Prerequisites

Install Blender with the glTF 2.0 import/export support enabled, and make its command-line executable available on PATH. On Windows, if the executable is not in PATH, pass its full path using `--blender=`. This command uses Blender in background mode; it does not need the Blender GUI.

## Render a model

```powershell
npm run test:render-review-manifest
npm run render:building-review -- ".\\building.glb" ".\\building-review" --resolution=1024
```

Use a new output directory that does not already exist. Resolution must be a power of two from 256 through 2048. The tool will not overwrite an existing review directory.

The output directory contains 13 PNG images and `render-review-manifest.json`. The manifest records the source GLB SHA-256, renderer version, imported-model bounds, image dimensions, each render SHA-256, sampled luminance statistics, warnings, texture-binding QA summary, and a human-review checklist. The image statistics only identify basic risks such as nearly uniform or mostly transparent renders; they are not image similarity scores.

## Human review

Open the generated views alongside source photos and check silhouette/proportions, facade orientation, windows/doors/columns/roof, UV alignment/seams, image sharpness, lighting, and any hidden or unobserved surfaces. Mark each checklist item only after that visual inspection. This automation does not infer the real-world front, georeference the building, correct geometry, bake new textures, or certify a match to source photographs. `publicationEligible` stays false.

If Blender is missing or exits unsuccessfully, the command reports the error and preserves partial outputs for diagnosis. The GLB is not modified.
