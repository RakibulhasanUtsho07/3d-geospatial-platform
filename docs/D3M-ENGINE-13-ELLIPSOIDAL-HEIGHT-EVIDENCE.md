# D3M-ENGINE-13 — Ellipsoidal vertical control evidence

## Purpose

This increment extends the D3M-08 horizontal control-point manifest with optional, source-bound vertical control observations for one exact single-image GLB candidate. It reports a vertical translation using surveyed WGS 84 **ellipsoidal** heights only. It does not convert orthometric, mean-sea-level, geoid or above-ground heights.

The vertical fit reuses the existing horizontal `registration.transform.metresPerModelUnit` value exactly. No independent Y-axis scale, vertical stretch, terrain-derived zero, floor-height fallback or fitted vertical scale is permitted.

## Manifest version 1.1.0

A manifest without the `vertical` section remains schema `1.0.0` and means no vertical calibration was requested. A manifest with vertical observations must be schema `1.1.0`, use top-level `verticalDatum: "EPSG:4979-ellipsoidal"`, and include the complete `vertical` object.

Required vertical declarations:

- `crs`: `EPSG:4979` (WGS 84 3D).
- `heightType`: `ellipsoidal`.
- `unit`: `metre`.
- `referenceFrame`: named realization, e.g. `WGS 84 (G2139)`.
- `coordinateEpoch`: decimal year, 1980 through 2100.
- `survey`: method, reference, canonical UTC observation timestamp and declared vertical accuracy in metres.
- `controlPoints`: exactly one entry for every horizontal control ID. Each contains the same `horizontalControlPointId`, exact candidate GLB `modelY`, surveyed `ellipsoidalHeightM` and the selected source's `evidenceSourceId`.

The horizontal controls must still provide at least three unique non-collinear X/Z controls. Vertical control IDs must exactly equal the horizontal ID set; duplicate, missing, substituted or unknown IDs are rejected. Vertical observations must span at least 1 metre after applying the horizontal scale.

Example vertical portion (the horizontal control points and the binding fields are still required):

```json
{
  "schemaVersion": "1.1.0",
  "kind": "single-image-control-point-manifest",
  "buildingId": "demo-building",
  "source": {
    "sourceId": "facade-photo",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "horizontalCrs": "EPSG:4326",
  "horizontalDatum": "WGS84",
  "verticalDatum": "EPSG:4979-ellipsoidal",
  "survey": {
    "method": "RTK GNSS",
    "reference": "survey-session-2026-11-04",
    "observedAtUtc": "2026-11-04T10:00:00.000Z",
    "horizontalAccuracyM": 0.03
  },
  "controlPoints": [
    { "id": "gcp-1", "modelX": -10, "modelZ": -8, "longitude": 90.4, "latitude": 23.7, "evidenceSourceId": "facade-photo" },
    { "id": "gcp-2", "modelX": 10, "modelZ": -8, "longitude": 90.4002, "latitude": 23.7, "evidenceSourceId": "facade-photo" },
    { "id": "gcp-3", "modelX": 10, "modelZ": 8, "longitude": 90.4002, "latitude": 23.7002, "evidenceSourceId": "facade-photo" }
  ],
  "vertical": {
    "crs": "EPSG:4979",
    "heightType": "ellipsoidal",
    "unit": "metre",
    "referenceFrame": "WGS 84 (G2139)",
    "coordinateEpoch": 2022.25,
    "survey": {
      "method": "RTK GNSS ellipsoidal-height observation",
      "reference": "vertical-session-2026-11-04",
      "observedAtUtc": "2026-11-04T10:30:00.000Z",
      "verticalAccuracyM": 0.04
    },
    "controlPoints": [
      { "horizontalControlPointId": "gcp-1", "modelY": 0, "ellipsoidalHeightM": 135, "evidenceSourceId": "facade-photo" },
      { "horizontalControlPointId": "gcp-2", "modelY": 1.5, "ellipsoidalHeightM": 138.75, "evidenceSourceId": "facade-photo" },
      { "horizontalControlPointId": "gcp-3", "modelY": 3, "ellipsoidalHeightM": 142.5, "evidenceSourceId": "facade-photo" }
    ]
  }
}
```

The sample coordinates are illustrative, not a real survey. Replace them only with observations supported by the survey record. The reference frame and epoch must describe the supplied coordinate solution, not a convenient default.

## Calculation and acceptance

Let `s` be the already-computed horizontal metres-per-model-unit value, `y_i` each control's GLB Y coordinate, and `h_i` the surveyed ellipsoidal height:

```text
heightOffsetM = mean(h_i - s * y_i)
predictedHeight_i = heightOffsetM + s * y_i
residual_i = predictedHeight_i - h_i
RMS = sqrt(mean(residual_i ^ 2))
maxResidual = max(abs(residual_i))
```

Default limits are 0.5 m RMS and 1.0 m maximum residual. Configure them with:

```bash
--max-vertical-gcp-rms-error-m 0.5
--max-vertical-gcp-residual-m 1
```

A threshold failure marks the smoke failed and leaves the candidate unpublished. Vertical evidence records the exact horizontal scale, manifest and GLB hashes, frame, epoch, per-point residuals and limits. The offline byte verifier re-parses the exact packaged manifest and independently recomputes the fit.

## Evidence chain and versions

- Control-point manifest: schema 1.1.0 when vertical observations are present; legacy horizontal-only schema 1.0.0 remains supported.
- Single-image smoke: schema 1.6.0.
- Generation artifact receipt: schema 1.2.0.
- Georeference evidence: schema 1.1.0 only when vertical calibration was supplied; legacy schema 1.0.0 remains verifiable.
- Final review-package metadata carries the canonical vertical-evidence digest and summary alongside the original smoke/receipt/workflow/manifest files. The package verifier recomputes the fit using those exact manifest bytes.

## Trust boundary

The implementation verifies internal consistency, hashes, coordinate declarations, ID cross-binding and residual arithmetic. It does **not** authenticate the surveyor, GNSS receiver, field book, control-point observation or model-feature correspondence. It cannot prove that the supplied `modelY` is the same physical feature that was measured.

EPSG:4979 ellipsoidal height is not orthometric height above mean sea level. There is no geoid model, vertical grid or coordinate operation in this increment. A future conversion needs a separately identified, licensed, hash-pinned and independently reviewed geoid/vertical operation and control evidence.

All statuses remain human-review-only. Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false. A passing synthetic fixture proves only deterministic software behavior, never a real survey, actual TripoSR inference or building accuracy.
