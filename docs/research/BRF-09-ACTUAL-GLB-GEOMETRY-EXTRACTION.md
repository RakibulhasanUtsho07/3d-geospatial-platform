# BRF-09 — Actual GLB Geometry Extraction and Independent Reference Import

## Goal

Create a repeatable path from the exact candidate GLB bytes to geometry that can be compared with an independently sourced reference in a shared metre-based coordinate frame. This task builds on BRF-08's independent-truth evaluator and provenance binding.

## Supported candidate GLB inputs

The adapter currently reads GLB 2.0 with a single embedded BIN buffer and a JSON chunk. It reads **FLOAT VEC3 POSITION** accessors and unsigned byte/short/int indices (or implicit sequential indices), applies node matrix/TRS and an explicitly configured affine transform into the evaluation frame, and triangulates TRIANGLES, TRIANGLE_STRIP and TRIANGLE_FAN primitives. It rejects external/data-URI buffers, sparse accessors, compressed meshopt/Draco primitives, animation, morph targets, skins, malformed ranges, invalid transforms, duplicate-parent node reuse, non-finite values, and degenerate triangles. Unsupported non-triangle primitive modes are reported rather than treated as surfaces.

## Derived measurements and limits

- Width/depth/height are axis-aligned extents of referenced triangle vertices after frame registration. The axis convention is X/Z horizontal and Y vertical.
- Footprint is the convex hull of projected X/Z mesh vertices, not a surveyed wall footprint. It cannot preserve courtyards, holes, concavities, setbacks or internal voids.
- The sampled surface is an evenly spaced, deterministic sample of source triangle order (at most 8,333 triangles / 24,999 vertex positions). It is intended for bounded comparison, not full topology certification.
- GLB node transforms are applied before the configured model-to-evaluation-frame matrix. The explicit matrix is column-major, affine and invertible; the operator must document how it was derived. The adapter does not estimate georeferencing, orientation, scale or survey registration.
- The reference input must provide footprint, dimensionsM, checkPoints, and surfaceMesh.vertices as finite [x,y,z] tuples with triangle indices. Every independent reference check point must explicitly declare independentOfFit: true. Frame registration and source truth still require a human review.

## Config shape

The JSON config schema is 1.0.0, and contains evaluationId, buildingId, generatedAt, extractorCommitSha, candidate, reference, and tolerances.

~~~json
{
  "schemaVersion": "1.0.0",
  "evaluationId": "survey-building-01-eval-2026-10",
  "buildingId": "survey-building-01",
  "generatedAt": "2026-10-27T10:00:00.000Z",
  "extractorCommitSha": "0123456789abcdef0123456789abcdef01234567",
  "candidate": {
    "glbPath": "evidence/candidate.glb",
    "expectedGlbSha256": "<optional-known-glb-sha256>",
    "coordinateFrameId": "site-enu-v1",
    "units": "m",
    "modelCoordinateFrameId": "candidate-local-frame-v1",
    "modelToEvaluationFrameMatrix4x4": [1,0,0,0, 0,1,0,0, 0,0,1,0, 10,0,20,1],
    "checkPoints": []
  },
  "reference": {
    "sourcePath": "evidence/independent-survey-geometry.json",
    "expectedSourceSha256": "<optional-known-reference-sha256>"
  },
  "tolerances": {
    "footprintAreaRelativeErrorPercent": 5,
    "footprintBoundaryP95M": 0.1,
    "footprintBoundaryMaxM": 0.2,
    "dimensionRelativeErrorPercent": 5,
    "checkPointRmseM": 0.1,
    "checkPointMaxM": 0.2,
    "surfaceDistanceP95M": 0.1,
    "surfaceDistanceMaxM": 0.2
  }
}
~~~

Before use, replace placeholders with exact project-relative files, actual frame ID and reviewed transform. If a previously known hash is supplied and the bytes differ, preparation fails. If no expected input hash is known, the adapter records that the source hash was observed during preparation rather than pinned before the run.

## Commands

~~~bash
npm run test:independent-building-truth
npm run prepare:independent-building-truth -- configs/your-building-evaluation.json artifacts/independent-building-truth/prepared-manifest.json
npm run evaluate:independent-building-truth -- artifacts/independent-building-truth/prepared-manifest.json artifacts/independent-building-truth/evaluation-report.json
~~~

The preparation CLI reads exact candidate/reference bytes and the extractor implementation/config, writes a unique review-only manifest, and records hashes and sample counts. The evaluator CLI independently reopens candidate GLB/reference/extractor/config bytes and checks the geometry-provenance digests. A missing candidate held-out checkpoint set should result in an incomplete report; a nonzero exit status is expected until required independent evidence exists. Review the report JSON rather than treating a successful command invocation as accuracy acceptance.

## Release policy

The adapter never turns its output into automatic acceptance. acceptanceEligible, publicationEligible, mapReady, and automaticApproval stay false. Source-byte integrity does not authenticate the physical identity of the building, rights to use the source, survey quality, reviewer independence, or frame-registration correctness. The synthetic test fixture is software regression evidence only and is not a real-building accuracy benchmark.
