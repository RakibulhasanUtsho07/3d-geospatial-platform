# BRF-08 — Whole-building holdout and independent geometry truth evaluation

**Status:** Scoped evaluator implementation added; BRF-08 remains in progress.  
**Branch:** `feat/brf-08-independent-truth-evaluator`  
**Purpose:** protect held-out segmentation evaluation at the physical-building level, and compare candidate geometry with traceable independent references without turning a software report into an architectural-accuracy or publication claim.

## 1. Whole-building held-out split integrity

The segmentation benchmark requires a stable, safe `buildingGroupId` for every sample. All views, dates and capture sessions for one physical building must share the same ID and stay in one split. The validator rejects the same ID crossing `development` and `held-out-evaluation`, case-insensitively, even when `captureGroupId` values differ. Existing capture-burst split protection remains.

Reports include total and held-out building counts, equal-weight per-building macro foreground IoU alongside per-image averages, and explicit failed/missing held-out result cases. Correct physical-building identity still depends on curator-verified metadata; hashes alone cannot identify a building.

## 2. Independent geometry evaluator

The exported API is `evaluateIndependentBuildingTruth(input)` in `src/core/building-generation/independent-building-truth-evaluator.mjs`. The CLI is `scripts/evaluate-independent-building-truth.mjs`.

The evaluator reports separate metric groups:

- **Footprint:** area and relative area error, perimeter, centroid offset, bounding dimensions and bidirectional sampled boundary-to-segment distances (mean, RMS, p95 and max).
- **Metric dimensions:** width, depth and height in metres, each with absolute/relative error, plus maximum and RMS relative error.
- **Independent check points:** point-by-point `dx/dy/dz` and 3D Euclidean residuals; summary statistics; missing and extra IDs. Each reference checkpoint must explicitly declare `independentOfFit: true`.
- **Optional surface reference:** bidirectional nearest-triangle distances from each mesh's vertices using a bounding-volume hierarchy, summarised independently and symmetrically. Both candidate and reference mesh inputs are required together; a one-sided mesh is incomplete, not a pass.

Candidate and reference geometry must declare the same metric coordinate-frame ID and metre units. Geometry evidence must bind to the candidate GLB and reference-source SHA-256 values. The CLI reads both source paths, verifies actual bytes against the declared hashes, rejects traversal/symlink paths, writes a new hash-pinned report and exits non-zero on failure.

## 2.1 Reproducible geometry-extraction provenance

Each `candidate` and `reference` record supplied to the CLI must include `geometryExtractionProvenance`. The contract records:

- `schemaVersion`, `extractionRunId`, `method` and `extractedAt`;
- the exact source-artifact SHA-256 as `inputArtifactSha256` (candidate GLB bytes for the candidate, survey/reference source bytes for the reference);
- a deterministic `outputGeometrySha256` calculated from the evaluated coordinate frame, units, footprint, dimensions, check points and optional surface mesh;
- an extractor ID/version/commit plus project-relative paths and SHA-256 values for the extractor source artifact and extraction configuration;
- the same `coordinateFrameId` and metre units used by the evaluator.

The CLI recomputes the geometry payload digest, reads the extractor/config files from disk to verify their actual bytes match the declared hashes, replays the candidate GLB extractor and reference frame adapter from the actual source bytes using the hash-pinned preparation config, and fails if replayed geometry differs from the manifest. Missing provenance yields an incomplete report; mismatched input, output digest, frame, extractor source or config bytes fails closed. The report records each tool/config artifact hash and per-role provenance status. The helper in `src/core/building-generation/geometry-extraction-provenance.mjs` uses canonical JSON key ordering so property-order changes do not change the payload digest.

Example shape (use actual SHA-256 values for the project’s files; these placeholders are deliberately not runnable):

```json
{
  "geometryExtractionProvenance": {
    "schemaVersion": "1.0.0",
    "extractionRunId": "candidate-extraction-2026-01",
    "method": "glb-position-accessor-and-reviewed-geometry-adapter-v1",
    "extractedAt": "2026-10-27T08:00:00Z",
    "inputArtifactSha256": "<exact-candidate-or-reference-source-sha256>",
    "outputGeometrySha256": "<canonical-geometry-payload-sha256>",
    "coordinateFrameId": "survey-local-enu-v1",
    "units": "m",
    "extractor": {
      "id": "building-geometry-extractor",
      "version": "1.0.0",
      "commitSha": "<extractor-source-commit>",
      "artifactPath": "tools/geometry-extractor.mjs",
      "artifactSha256": "<sha256-of-extractor-source-file>",
      "configurationPath": "configs/geometry-extractor.json",
      "configurationSha256": "<sha256-of-extractor-config-file>"
    }
  }
}
```

This contract binds declarations to the bytes used for the evaluation and makes the extraction recipe traceable. The preparation CLI extracts candidate geometry from the raw GLB POSITION/index data and imports the independently reviewed reference JSON into the evaluation frame. The evaluation CLI now replays both operations again from the hash-verified source bytes and the hash-pinned preparation configuration, then compares the resulting geometry payload hashes against the stored candidate/reference payloads before the report can be considered reviewable. Candidate checkpoint coordinates are re-extracted from the exact stored GLB vertex bindings. Altering inline geometry and simply refreshing its declared digest cannot bypass the replay check. This still does **not** authenticate physical-building identity, source rights, survey quality, reviewer independence, or the correctness of the human-approved registration transform. The source-to-geometry mapping and the truth source remain separate evidence obligations; geometry is not inferred automatically from raw photos/video.

### Run it

```bash
npm run test:independent-building-truth
npm run evaluate:independent-building-truth -- --help
npm run evaluate:independent-building-truth -- evaluation-manifest.json artifacts/evaluation-report.json --root=.
```

The report path must not already exist because output creation uses exclusive file creation. Supply the manifest and evidence assets under the selected root.

### Manifest contract (illustrative, not real survey data)

```json
{
  "schemaVersion": "1.0.0",
  "evaluationId": "site-a-eval-01",
  "buildingId": "site-a-building",
  "generatedAt": "2026-10-27T08:00:00Z",
  "candidate": {
    "glbPath": "evidence/candidate.glb",
    "glbSha256": "<sha256-of-exact-glb-bytes>",
    "geometrySourceGlbSha256": "<same-glb-sha256>",
    "coordinateFrameId": "survey-local-enu-v1",
    "units": "m",
    "footprint": [
      { "x": 0, "z": 0 },
      { "x": 10, "z": 0 },
      { "x": 10, "z": 8 },
      { "x": 0, "z": 8 }
    ],
    "dimensionsM": { "widthM": 10, "depthM": 8, "heightM": 6 },
    "checkPoints": [
      { "id": "independent-corner-01", "x": 0, "y": 0, "z": 0 }
    ]
  },
  "reference": {
    "sourcePath": "evidence/independent-survey.json",
    "sourceId": "survey-record-01",
    "sourceSha256": "<sha256-of-exact-reference-source-bytes>",
    "geometrySourceSha256": "<same-reference-source-sha256>",
    "evidenceBasis": "surveyed",
    "sourceDescription": "Independent site survey and reviewed geometry export.",
    "reviewedBy": "reviewer-id",
    "reviewedAt": "2026-10-26T10:00:00Z",
    "coordinateFrameId": "survey-local-enu-v1",
    "units": "m",
    "footprint": [
      { "x": 0, "z": 0 },
      { "x": 10, "z": 0 },
      { "x": 10, "z": 8 },
      { "x": 0, "z": 8 }
    ],
    "dimensionsM": { "widthM": 10, "depthM": 8, "heightM": 6 },
    "checkPoints": [
      {
        "id": "independent-corner-01",
        "x": 0,
        "y": 0,
        "z": 0,
        "independentOfFit": true
      }
    ]
  },
  "tolerances": {
    "footprintAreaRelativeErrorPercent": 5,
    "footprintBoundaryP95M": 0.25,
    "footprintBoundaryMaxM": 0.5,
    "dimensionRelativeErrorPercent": 5,
    "checkPointRmseM": 0.25,
    "checkPointMaxM": 0.5,
    "surfaceDistanceP95M": 0.25,
    "surfaceDistanceMaxM": 0.5
  }
}
```

For a reference surface, add `reference.surfaceMesh` with `sha256` equal to the exact reference source SHA-256 and a reviewed mesh `vertices` array plus triangle index arrays. Add `candidate.surfaceMesh` with `sourceGlbSha256` equal to the candidate GLB SHA-256 and the candidate mesh vertices/triangles. The adapter currently caps footprint rings at 500 vertices and 16 samples per edge; it caps surface inputs at 25,000 vertices and 50,000 triangles to bound work.

### Threshold behavior and outcomes

Metric thresholds are explicit inputs; they are not silently invented by the evaluator. Missing/invalid thresholds produce a warning and an incomplete report. Exceeding a configured threshold is a failure. Missing footprint, dimension or held-out check-point evidence is incomplete. Invalid/self-intersecting footprints, stale hashes, unsupported reference basis, differing coordinate frames, non-finite values and mesh integrity problems fail closed.

Every report preserves:
- `acceptanceEligible: false`
- `publicationEligible: false`
- `mapReady: false`
- `automaticApproval: false`

A report with all supplied metrics inside thresholds is still `benchmark-review-required`, never automatic PASS or a universal “90% accurate” score.

## 3. Automated coverage

New tests live in:
- `tests/independent-building-truth-evaluator.test.mjs`
- `tests/independent-building-truth-evaluator-cli.test.mjs`

Coverage includes equal candidate/reference geometry, shifted footprints and dimensions, shifted mesh geometry, missing or malformed geometry, self-intersection, stale hashes, mismatched frames, declared-untrusted truth, held-out points incorrectly reused for fitting, missing thresholds and on-disk byte mismatch. The package script `test:independent-building-truth` runs both suites and CI runs the same script.

Synthetic fixtures prove the contracts of the evaluator only. They are not measurements of a Dhaka or heritage building.

## 3.1 Integration with the building-accuracy evidence pack

The evaluator JSON report can now be consumed by `buildBuildingAccuracyBenchmark` and the existing evidence-pack CLI. In each relevant top-level `buildings[]` entry of the pack manifest, configure:

```json
{
  "requireIndependentTruthEvaluation": true,
  "independentTruthReportPath": "artifacts/independent-building-truth/site-a-report.json",
  "expectedIndependentTruthReportSha256": "<reviewed-report-file-sha256>"
}
```

The pack builder verifies the report file’s actual bytes against the expected digest, requires the report to identify the exact candidate GLB SHA-256, verifies the evaluator result and extraction-provenance status, includes the independent geometry metrics summary in the report, and exposes a separate `independent-truth-geometry-evaluation` gate. If `requireIndependentTruthEvaluation` is true and the path/report/hash is missing, the pack is incomplete; mismatched candidate hashes or failed geometry evidence fail. An input report is not considered trusted merely because it exists or has a JSON schema.

## 4. Limits and remaining BRF-08 gates

This is an evaluator for supplied, already-extracted geometry evidence; it **does not yet parse the candidate GLB to extract its footprint/check points or ingest and independently reconstruct reference geometry from the survey source**. The geometry arrays are provided by an upstream evidence-preparation step. The source hash binds the declared files, but does not independently authenticate survey identity, accuracy, rights, measurement provenance or that the supplied coordinates were correctly extracted from those bytes. Curator review and a reproducible extraction adapter are still required.

Other metric limits:
- Footprint comparison assumes both polygon rings are already registered in the same coordinate frame, models one simple outer ring only (3–500 ordered vertices), and estimates boundary distances using deterministic edge samples (1–16 samples per edge). It does not compute polygon IoU or continuous Hausdorff distance.
- Surface comparison measures distances from vertices to opposing triangle surfaces; it is not continuous signed Hausdorff distance, uniform surface sampling or a surface completeness/topology proof. Use a trusted independently reviewed mesh in the same coordinate frame.
- `independentOfFit` is a manifest assertion. The reviewer must ensure checkpoint coordinates were not used for fitting scale, camera pose, alignment or geometry.
- Width/depth/height are compared in a declared axis convention. Axis permutations or frame mistakes must be resolved before interpreting errors.
- SHA-256 proves exact byte identity only, not physical building identity or survey truth.

BRF-08 is not closed until the geometry extractor/provenance path, suitable real held-out buildings, independently reviewed measurements, calibrated coordinate frames, failure-case review and human sign-off are actually exercised. Real-building acceptance remains release-blocking. Do not infer accurate Ahsan Manzil/Bangabhaban geometry from synthetic CI. Keep all publication/map-ready gates disabled until their separate requirements pass.


## 3.2 Metric computation is gated by exact-source replay (BRF-40)

The filesystem evaluator must not calculate or expose footprint, dimension, held-out checkpoint or surface-distance metrics from inline manifest geometry unless all of these prerequisites pass first:

- the preparation configuration's bytes match its recorded SHA-256;
- candidate GLB bytes match the declared candidate SHA-256;
- independent reference source bytes match the declared reference SHA-256;
- replaying the GLB extraction from those exact bytes and the pinned transformation/checkpoint bindings reproduces the prepared candidate geometry digest; and
- replaying the reference JSON adapter from its exact bytes, declared source frame and metric-preserving transform reproduces the prepared reference geometry digest.

When any required prerequisite is failed or incomplete, the report uses \`metrics: null\` and \`metricComputation.status: "withheld"\`, with a reason-coded check; the CLI exits non-zero. It must not compute numbers from the untrusted inline geometry and then merely label those numbers failed. On success, the report records \`metricComputation.status: "computed-after-source-replay"\`. A successful replay still does not certify the real-world identity, license, survey quality or accuracy of the building; every release flag remains false.

Regression coverage is in \`tests/independent-building-truth-evaluator-cli.test.mjs\`, including altered candidate geometry despite a refreshed declared digest, changed registration transforms, altered reference measurements and mutated reference-source bytes.
