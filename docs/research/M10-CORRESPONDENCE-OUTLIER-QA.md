# M10 — Multi-view correspondence QA and outlier handling

## Why this stage exists
The existing DLT triangulator can compute a point from supplied matches and report reprojection error, but a single bad corner match can distort the result. M10 adds a deterministic, bounded consensus pass before the wireframe treats a feature as a usable candidate.

## Method
1. Validate unique camera IDs, known observation camera IDs, finite image coordinates and at most one observation per camera for each feature.
2. Enumerate deterministic two-view hypotheses. If the number of combinations exceeds `maxPairHypotheses`, select a deterministic, evenly distributed subset within the configured cap.
3. Score each hypothesis against every original observation using the configured reprojection threshold.
4. Choose the hypothesis with the largest inlier candidate set, using median inlier residual and inlier RMS as deterministic tie-breaks.
5. Refit the selected consensus, then compute per-observation residuals again.
6. Estimate camera centres from the supplied projection matrices and report maximum pairwise ray parallax. Low or unavailable parallax remains review-required.
7. Preserve all source observations and classify disagreements as **suspected outliers**. They are never deleted, silently downweighted, or automatically accepted as false correspondences.

## Output and status
- Every feature reports per-view observed/projected coordinates, residual, inlier-candidate classification, suspected-outlier review classification, consensus size, inlier camera IDs and parallax diagnostics.
- A mismatch with three views remains review-required because the data may identify a conflict but are weak evidence for which observation is wrong. Four or more views can give stronger consensus; any suspected mismatch still requires review.
- Each two-view vertex is explicitly marked `review-required` with `insufficient-views-for-outlier-rejection`; it cannot claim it has identified a wrong observation. The top-level `status: candidate-wireframe` means the sparse structure can be represented, while `qualityStatus: review-required` retains the evidence gate for downstream callers.
- Low-parallax and unavailable-parallax cases are review-required even when residuals are small.
- The wireframe report and all candidate outputs retain `publicationEligible: false`.

## Reproducible tests
```sh
npm run test:correspondence-outlier-qa
npm run test:multi-view-wireframe-registration
```

Tests cover a correct synthetic match, a mismatched corner among four views, a three-view ambiguity, low parallax, insufficient views, invalid thresholds, duplicate camera observations, and wireframe integration.

## Limits and real-building acceptance
This is a geometric consistency check, not a semantic feature matcher or camera calibrator. A coherent but wrong match can still produce a low reprojection residual; calibration errors and inaccurate camera poses can also bias all views together. Projection coordinates and the configured residual threshold must share the same units (pixels only when the projection matrix maps to pixel coordinates).

For a real building, review the exact source-image hashes, independently checked calibration/control points, per-view overlays, residual distribution and rejected-observation log. Run a held-out pilot with deliberately annotated correspondence failures and have a reviewer confirm the suggested outliers. Synthetic CI fixtures validate implementation contracts only; they do not establish real-building dimensions or architectural accuracy.
