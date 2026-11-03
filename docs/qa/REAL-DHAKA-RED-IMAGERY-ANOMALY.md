# Real-Dhaka red imagery anomaly — evidence and containment

**Status: detected; root cause not yet proven.** This document intentionally does not claim that a renderer error, provider failure, or CSS overlay has been fixed.

## Reproducible source evidence

- Baseline workflow: [run #40170572692](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40170572692)
- Source candidate: `2b93cb4d7f51cb09f726fe958cdcf974e763ce73`
- Artifact: `real-dhaka-browser-baseline-2b93cb4d7f51cb09f726fe958cdcf974e763ce73`, ID `12590126227`
- The artifact includes six 1280×800 cold/warm screenshots plus a browser/Next server report. The map viewport is populated; the anomaly is not a blank canvas.

## Quantified observation

I sampled the central portion of each screenshot (x: 18–82% of image width; y: 16–94% of image height) to exclude most fixed side-panel UI. A pixel counted as a saturated-red candidate when R ≥ 145, R > 1.35×G, R > 1.25×B, and R−G > 28. This is an image-space signal, not semantic classification.

| Screenshot | Candidate red pixels | Sampled pixels | Ratio |
|---|---:|---:|---:|
| cold-01 | 7,328 | 511,056 | 1.434% |
| cold-02 | 817 | 511,056 | 0.160% |
| cold-03 | 843 | 511,056 | 0.165% |
| warm-01 | 817 | 511,056 | 0.160% |
| warm-02 | 843 | 511,056 | 0.165% |
| warm-03 | 817 | 511,056 | 0.160% |

The first sample has an approximately 8.7× higher candidate-red ratio than the median of the other five samples. The patch is spatially coherent over the map ground under/around building extrusions. It warrants a real visual defect investigation; the metric alone cannot identify its producing layer.

## What the old capture does and does not prove

- The screenshot was captured after the old benchmark's base-imagery readiness check; successful tile imagery and 2xx network responses were observed.
- The old report groups third-party resources and did not bind every raster tile URL, pixel digest, Cesium provider error, and screenshot region to a diagnostic record. Therefore it cannot establish whether the patch came from actual raster tile content, a transient/invalid tile image accepted with HTTP 2xx, a Cesium imagery transition, or another overlay.
- No evidence currently proves that the Overture buildings or detailed road vector layer produced the patch. Do not delete/hide a layer or paint a mask over it just to make screenshots look consistent.

## Diagnostics now added on the UX repair branch

- Subscribe to Cesium's OpenStreetMap imagery-provider `errorEvent`.
- Keep at most 50 URL-redacted tile-error records per page session, with a monotonic total counter and tile coordinates/zoom/retry metadata.
- Include this diagnostic in each cold/warm browser baseline sample.
- Capture a PNG of the Cesium canvas itself and calculate a conservative saturated-red pixel ratio. Peer outliers are marked **review-required**, not auto-failed or automatically “fixed”.
- Expand the default-collapsed layer list in the P2.6 workload test before asserting its road checkbox is accessible. The previous test failure was a test/UI contract mismatch, not proof that the road layer itself failed.

## Next acceptance gates

1. Run the updated six-sample baseline on the candidate commit and inspect the map-canvas PNG signal and the six page screenshots together.
2. If the provider error counter is non-zero, correlate its message/retry count and tile coordinates with the captured screenshot, while retaining URL redaction. Do not blindly retry all provider errors (rate-limit/auth/invalid-request responses are not equivalent to transient network loss).
3. If the provider counter remains zero but the pixel outlier persists, instrument the relevant render/overlay layers and reproduce with a fixed camera. Provider success alone is not visual proof.
4. Confirm that the outlier does not repeat in the same data/browser scenario after a root cause is identified and a targeted correction is made.
5. Keep PR #170 Draft and do not merge until exact-head CI and the reviewed visual acceptance gate pass.


## Current P3.4 diagnostics port — 2026-11-02

The privacy-safe imagery error diagnostics, Cesium imagery-readiness probe, stable-imagery capture gate and canvas red-pixel review signal are now selectively ported onto `feat/p34-map-panel-occlusion-20261102`. The current feature retains its newer loading-overlay test ID, responsive panel tests and screenshot manifest logic; the old UX branch itself is not merged.

The new evidence must be re-run on the current feature head. A non-zero provider error count is useful correlation evidence but must be matched to tile coordinates/retry details and the screenshot. A zero error count does not rule out an invalid HTTP-200 tile, unexpected raster content, imagery transition or another overlay. Repeated red-pixel outliers without provider errors require fixed-camera layer-isolation captures.

Do not hide or paint over the layer to make the red signal disappear. Do not mark the anomaly fixed until the producing layer/root cause is identified, a targeted correction is made, and an equivalent six-sample run is visually reviewed.


## Current status — 2026-11-03

The P3.4 panel/diagnostic work is being ported to current `main` at `7b50e5750994c4b4c8063a39f2f8547c949368ed`. The desktop/mobile fixture screenshot review confirms the dock no longer covers Cesium attribution, but this does not address the original red imagery anomaly. The saturated-red signal remains a manual-review indicator, not a classifier. A fresh six-sample live-Dhaka baseline, screenshot inspection and fixed-camera layer isolation (if the outlier repeats) remain mandatory; do not close the anomaly on the strength of a green unit test or fixture screenshot.


## Six-sample current-main CI evidence — 2026-11-03

The prior P3.4 current-main candidate's deterministic CI baseline completed 3/3 cold and 3/3 warm samples with no failures. Each sample staged 3,000 Overture building features and rendered 478 local Dhaka road features; the six screenshot digests matched the generated artifact manifest. The canvas-only saturated-red outlier review flagged 0/6 samples and provider diagnostics recorded zero tile errors. This did not reproduce the previously observed 1.434% cold-01 anomaly. It does not identify the historical producing layer or prove real live imagery is fault-free; keep the anomaly unresolved until a comparable target-workstation/live-provider capture and visual review determine its cause.
