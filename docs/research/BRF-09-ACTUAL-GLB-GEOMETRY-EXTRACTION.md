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
- The independent reference JSON declares its own source coordinateFrameId and a finite footprintElevationM, metric footprint/dimensions, independently surveyed checkpoints, and surface mesh. The adapter transforms footprint, mesh vertices and checkpoints with a separately declared source-to-evaluation matrix.
- Reference transforms are deliberately restricted to metre-preserving horizontal 0/90/180/270-degree axis alignment plus translation (Y-up with no tilt). Arbitrary yaw, scale, shear and tilt are rejected rather than silently distorting width/depth interpretation. Confirm the source frame and transform against survey metadata before use.
- Candidate held-out check points must use reviewed `checkPointBindings` (ID + active GLB scene node index + primitive index + POSITION accessor vertex index). Coordinates are extracted from the actual rendered GLB vertex after node and evaluation transforms; arbitrary caller-provided checkpoint coordinates are rejected. The bound reference point with the same ID must be held out from fitting (`independentOfFit: true`).

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
    "checkPointBindings": [
      {"id": "survey-check-01", "nodeIndex": 1, "primitiveIndex": 0, "vertexIndex": 42},
      {"id": "survey-check-02", "nodeIndex": 1, "primitiveIndex": 0, "vertexIndex": 89}
    ]
  },
  "reference": {
    "sourcePath": "evidence/independent-survey-geometry.json",
    "expectedSourceSha256": "<optional-known-reference-sha256>",
    "sourceCoordinateFrameId": "survey-local-enu-v1",
    "sourceToEvaluationFrameMatrix4x4": [1,0,0,0, 0,1,0,0, 0,0,1,0, 10,0,20,1]
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

Before use, replace placeholders with exact project-relative files, actual source/evaluation frame IDs, source transform, GLB vertex bindings, survey-derived check points and known hashes. The reference JSON's `coordinateFrameId` must equal `reference.sourceCoordinateFrameId`; it must include a numeric `footprintElevationM` for the X/Z outline. The adapter transforms all reference coordinates into the candidate's declared evaluation frame and swaps width/depth when the horizontal axes are swapped. If a previously known hash is supplied and the bytes differ, preparation fails. If no expected input hash is known, the adapter records the observed source hash rather than claiming it was pinned before the run.

## Commands

~~~bash
npm run test:independent-building-truth
npm run prepare:independent-building-truth -- configs/your-building-evaluation.json artifacts/independent-building-truth/prepared-manifest.json
npm run evaluate:independent-building-truth -- artifacts/independent-building-truth/prepared-manifest.json artifacts/independent-building-truth/evaluation-report.json
~~~

The preparation CLI reads exact candidate/reference bytes and the extractor implementation/config, writes a unique review-only manifest, and records hashes and sample counts. The evaluator CLI independently reopens candidate GLB/reference/extractor/config bytes and checks the geometry-provenance digests. A missing candidate held-out checkpoint set should result in an incomplete report; a nonzero exit status is expected until required independent evidence exists. Review the report JSON rather than treating a successful command invocation as accuracy acceptance.

## Release policy

The adapter never turns its output into automatic acceptance. acceptanceEligible, publicationEligible, mapReady, and automaticApproval stay false. Source-byte integrity does not authenticate the physical identity of the building, rights to use the source, survey quality, reviewer independence, or frame-registration correctness. The synthetic test fixture is software regression evidence only and is not a real-building accuracy benchmark.


## Real-building execution status — not yet an accuracy result

The repository test fixture is synthetic and explicitly identifies itself as such. No independent, survey-backed metric geometry packet for an actual building was available to this implementation run; the Ahsan Manzil photo references do not substitute for a measured footprint, independent checkpoint coordinates and registered reference mesh. Do not run the fixture as a real-building benchmark. Before any accuracy claim, supply rights-reviewed survey/CAD/BIM/LiDAR geometry and held-out survey controls, verify the frame transform and checkpoint independence, and have a reviewer inspect the resulting metrics and reference provenance. `acceptanceEligible`, `publicationEligible`, `mapReady`, and automatic approval remain false.
