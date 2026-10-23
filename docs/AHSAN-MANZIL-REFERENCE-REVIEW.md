# Ahsan Manzil dedicated render/reference review

The Ahsan Manzil source GLB declares **Y-up, +X east, +Z south/riverside**. Blender's glTF importer converts the source Y-up frame into Blender's **Z-up world** before rendering; source +Z/south becomes Blender world -Y. Use `ahsan-manzil-y-up-cycles-cpu-v1`: the front camera stands at Blender -Y and looks toward +Y, the top camera stands above the model at Blender +Z and looks toward -Z, and the east-side camera stands at +X and looks toward -X. The render manifest records both the selected profile and this post-import camera coordinate convention.

## Rebuild and review

```powershell
npm run build:heritage-model
npm run test:ahsan-manzil-reference-sources
$env:BLENDER_BIN = "blender"
npm run test:ahsan-manzil-review-integration
```

The integration step downloads two CC BY-SA 4.0 Wikimedia Commons images, verifies each source file's pinned SHA-1, computes SHA-256/dimensions, renders 13 views at 512x512 with Blender CPU Cycles, and creates an evidence-linked reference-review report. For framing, it uses only the named palace meshes (Plinth through Andarmahal). Site/context meshes that can occlude architectural details (trees, river, site blocks, pond, mosque, stable and path) are hidden from the review render; the model file is not modified. CI fails if the palace bounds exceed the expected range, the excluded-object list differs, or any view is effectively a flat background image. The straight-on front photo maps to `front`. The photo titled “Ahsan Manzil Side View” records a camera point southeast of the approximate site anchor; it maps provisionally to `turntable-315`, the nearest fixed 45-degree southeast camera. The site anchor is [C] and source heading/lens calibration is not published, so the mapping is estimated rather than measured.

The generated artifact `artifacts/ahsan-manzil-review` contains the LOD3 model copy, confidence-tagged parameter JSON, 13 PNG renders, source photographs, attribution, render manifest, review input and hash-linked report. CI uploads this folder even if the heritage render step fails, so partial PNGs and manifests remain available to diagnose a failed visual gate. The render-reference report maps the front photo to `front` and the southeast source photo to `turntable-315`; comparison outcomes are still `pending` until visual findings are recorded. Both reference comparisons deliberately start as `pending`; a correctly linked source/render pair is not itself a visual pass. Open the source and mapped render side by side, enter a reviewer-authored outcome and notes, then regenerate the report with a new output file. Other render views remain unassessed because the pinned reference set does not document those facades.


A first-pass generated bundle exposed an important visual QA case: a command can produce valid PNG files whose pixels show almost only the background. The Y-up profile therefore frames from the palace-only semantic nodes rather than the entire scene context; its lights are placed above the building in Y-up coordinates; CI rejects render sets where any of the 13 views has near-flat pixel luminance. Always open the latest artifact and compare it with the reference images—the automated contrast check is only a technical gate, not architectural acceptance.

## Licensing and acceptance boundaries

- Front image: Mahbub Hossain Shaheed (mahosha), “Ahsan Manzil-Front View.jpg”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil-Front_View.jpg), CC BY-SA 4.0.
- Side image: Parvezahmed, “Ahsan Manzil Side View.jpg”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil_Side_View.jpg), CC BY-SA 4.0.

The integration step verifies the bytes against Commons' published SHA-1 checksums and includes the exact attribution/license in the artifact. It does not silently recategorize an inferred facade or camera position as measured. Geometry/scale/georeference and final human visual review remain separate gates; `publicationEligible` remains false.
