# Ahsan Manzil dedicated render/reference review

The Ahsan Manzil source GLB declares **Y-up, +X east, +Z south/riverside**. Blender's glTF importer converts the source Y-up frame into Blender's **Z-up world** before rendering; source +Z/south becomes Blender world -Y. Use `ahsan-manzil-y-up-cycles-cpu-v1`: the front camera stands at Blender -Y and looks toward +Y, the top camera stands above the model at Blender +Z and looks toward -Z, and the east-side camera stands at +X and looks toward -X. The render manifest records both the selected profile and this post-import camera coordinate convention.

## Rebuild and review

```powershell
npm run build:heritage-model
npm run test:ahsan-manzil-reference-sources
$env:BLENDER_BIN = "blender"
npm run test:ahsan-manzil-review-integration
```

The integration step downloads two CC BY-SA 4.0 Wikimedia Commons images, verifies each source file's pinned SHA-1, computes SHA-256/dimensions, renders 13 views at 512x512 with Blender CPU Cycles. The heritage profile uses 64 CPU samples with OpenImageDenoise; the generic geometry-QA profile remains at 16 samples with denoising off. Both recipes are pinned in the render manifest/config hash. The step creates an evidence-linked reference-review report. For framing, it uses only the named palace meshes (Plinth through Andarmahal). Site/context meshes that can occlude architectural details (trees, river, site blocks, pond, mosque, stable and path) are hidden from the review render; the model file is not modified. CI fails if the palace bounds exceed the expected range, the excluded-object list differs, or any view is effectively a flat background image. The straight-on front photo maps to `front`. The photo titled “Ahsan Manzil Side View” records a camera point southeast of the approximate site anchor; it maps provisionally to `turntable-315`, the nearest fixed 45-degree southeast camera. The site anchor is [C] and source heading/lens calibration is not published, so the mapping is estimated rather than measured.

The generated artifact `artifacts/ahsan-manzil-review` contains the LOD3 model copy, confidence-tagged parameter JSON, 13 PNG renders, the two pinned source photographs, attribution, render manifest, review input, visual findings and a hash-linked report. CI uploads this folder even if the heritage render step fails, so partial PNGs and manifests remain available to diagnose a failed visual gate. The P1.3 baseline comparison mapped the front photo to `front` and the southeast-oblique photo to `turntable-315`; both were recorded as mismatches against model hash `220612219c008a46e3a2da18c3fe4100be85cb8df64a2a897abda3b192368f1f`. Those prior findings are preserved in `data/heritage/ahsan-manzil-visual-review-p1-3-baseline.json`; they are not reused as the verdict for a corrected P1.4 candidate. The new candidate starts with pending comparison outcomes and receives fresh model, manifest, render and reference hashes.


A first-pass generated bundle exposed an important technical QA case: the renderer had created valid PNG files whose pixels showed almost only the background. The Y-up profile now frames from the palace-only semantic nodes rather than the entire scene context, uses lights above the palace in Blender Z-up coordinates after glTF import, and CI rejects any of the 13 views if it has near-flat pixel luminance. That technical gate passed, but the subsequent side-by-side visual review still found architectural mismatch.

## Visual review findings — 23 October 2026

**Overall status: `needs-model-or-reference-correction`.** The findings are recorded against the exact renders and source images in the generated report. This is AI-assisted visual triage, not independent heritage-architect sign-off.

| Reference and render | Finding | Required correction |
|---|---|---|
| Straight-on front photograph -> `front.png` | **Mismatch.** The model reads as a very long, low facade. The central dome/pavilion and ceremonial stair are much less visually dominant than in the source; facade opening rhythm and articulated end pavilions are simplified. | Resolve the provisional 125.4 m overall extent versus the 55.8 m working Rangmahal frontage. Verify whether the Andarmahal has been represented as a continuous south-front facade rather than a set-back mass. Recalibrate vertical/width proportions, dome/pavilion, stair and openings from a rectified same-facade source. |
| Southeast-oblique photograph -> `turntable-315.png` | **Mismatch.** The rendered composition has broad, nearly black flat-looking roof planes and simplified side/end articulation compared with the photo's corner pavilion, arches, columns and projections. | Inspect normals/material/light response and roof geometry; refine end pavilion, arched openings, lower-level projections and mass intersections from matching references. The source camera's heading and lens are unknown, so this view mapping remains estimated. |

The machine-readable P1.3 baseline is `data/heritage/ahsan-manzil-visual-review-p1-3-baseline.json`. It keeps the original two findings and their original hashes immutable. No image-similarity percentage or measured dimension was inferred from the old render.

## P1.4 candidate corrections

The P1.3 render showed the whole palace footprint in the front comparison, although the straight-on source image is specifically the dome-bearing Rangmahal frontage. The two reference-paired views now use the nine named Rangmahal/portico/stair/dome meshes for framing; the other eleven fixed views continue to show the whole palace. This is a camera-comparison correction, not a physical change to the uncertain overall footprint.

The roof deck boxes previously overlapped the upper-floor slabs and had coplanar top faces. They are now emitted as an 8 cm roof finish above the slab, with a GLB vertex-color/normal regression test. The render harness scales its area-light placement, power and size from building height rather than the long footprint.

The central composition also received three targeted, confidence-tagged [E] changes estimated from the pinned straight-on photograph: the three-arch portico width is now 12.0 m (about 21.5% of the provisional frontage), the octagonal drum is 11.0 m wide (about 20%), and the stair top narrows to 11.5 m while its 16.5 m base is retained. The 27.13 m dome peak remains the published [V] value. These are photo-proportion working estimates, not calibrated measurements; no physical dimension is upgraded to [V]. Regression tests inspect the generated GLB extents for the drum and stair as well as the roof-finish surface.

**Dimension conflict deliberately unresolved:** [Bangladesh Tourism Board](https://beautifulbangladesh.gov.bd/loc/dhaka/3) reports an overall 125.4 m × 28.75 m structure, while [The Daily Star's architectural article](https://www.thedailystar.net/slow-reads/focus/news/palace-the-river-ahsan-manzil-1598293) describes a 183 ft (55.8 m) river-facing span. Without a footprint trace or rectified plan, P1.4 does not silently shrink or rescale the physical model. It focuses the two reference cameras on the documented Rangmahal facade and records the dimensional conflict as unresolved.

The new candidate's comparisons remain pending until its actual PNGs are inspected. The previous mismatch labels must not be copied to a new model hash without review.

## Acceptance state

P1.3's review deliverable is complete because the two best-supported source views were inspected and the mismatches were recorded with traceable image/model/render hashes. **The model itself has not passed architectural fidelity review.** Independent human confirmation is pending, 11 views remain unassessed, and `publicationEligible` must remain false. The follow-up task is P1.4: correct the documented Ahsan Manzil proportions, roof/lighting appearance and facade articulation, then repeat the fixed-view review.

## Licensing and acceptance boundaries

- Front image: Mahbub Hossain Shaheed (mahosha), “Ahsan Manzil-Front View.jpg”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil-Front_View.jpg), CC BY-SA 4.0.
- Side image: Parvezahmed, “Ahsan Manzil Side View.jpg”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil_Side_View.jpg), CC BY-SA 4.0.

The integration step verifies the bytes against Commons' published SHA-1 checksums and includes the exact attribution/license in the artifact. It does not silently recategorize an inferred facade or camera position as measured. Geometry/scale/georeference and final human visual review remain separate gates; `publicationEligible` remains false.
