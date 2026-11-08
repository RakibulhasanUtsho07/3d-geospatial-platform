# Mainline Dynamic 3D Engine Integration — 2026-11-08

## Release base

- Target: `main`
- Exact base SHA: `74e702b70bafc4d7fbf4163de6aadd864aa4e3e4`
- Integration branch: `integration/d3m-engine29-mainline-20261108`
- Cumulative engine source: `feat/d3m-engine29-independent-anchor-witness-20261107` at `e580af850c09e7de9f6ecf462ee872a8f3e90df9`
- Additional source: PR #342 video-frame evidence branch at `7559946227c4cf156b7faa81586e1a97a0cdfcbb`

## Included scope

The integration imports the cumulative D3M-ENGINE-03 through D3M-ENGINE-29 stack. It carries the source-bound building-to-map vertical slice, model/source byte provenance, single-image generation receipts, WGS84 evidence binding, signed review-package evidence, held-out survey-record attestations, trust-registry governance, provider conformance, process isolation, signed process reports, and independent-anchor challenge/witness contracts.

D3M-02 through D3M-07 plus D3M-ENGINE-01/02 are already integrated on Main and are not re-imported from their old branches.

The video-frame coverage correction from PR #342 is included as a separate three-file change. A raw video source must have at least one linked extracted frame before contributing to facade-side capture coverage.

## Conflict and supersession decisions

The latest Main GLB-QA hardening from PR #408 is retained for these ten files:

- `benchmarks/building-reconstruction/brf-04-controlled-baseline-v1.json`
- `docs/BRF-04-CONTROLLED-GLB-BASELINE.md`
- `docs/qa/mesh-topology-qa-scale-vs-shape.md`
- `src/core/building-generation/glb-geometry-qa.mjs`
- `src/core/building-generation/mesh-topology-qa.mjs`
- `tests/building-baseline-defect-injection.test.mjs`
- `tests/fixtures/building-baseline-glb.mjs`
- `tests/fixtures/glb-geometry-fixture.mjs`
- `tests/glb-geometry-qa.test.mjs`
- `tests/mesh-topology-qa.test.mjs`

The D3M source branch already includes a tested generator path for structural through-wall openings and facade placement. The separate older PR #350 helper implementation is not copied on top because that would introduce a second overlapping generator implementation. PR #340's historical coordinate-frame migration is excluded pending a separate coordinate-frame, Cesium placement, and legacy-asset compatibility review.

## CI and acceptance

The source branch's earlier D3M-ENGINE-29 Push/PR Full CI passed on `ba3defda33f1d62d3bd2eb699937e33d4c5eb401`. The current source branch head is `e580af850c09e7de9f6ecf462ee872a8f3e90df9`, so the earlier pass is historical evidence only. This integration requires exact-head Push and PR Full CI on its final SHA before merge.

Real worker-host inference, actual model/cache provisioning, independent survey evidence, real independent-anchor/provider custody, asset-level rights, and human visual acceptance remain operational gates. No release or accuracy flag is enabled by this code integration.
