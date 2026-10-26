# M05–M08 — Segmentation benchmark, reviewed masks and architectural feature proposals

**Date:** 26 October 2026  
**Target branch flow:** `feat/m05-m08-segmentation-features` → `rakibul-hasan` → `development` → `main`  
**Implementation status:** Contract, evaluator, deterministic feature proposal, CLI and regression fixtures added in this branch. **Real-building pilot acceptance remains incomplete:** no permissioned, hash-pinned Dhaka image/mask dataset or accepted automatic segmentation provider is supplied by these code changes.

## Guardrails

- Do not train or download a segmentation model as part of this task. The evaluator accepts candidate outputs supplied by a provider and compares them with reviewed labels.
- Do not fabricate sample images or label records. The tests use synthetic arrays solely to test calculations and schema behavior.
- A clean contract test does not validate a model on real buildings. A benchmark result never auto-selects or auto-approves a provider; candidate recommendation remains manual review.
- Use the existing M01–M04 capture manifest and source identifiers/hashes. Do not create a parallel source registry.
- The existing edge-sketch commands produce line/edge previews, not semantic masks. Edge maps are never accepted as building-only masks.
- Hidden or occluded architecture remains unknown. A feature marked not-detected is not evidence that the physical feature does not exist.

## M05 — Labelled segmentation benchmark

Implemented in `src/core/building-generation/building-segmentation-benchmark.mjs` and `scripts/evaluate-building-segmentation-benchmark.mjs`.

The manifest uses schema `1.0.0`, exact image/mask hashes and byte lengths, permission/source provenance, human-reviewed ground-truth annotation records, candidate/provider versions and configuration hashes. Each sample has a `captureGroupId` and split (`development` or `held-out-evaluation`); every capture group must remain in one split to avoid burst/near-duplicate leakage.

The reviewed-label RGB palette is fixed and versioned:

| Class | RGB | Colour |
|---|---|---|
| background | `[0,0,0]` | black |
| building | `[255,255,255]` | white |
| vegetation | `[0,255,0]` | green |
| vehicle | `[255,0,0]` | red |
| sky | `[0,0,255]` | blue |
| other | `[255,255,0]` | yellow |

The evaluator checks the actual file hash, byte count, decoded dimensions and palette; verifies a candidate input hash against the exact source-image bytes; and reports per-image/per-class TP, FP, FN, precision, recall, IoU and F1, plus a held-out summary. A missing or invalid candidate result is incomplete/failed rather than zero-filled or treated as a pass. No approved metric threshold is invented by the implementation.

Run a real manifest only after the dataset, rights and annotations have actually been prepared:

```powershell
npm run test:building-segmentation-benchmark
npm run benchmark:building-segmentation -- data/segmentation-pilot/benchmark-manifest.json artifacts/segmentation-report.json --root=.
```

The path and output example are illustrative. They are **not** a checked-in real pilot bundle; placeholder hashes/records will fail validation. The command writes a report and refuses to overwrite an existing report path.

## M06 — Mask-provider interface and reviewed fallback

Implemented in `src/core/building-generation/building-mask-provider.mjs`.

A provider result binds source ID/hash, provider ID/kind/version/config hash, mask encoded-byte SHA and byte length, mask dimensions, binary format, foreground/background values, pixel coordinate convention, confidence, assessment status and reviewer/time. The decoded mask must contain exactly one 0/255 value per source pixel. Stale hashes, wrong dimensions, grey/interpolated masks and edge-preview inputs fail closed.

Provider routing selects an automatic candidate only when its exact per-image result is structurally valid, explicitly human-reviewed and above a configured confidence floor. Otherwise a valid, reviewed manual mask may be selected. If neither is ready, feature extraction remains blocked. A mask-provider-ready status is not publication approval.

## M07 — Evidence-linked architectural observations

Implemented in `src/core/building-generation/architectural-observation-schema.mjs`.

Schema `1.0.0` supports silhouette bounds, roofline segments, outer corners, floor bands, facade regions, window/door/balcony candidates and visible occluders. Each observation links a source ID/hash and view ID, uses source-image pixel coordinates, and retains confidence, method, status and optional mask/edge hashes.

Out-of-image points/lines/polygons/bounds, mismatched source hashes, dangling IDs and invalid confidence are rejected. Visibility (`visible`, `partially-occluded`, `occluded`, `not-visible`, `not-detected`) is separate from review status (`proposed`, `reviewed`, `rejected`). Review events append an audit record while retaining the original proposal and earlier decisions.

## M08 — Bounded per-view feature proposals

Implemented in `src/core/building-generation/architectural-feature-proposals.mjs` and `scripts/propose-architectural-features.mjs`.

The first deterministic stage uses a reviewed, source-size binary mask plus a same-resolution edge map to propose foreground bounds, a top-envelope/roofline cue, extrema-based corner candidates, horizontal edge-density floor bands, and heuristic window/door opening candidates. Analysis is bounded at 8 million pixels and at most 1,000 proposals. Unsupported categories remain not-detected/unknown; the heuristic does not invent hidden features or claim calibrated geometry.

The CLI requires a metadata file with the exact source/mask/edge SHA values and a reviewed M06 mask-provider result. It writes a JSON proposal report, transparent SVG, and PNG overlay over the original image; their hashes and observation provenance are recorded. A human must inspect the PNG overlay against the source before changing any proposal to reviewed.

```powershell
npm run test:building-mask-provider
npm run test:architectural-observation-schema
npm run test:architectural-feature-proposals
npm run propose:architectural-features -- <source.png> <reviewed-mask.png> <same-size-edge.png> <source-view-metadata.json> <new-output-directory>
```

The command syntax is illustrative; the five inputs must exist and their hashes/dimensions must match the metadata. A reviewed manual mask is required; an edge drawing alone is not a valid mask.

## Verification status and what remains

- The new test suites use synthetic deterministic fixtures for leakage, hash/palette/dimension failures, fallback routing, image-coordinate validation, review history, feature overlays and per-category precision/recall.
- CI wiring for these tests is included with the implementation.
- **Not yet achieved:** labelled real-building benchmark imagery, independently reviewed segmentation ground truth, candidate model measurements on a held-out Dhaka subset, approved segmentation thresholds, per-feature human labels and visually accepted real-photo overlays.
- Until those assets are provided and evaluated, M05 remains a benchmark framework rather than a successful model comparison; M08 remains a proposal generator rather than verified architectural understanding. No building accuracy, geometry or publication gate is passed by these tasks alone.
