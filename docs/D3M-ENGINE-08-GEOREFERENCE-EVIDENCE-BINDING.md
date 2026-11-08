# D3M-ENGINE-08 — Single-image georeference evidence binding

**Tracking issue:** [#357](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/357)  
**Branch:** `feat/d3m-engine08-georeference-evidence-binding-20261104`  
**Base:** D3M-ENGINE-07 PR [#356](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/356)  
**Smoke report schema:** `1.5.0`  
**Generation-artifact receipt schema:** `1.1.0`

## Why this increment exists

The media-to-model workflow already supported optional horizontal ground-control registration using `registerModelToWgs84`. The single-image runtime smoke did not expose that option, and the D3M-ENGINE-07 artifact receipt did not include a separately re-verified binding to the control-point input and computed registration.

This increment reuses the existing registration implementation. It does not create a second projection or transform algorithm.

## Control-point manifest contract

Provide a workspace-relative JSON manifest through `--control-point-manifest`. The manifest is bound to a single building and the exact selected image's source ID and SHA-256. It must use horizontal EPSG:4326/WGS84 and declare the vertical datum as not provided. The survey section records method, reference, observation timestamp and declared horizontal accuracy. Each of 3–100 control points carries an ID, model X/Z coordinates, longitude, latitude and `evidenceSourceId` equal to the selected source ID.

Example shape (illustrative schema only; replace every placeholder with independently observed values before use):

```json
{
  "schemaVersion": "1.0.0",
  "kind": "single-image-control-point-manifest",
  "buildingId": "your-building-id",
  "source": {
    "sourceId": "your-source-id",
    "sha256": "replace-with-the-64-character-source-image-sha256"
  },
  "horizontalCrs": "EPSG:4326",
  "horizontalDatum": "WGS84",
  "verticalDatum": "not-provided",
  "survey": {
    "method": "RTK GNSS",
    "reference": "your-survey-record-id",
    "observedAtUtc": "2026-11-04T10:00:00.000Z",
    "horizontalAccuracyM": 0.03
  },
  "controlPoints": [
    {
      "id": "gcp-1",
      "modelX": 0,
      "modelZ": 0,
      "longitude": 90.4,
      "latitude": 23.7,
      "evidenceSourceId": "your-source-id"
    }
  ]
}
```

The example shows only one point to keep the structure readable; the actual manifest must contain at least three unique, non-collinear points. Do not copy the example coordinates as real measurements.

The smoke reads and hashes the manifest before inference, passes the normalized control points and configured residual thresholds into the existing workflow, then re-reads the same manifest after model generation. A changed file or source/building mismatch blocks the successful smoke result.

## CLI

Optional arguments:

```bash
--control-point-manifest survey/control-points.json
--max-gcp-rms-error-m 0.5
--max-gcp-residual-m 1
```

The resulting georeference evidence records the exact GLB SHA-256, manifest byte count/hash, survey metadata, thresholds and the full horizontal registration result. The write-once receipt binds this evidence. The independent verifier re-reads and hashes the manifest, recomputes registration using the same existing transform implementation, and compares the result with both the workflow report and artifact receipt.

Without a manifest, schema 1.5.0 records georeference status `not-requested`. Legacy smoke schemas 1.0.0–1.4.0 and receipt schema 1.0.0 remain supported and are not backfilled.

## Boundaries and trust limits

- Control points and survey metadata are operator-supplied. This code does not authenticate the surveyor, GNSS receiver, survey record or stated accuracy.
- A low residual does not prove that model X/Z points identify the correct physical features in the image or GLB.
- Registration is horizontal only. Vertical datum remains `not-solved`; a horizontal transform is not a complete georeference.
- The result remains human-review-only. It must not enable `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` or `automaticApproval`.
- CI fixtures are synthetic and do not prove real worker inference, surveyed building truth, metric accuracy or Cesium alignment.
