# P3.4 — Responsive map panel occlusion checkpoint

**Date:** 2026-11-02  
**Branch:** `feat/p34-map-panel-occlusion-20261102`  
**Base:** `development` at `f7b2a67fcf0c34623196fa92e719640086e2adce`

## Problem confirmed in source

The map canvas had multiple panels mounted open over it at the same time: the property discovery filters and results panel, the full layer checklist, and the full vertical camera-control stack. On narrow screens, fixed left/right panel widths and the top offsets also allowed the overlay controls to compete for the same map area.

## Changes in this candidate

- Property discovery now starts collapsed and can be opened from an explicit, labelled disclosure control.
- Map layers now start collapsed; the disclosure reports the number of visible layers and preserves the existing layer toggles.
- Camera/navigation controls now start collapsed behind an accessible disclosure. The complete existing action set remains available when expanded and the menu is scrollable within the viewport.
- Mobile docks use non-overlapping vertical rows for property discovery, map controls, and nearby places. The generated-model launcher moves above the bottom layer dock on narrow screens.
- Added Playwright coverage for collapsed defaults, expand/collapse behavior, and default dock separation at desktop (1440×900) and mobile (390×844). Existing layer and camera tests explicitly open their relevant docks.
- Added the feature branch to the CI push branch filter. Pull-request CI already includes `development` as a target branch.

## Validation status

This is an implementation candidate. Exact-head Full CI, Push CI, and the browser viewport assertions must complete successfully before this work is considered validated. The dynamic viewport workload now waits for the initial building stage to settle and then deliberately holds a fresh viewport response while a second production camera intent is delivered through the benchmark-only camera hook; it verifies the manager's AbortController event and the browser-observed AbortError. This avoids relying on timing-sensitive zoom coalescing to prove cancellation. No map imagery provider or red-tile behavior was changed: the reported red imagery/overlay anomaly still requires a separate evidence-led investigation and must not be claimed fixed by this layout change.

## Non-goals and remaining P3.4 evidence

This change reduces default UI occlusion; it does not prove the visual fidelity of the buildings, eliminate the side panel when a user intentionally opens it, or diagnose raster imagery artifacts. The follow-up baseline must still compare equivalent camera/data/device captures and confirm the usable canvas area after the layout change.


## Automated layout screenshots — pending exact-head run

The first passing P3.4 exact-head PR Full CI and Push CI runs confirmed the responsive layout assertions, but those runs did not export standalone screenshots for human inspection. The browser test now writes two captures to `artifacts/p3-4-map-panel-occlusion/`:

- `desktop-default-1440x900.png`
- `mobile-default-390x844.png`

A manifest binds the captures to `GITHUB_SHA` and records their purpose and limitations. CI uploads them as `p3-4-map-panel-occlusion-visual-evidence`. The images use deterministic API fixtures and transparent tile stubs; they are evidence of panel placement and unobstructed canvas area only, not live imagery, building fidelity, or a diagnosis of the red imagery anomaly.

The screenshot-enabled head requires fresh exact-head PR Full CI and Push CI. Human visual inspection remains a separate acceptance activity; the screenshots do not self-approve the layout.


## Follow-up: real-Dhaka imagery anomaly diagnostics

A separate diagnostic slice is now included in the P3.4 candidate. It records bounded, URL-redacted Cesium OSM imagery-provider errors and exposes a development-only readiness probe. The real-Dhaka benchmark waits for stable imagery for at least 750 ms, captures the Cesium canvas separately from the page screenshot, calculates a saturated-red pixel signal and flags an isolated outlier relative to the six cold/warm samples.

A flagged sample is a request for human review, not proof of a bad raster tile and not a reason to hide or mask a layer. The original `cold-01` outlier remains unresolved until a fresh real-Dhaka artifact is inspected and, if necessary, fixed-camera layer isolation identifies its producing layer. The current P3.4 branch now triggers that capture workflow on pushes.

The feature remains Draft/unmerged. Automated diagnostics do not establish the anomaly root cause, general map visual fidelity, or surveyed building accuracy.


## Current-main reconciliation — 2026-11-03

The original source candidate remains PR #320 on historical base `development@f7b2a67...`. Its map-panel code is being carried to `main@7b50e5750994c4b4c8063a39f2f8547c949368ed` on `integration/p34-main-refresh-20261103`, preserving D3M-01 and P3.6–P3.8 changes. The source head's Full CI #41580141385 passed 181/181. Its new screenshot artifact `13206560328` was inspected on desktop 1440×900 and mobile 390×844: the Cesium logo and attribution text remain visible and are not covered by the map docks.

A fresh current-main Full CI, Push CI, and six-sample real-Dhaka browser baseline are still required on the port branch before merge. The six-sample baseline is the live-data acceptance evidence; the deterministic desktop/mobile fixture screenshots prove layout placement only. Keep the red imagery/overlay anomaly open until the producing layer/root cause is isolated and an equivalent live baseline passes human review.


## Refreshed current-main candidate — 2026-11-03

The P3.4 changes are now on `integration/p34-main-refresh-20261103`, based on current `main@7b50e5750994c4b4c8063a39f2f8547c949368ed` after BRF-48 and BRF-14 were promoted. It is 29 commits ahead and zero behind; the complete changed-file set is limited to P3.4 map UX, diagnostic, browser tests, real-Dhaka baseline workflow and documentation. BRF-48/BRF-14/P3.6–P3.8 source files are preserved.

The refreshed branch requires new exact-head Full CI, Push CI and six-sample baseline; earlier P3.4 source-head runs are historical only. Keep this PR Draft until fresh validations and visual artifacts complete.
