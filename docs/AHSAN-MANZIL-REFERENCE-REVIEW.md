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

The generated artifact `artifacts/ahsan-manzil-review` contains the LOD3 model copy, confidence-tagged parameter JSON, 13 PNG renders, the two pinned source photographs, attribution, render manifest, review input, visual findings and a hash-linked report. CI uploads this folder even if the heritage render step fails, so partial PNGs and manifests remain available to diagnose a failed visual gate. The front photo is mapped to `front`; the southeast-oblique photograph maps provisionally to `turntable-315`. Both comparison outcomes are now recorded as **`mismatch`**, not `match` or `pending`, in `data/heritage/ahsan-manzil-visual-review.json`. The generated report binds each finding to the actual reference-image SHA-256, render-image SHA-256, render-manifest SHA-256 and model SHA-256. The reviewer is explicitly labelled AI-assisted visual triage and independent human sign-off remains pending. The other 11 render views are unassessed because the pinned sources do not document those facades.


A first-pass generated bundle exposed an important technical QA case: the renderer had created valid PNG files whose pixels showed almost only the background. The Y-up profile now frames from the palace-only semantic nodes rather than the entire scene context, uses lights above the palace in Blender Z-up coordinates after glTF import, and CI rejects any of the 13 views if it has near-flat pixel luminance. That technical gate passed, but the subsequent side-by-side visual review still found architectural mismatch.

## Visual review findings — 23 October 2026

**Overall status: `needs-model-or-reference-correction`.** The findings are recorded against the exact renders and source images in the generated report. This is AI-assisted visual triage, not independent heritage-architect sign-off.

| Reference and render | Finding | Required correction |
|---|---|---|
| Straight-on front photograph -> `front.png` | **Mismatch.** The model reads as a very long, low facade. The central dome/pavilion and ceremonial stair are much less visually dominant than in the source; facade opening rhythm and articulated end pavilions are simplified. | Resolve the provisional 125.4 m overall extent versus the 55.8 m working Rangmahal frontage. Verify whether the Andarmahal has been represented as a continuous south-front facade rather than a set-back mass. Recalibrate vertical/width proportions, dome/pavilion, stair and openings from a rectified same-facade source. |
| Southeast-oblique photograph -> `turntable-315.png` | **Mismatch.** The rendered composition has broad, nearly black flat-looking roof planes and simplified side/end articulation compared with the photo's corner pavilion, arches, columns and projections. | Inspect normals/material/light response and roof geometry; refine end pavilion, arched openings, lower-level projections and mass intersections from matching references. The source camera's heading and lens are unknown, so this view mapping remains estimated. |

The machine-readable counterpart is `data/heritage/ahsan-manzil-visual-review.json`. Each finding has notes and a correction request; CI expects both outcomes to remain `mismatch` until a new model is generated and visually reviewed. No image-similarity percentage or measured dimension has been inferred.

## Acceptance state

P1.3's review deliverable is complete because the two best-supported source views were inspected and the mismatches were recorded with traceable image/model/render hashes. **The model itself has not passed architectural fidelity review.** Independent human confirmation is pending, 11 views remain unassessed, and `publicationEligible` must remain false. The follow-up task is P1.4: correct the documented Ahsan Manzil proportions, roof/lighting appearance and facade articulation, then repeat the fixed-view review.

## Licensing and acceptance boundaries

- Front image: Mahbub Hossain Shaheed (mahosha), “Ahsan Manzil-Front View.jpg”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil-Front_View.jpg), CC BY-SA 4.0.
- Side image: Parvezahmed, “Ahsan Manzil Side View.jpg”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil_Side_View.jpg), CC BY-SA 4.0.

The integration step verifies the bytes against Commons' published SHA-1 checksums and includes the exact attribution/license in the artifact. It does not silently recategorize an inferred facade or camera position as measured. Geometry/scale/georeference and final human visual review remain separate gates; `publicationEligible` remains false.
