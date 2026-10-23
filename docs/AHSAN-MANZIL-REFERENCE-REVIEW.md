# Ahsan Manzil dedicated render/reference review

The Ahsan Manzil heritage GLB declares **Y-up, +X east, +Z south/riverside**. Do not use the generic Z-up render profile for this model: it would call the wrong direction "front" and "top". Use `ahsan-manzil-y-up-cycles-cpu-v1`, whose front camera is on the south/+Z side, looks toward -Z, and whose top camera looks toward -Y.

## Rebuild and review

```powershell
npm run build:heritage-model
npm run test:ahsan-manzil-reference-sources
$env:BLENDER_BIN = "blender"
npm run test:ahsan-manzil-review-integration
```

The integration step downloads two CC BY-SA 4.0 Wikimedia Commons images, verifies each source file's pinned SHA-1, computes SHA-256/dimensions, renders all 13 views with Blender CPU Cycles, and creates an evidence-linked reference-review report. The straight-on front photo maps to `front`; the photo titled “Ahsan Manzil Side View” has source coordinates east of the site and maps provisionally to the `right` view because model +X is east. Source heading/lens calibration is not claimed.

The generated artifact `artifacts/ahsan-manzil-review` contains the LOD3 model copy, confidence-tagged parameter JSON, 13 PNG renders, source photographs, attribution, render manifest, review input and hash-linked report. Both reference comparisons deliberately start as `pending`; a correctly linked source/render pair is not itself a visual pass. Open the source and mapped render side by side, enter a reviewer-authored outcome and notes, then regenerate the report with a new output file. Other render views remain unassessed because the pinned reference set does not document those facades.

## Licensing and acceptance boundaries

- Front image: Mahbub Hossain Shaheed (mahosha), “Ahsan Manzil-Front View.jpg”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil-Front_View.jpg), CC BY-SA 4.0.
- Side image: Parvezahmed, “Ahsan Manzil Side View.jpg”, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil_Side_View.jpg), CC BY-SA 4.0.

The integration step verifies the bytes against Commons' published SHA-1 checksums and includes the exact attribution/license in the artifact. It does not silently recategorize an inferred facade or camera position as measured. Geometry/scale/georeference and final human visual review remain separate gates; `publicationEligible` remains false.
