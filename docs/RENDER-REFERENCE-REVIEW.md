# Render-to-reference comparison review

This workflow links the 13 Blender review renders to independently supplied building photographs and records an explicit human decision for each render/reference pair. It does not calculate a similarity score and does not infer that two images depict the same facade.

## 1. Collect reference evidence

Copy or keep the source JPEG/PNG files in a folder next to your review input JSON. Record each image's actual SHA-256 and pixel dimensions. Use the exact file that a reviewer will inspect.

Example input file, `render-reference-review-input.json`:

```json
{
  "schemaVersion": "1.0.0",
  "buildingId": "your-building-id",
  "referenceImages": [
    {
      "id": "ref-front-01",
      "path": "./references/front-photo.jpg",
      "sha256": "replace-with-actual-64-character-sha256",
      "width": 1920,
      "height": 1280,
      "sourceDescription": "Front facade photograph from an independently recorded reference set",
      "sourceUrl": null,
      "attribution": "Record the required credit or attribution",
      "rightsStatus": "pending",
      "facadeLabel": "front",
      "captureHeadingDegrees": null,
      "captureHeadingBasis": "unknown"
    }
  ],
  "comparisons": [
    {
      "viewId": "front",
      "referenceImageId": "ref-front-01",
      "comparisonBasis": "same-facade-known",
      "outcome": "pending",
      "reviewer": "",
      "reviewedAt": "",
      "notes": ""
    }
  ]
}
```

`path` is resolved relative to the JSON file. Use only `same-facade-known` if the facade identity is genuinely known; `pose-estimated` when camera pose is only estimated; `context-only` or `not-comparable` when the image cannot support a direct facade check. The CLI independently hashes every JPEG/PNG file and verifies its dimensions against the declared values. Replace all placeholder values with actual metadata before running it.

Allowed outcomes are `pending`, `match`, `partial`, `mismatch`, and `not-comparable`. For a completed assessment, enter a reviewer identifier, a UTC ISO timestamp (for example `2026-10-21T14:30:00Z`), and notes that explain the judgment. Add `correctionRequest` when a model correction is required. A `match` outcome requires a known-facade or estimated-pose comparison basis; context-only evidence cannot be recorded as a match.

## 2. Run the review

```powershell
npm run test:render-reference-review
npm run review:render-references -- ".\\building-review" ".\\render-reference-review-input.json" ".\\render-reference-review-report.json"
```

The render directory must contain the `render-review-manifest.json` and generated PNGs. The review input JSON contains reference file paths relative to its own folder. The report output must be a new file; existing reports are not overwritten.

## 3. Interpret the report

- `pending-human-review`: at least one review is pending or some render views have no reference comparison.
- `needs-model-or-reference-correction`: a reviewer reports a partial or mismatched facade/feature.
- `review-complete-with-unresolved-comparisons`: the recorded review includes comparisons that cannot support a direct check.
- `reviewer-reported-matches`: each rendered view has at least one completed, reviewer-reported match and none is pending/partial/mismatched/not-comparable.

The final status only summarizes the entered assessment. It does not prove accuracy independently. Reports include model/render/reference hashes so reviewers can identify exactly which versions were compared. A reference whose rights are pending/unknown, facade is unknown, or camera heading is unverified creates warnings. Rights and camera metadata are user-declared and are not independently certified.

`publicationEligible` remains false for every status. Do not convert a manual report into a geometric accuracy score; corrections still require editing the mesh/UV/model using reviewed evidence and rerunning QA and render checks.
