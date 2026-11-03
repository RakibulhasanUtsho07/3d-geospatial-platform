# BRF-04 — Controlled GLB baseline and topology regression

## Scope

This suite is a deterministic, synthetic geometry regression fixture. It exercises the current GLB geometry QA adapter and independent reference-dimension checker. It is not a real-building, photogrammetry, architectural-fidelity, texture, survey or georeference benchmark.

## Baseline

The fixture generates one closed cuboid with model-space dimensions 10 × 8 × 6, one mesh, 12 triangles and a stable byte representation for identical inputs. The declared conversion of one model unit to one metre applies only inside this synthetic test.

A clean fixture must satisfy all of the following:

- GLB 2.0 parser accepts the asset.
- Axis-aligned dimensions match the fixture within the configured 2% screening tolerance.
- One mesh and 12 triangles are present, with zero degenerate triangles.
- Topology analysis runs and reports one connected component, zero boundary edges and zero non-manifold edges.
- Repeated generation produces the same SHA-256 hash.

## Deliberate defects

The regression suite injects three independent defect classes:

1. A +20% Y-axis scale change. The file remains structurally parseable but fails the dimension-tolerance check.
2. A repeated triangle index. The file remains structurally parseable but geometry QA reports a degenerate triangle.
3. A third use of an already shared edge. One triangle is changed to use the known shared edge (0, 2), while remaining non-degenerate. The parser still accepts the GLB, but topology QA must report at least one non-manifold edge and include `non-manifold-edges-present`.

The clean-baseline predicate checks topology explicitly, so a model with the injected non-manifold edge cannot accidentally pass merely because its dimensions and triangle counts remain unchanged.

## Run

```bash
npm run test:building-baseline-defect-injection
```

The CI workflow already executes this focused test. This change extends the existing test; it intentionally does not duplicate the script or workflow entry.

## Evidence limits and release policy

Topology output is review-only. A warning is not a universal proof that a mesh is unusable: open surfaces, separate architectural parts and some intentionally split meshes may be legitimate. Conversely, a clean synthetic cuboid does not demonstrate that the analyzer catches every real-world topology failure.

All fixture outputs remain synthetic. The checks do not establish real-building dimensions, survey truth, visual similarity, facade accuracy, image-to-model inference, WGS84 placement or permission to publish. `mapReady`, `publicationEligible` and `automaticApproval` remain false.
