# BRF-08 — Whole-building holdout integrity and reporting

**Status:** First scoped implementation slice; BRF-08 remains in progress.  
**Branch:** `feat/brf-08-independent-truth-evaluator`  
**Purpose:** prevent segmentation evaluation leakage when multiple photos or capture sessions depict the same physical building.

## What changed

The segmentation benchmark manifest now requires a stable, safe `buildingGroupId` for each sample. All records that refer to the same physical building must keep the same ID and remain entirely within one split. The validator rejects a building that appears in both `development` and `held-out-evaluation`, even when its views came from different capture groups. Existing capture-group split protection remains in place.

The report now includes total and held-out building counts, reports the ordinary per-image mean alongside an equal-weight per-building mean for macro foreground IoU, and lists held-out predictions that are missing or failed evaluation. This prevents buildings with many photographs from automatically dominating the building-level summary and makes missing held-out results visible.

The existing source, label-mask and prediction-mask file-integrity checks remain in the CLI. The benchmark continues to force `acceptanceEligible: false` and requires human review.

## Required manifest update

Each sample must now carry a stable `buildingGroupId`, such as a project-governed ID for one physical building. The same building ID must be reused for every camera angle, capture date and photo sequence of that building. Do not generate IDs from sample filenames or capture session IDs, because doing so can hide split leakage.

Example (illustrative only):

```json
{
  "sampleId": "site-a-front-01",
  "buildingGroupId": "site-a-building",
  "captureGroupId": "survey-2026-01-front",
  "split": "development"
}
```

Before a real benchmark can be trusted, the mapping between source records and physical buildings needs curator verification. The validator cannot independently identify that two photographs depict the same building.

## Tests added

- Missing or unsafe building IDs fail validation.
- The same building in different capture groups cannot cross the development/held-out split.
- Per-building mean is calculated equally across buildings even if they have different photo counts.
- Missing held-out evaluation results are reported as explicit failure cases.
- CLI byte-integrity fixtures provide the required building ID.

## What this does not prove

This slice does not complete BRF-08. It does not calculate independent footprint error, surface-to-surface distance or new survey-dimension error from a reference mesh. It does not supply true annotations, independently verify source rights, calibrate cameras, certify a 90% match, or make a model publication-eligible. Synthetic CI fixtures only validate the evaluation tooling. A real-building result requires independent, traceable truth, a genuinely held-out building set, review of failures, suitable calibration/registration and human sign-off.

`acceptanceEligible`, `publicationEligible` and `mapReady` must remain false until their separate release gates are satisfied.
