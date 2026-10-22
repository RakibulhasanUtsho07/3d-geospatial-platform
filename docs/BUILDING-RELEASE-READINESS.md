# Building release readiness gate

This step joins fresh GLB geometry/texture QA with render-manifest, render/reference-review and correction-verification evidence. Its output is a traceable readiness report; it never publishes the model or edits the candidate asset.

## Run it

Use the exact GLB revision from which the latest Blender render set was generated. The render directory must contain `render-review-manifest.json`.

```powershell
npm run test:building-release-readiness
npm run create:render-correction-qa-evidence -- ".\\candidate.glb" ".\\geometry-qa.json" ".\\texture-qa.json"
npm run assess:building-release-readiness -- ".\\candidate.glb" ".\\building-review" ".\\render-reference-review-report.json" ".\\render-correction-tasks.json" ".\\render-correction-verification.json" ".\\accuracy-evidence.json" ".\\geometry-qa.json" ".\\texture-qa.json" ".\\building-release-readiness.json"
```

The output is created exclusively; if the path already exists, the CLI refuses to overwrite the earlier report. Choose a new output path for every candidate revision.

## Dimension and georeferencing evidence

A separate `accuracy-evidence.json` is required. The release-readiness CLI computes the benchmark itself from the exact candidate GLB's geometry QA and the supplied current render/reference review; it does not accept a user-supplied benchmark report as proof.

Example structure (replace all example values with independently collected evidence for the exact model):

```json
{
  "generatedAt": "2026-10-21T12:00:00Z",
  "dimensionReference": {
    "referenceDimensionsM": { "x": 10, "y": 20, "z": 30 },
    "metresPerModelUnit": 1,
    "tolerancePercent": 1,
    "axisMapping": { "x": "x", "y": "y", "z": "z" },
    "evidence": {
      "basis": "surveyed",
      "referenceId": "replace-with-survey-id",
      "sourceDescription": "Describe the independent measurement source."
    }
  },
  "groundControl": {
    "modelCoordinatesGlbSha256": "replace-with-exact-64-character-candidate-glb-sha256",
    "coordinateEvidenceBasis": "surveyed",
    "sourceDescription": "Describe the independent WGS84 control source.",
    "maxRmsErrorM": 0.5,
    "maxResidualM": 1,
    "controlPoints": [
      {
        "id": "gcp-01",
        "modelX": 0,
        "modelZ": 0,
        "longitude": 90.4,
        "latitude": 23.7,
        "evidenceSourceId": "replace-with-survey-record"
      },
      {
        "id": "gcp-02",
        "modelX": 10,
        "modelZ": 0,
        "longitude": 90.4001,
        "latitude": 23.7,
        "evidenceSourceId": "replace-with-survey-record"
      },
      {
        "id": "gcp-03",
        "modelX": 0,
        "modelZ": 10,
        "longitude": 90.4,
        "latitude": 23.7001,
        "evidenceSourceId": "replace-with-survey-record"
      }
    ]
  }
}
```

The numbers above are placeholders for demonstrating the file shape, not measurements of any real building. Use at least three non-collinear horizontal control points with known model-frame coordinates and longitude/latitude. Replace the GLB hash with the SHA-256 of the exact candidate asset. If this evidence is missing, mismatched, estimated rather than surveyed/official, or outside the configured residual/dimension tolerances, readiness is blocked.

The benchmark reports axis-aligned dimension errors and horizontal WGS84 residuals separately. It does not solve the vertical datum, independently authenticate survey provenance, or establish full surface/architectural accuracy.

## Read the decision

- `blocked`: one or more evidence, QA, coverage, rights or task-verification gates failed.
- `ready-for-final-human-review-with-warnings`: hard gates passed, but geometry, texture or render QA reported warnings that need human review.
- `ready-for-final-human-review`: automated evidence gates passed with no recorded warnings. This still requires a release reviewer.

The CLI reads the geometry and texture QA report files as regular files, hashes their actual bytes, and recomputes both reports from the exact candidate GLB; stale or edited QA JSON is a blocker. The reports can be created with `create:render-correction-qa-evidence`, which refuses to overwrite prior files. The CLI also reopens every safe-named render PNG to verify its current SHA-256 and dimensions against the manifest. It recomputes the correction-verification report from the exact supplied backlog and current review, then rejects the supplied verification JSON if it differs. It checks the candidate SHA-256 against the render manifest and reference review; requires a newly computed dimension/georeferencing benchmark to pass independently sourced dimension tolerances and exact-GLB-bound horizontal WGS84 ground-control residuals; binds render and reference comparisons to the exact recorded image hashes; requires all predefined render views to have a human-reported direct-basis `match`; checks reference rights status; and verifies that correction-review tasks have reached their required terminal states using exact backlog and review report digests.

## Non-negotiable limitations

`publicationEligible` is always `false`. A direct-basis, human-reported match does not independently prove architectural accuracy, historical fidelity, correct georeferencing, or that the model is ready for public distribution. The output is a release-review checklist, not an automatic publication approval. The report does not contain or modify copyrighted model/reference assets.
