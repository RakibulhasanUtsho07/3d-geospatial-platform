# Texture projection evidence review

Run:

```powershell
npm run test:texture-projection-review
npm run review:texture-projection -- ".\\texture-candidate.json" ".\\texture-review.json"
```

Input JSON shape:

- `images`: source image records with unique `id`, SHA-256, positive integer dimensions, and `verifiedSource: true`.
- `cameraCalibrations`: unique calibration records with `status: "verified"` and a measured `reprojectionErrorPx`.
- `faces`: triangles with three vertex IDs, three per-corner normalized UV pairs, a `sourceImageId`, and a `cameraCalibrationId`.

The review rejects UVs outside [0,1], unverified images/calibrations, invalid hashes/dimensions, and reprojection errors above the configured threshold. It only validates existing assignments: it does not estimate cameras, create UVs, bake textures, or synthesize missing pixels. The report always sets `publicationEligible: false`; visual seam and appearance review remain necessary.
