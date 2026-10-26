# Multi-view Blender render review

This stage renders a reviewed GLB into a repeatable 13-image inspection set. The renderer is **building-agnostic by default**: it uses the bounds of the imported renderable mesh set, renders the complete model from five canonical orthographic directions and eight turntable directions, and does not require any building-specific node names. The GLB is never modified by rendering.

## Generic default and explicit review profiles

The default profile ID is `generic-whole-model-v1`. It does not exclude mesh nodes or focus on a named subset. The front-view horizontal direction uses the GLB `extras.building.frontFacingAzimuthDegrees` value when present; otherwise the renderer uses a deterministic legacy direction. Neither mode independently verifies geographic orientation.

Some authored scenes include contextual ground/water planes or need a more closely framed architectural detail. Use an explicit, versioned JSON review profile rather than adding building names to the generic renderer. For example, the repository includes `data/heritage/rangmahal-render-review-profile.json`, which preserves a Rangmahal facade-detail view without putting Rangmahal node names in the renderer implementation.

A profile has schema version `1.0.0` and fields:
- `profileId`: stable profile identifier.
- `excludeNodeNamePrefixes`: optional exact prefixes excluded from all review views, e.g. context-only scene nodes.
- `frontView.includeNodeNames`: optional exact node names to isolate for the front-detail view. Empty means all globally included meshes.
- `frontView.excludeNodeNames`: exact names hidden from the front-detail view only.
- `frontView.elevationDegrees`: front camera elevation from 0 to 60 degrees.
- `frontView.framingLabel`: short label written to each view record.

Unknown fields, wildcards, duplicate selectors, invalid elevation and missing requested front nodes are rejected. The Node preflight and Blender script both validate the profile; the raw/final manifest records profile ID, SHA-256, exclusion counts and front-view framing. Profiles control review framing only: they do not repair geometry or certify accuracy.

## Prerequisites

Install Blender with glTF 2.0 import/export support and make its command-line executable available on PATH. On Windows, when Blender is not on PATH, pass its full path using `--blender=`. The command uses Blender in background mode and does not require the GUI.

## Render a model

Generic all-mesh review:

```powershell
npm run test:render-review-manifest
npm run render:building-review -- ".\\building.glb" ".\\building-review" --resolution=1024
```

Use an explicit scene-specific profile only when the model contains contextual geometry or requires a documented facade focus:

```powershell
npm run render:building-review -- ".\\rangmahal.glb" ".\\rangmahal-review" --review-profile=data/heritage/rangmahal-render-review-profile.json
```

Use a new output directory that does not already exist. Resolution must be a power of two from 256 through 2048. The renderer will not overwrite an existing review directory. A source-camera render can also be requested, but the source image, camera, calibration evidence and frame-alignment evidence must be supplied together; only a validated pair is rendered as comparable.

## Outputs and interpretation

The output directory contains 13 PNG images and `render-review-manifest.json`. The manifest records the source GLB SHA-256, renderer version, imported-model bounds, image dimensions, every render SHA-256, sampled luminance statistics, the selected review-profile ID/hash, facade-axis source, warnings, texture-binding QA summary and a human-review checklist. Source-camera diagnostics are saved separately to `source-camera-render-manifest.json`.

The image statistics only detect basic risks such as nearly uniform or mostly transparent frames; they are not image similarity scores. A synthetic source-camera fixture is not a real-building comparison. Camera match, source identity, metric scale, georeferencing and architectural correctness need independent evidence.

## Human review

Inspect the generated views alongside licensed source photos and check silhouette/proportions, facade orientation, floor count, windows/doors/columns/roof details, UV alignment/seams, image sharpness, lighting, and hidden or unobserved surfaces. Mark checklist items only after that inspection. The automation does not infer unseen geometry, correct the GLB, create texture maps, or certify a percentage match to the real building. `publicationEligible` remains false.

If Blender is missing or exits unsuccessfully, the command reports the error and preserves partial outputs for diagnosis. Incomplete or stale renders must not be accepted as a completed review set.
