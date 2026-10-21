# Bounded wireframe QA and safe repair passes

This stage follows the calibrated multi-view sparse wireframe candidate. It runs a bounded 3- or 4-pass review loop and records each pass in the output.

## Run

```powershell
npm run test:wireframe-qa-repair-passes
npm run qa:wireframe-repair-passes -- ".\\wireframe-candidate.json" ".\\wireframe-qa-report.json"
```

Optional CLI flags: `--max-passes=3` or `--max-passes=4`, and `--max-rms-reprojection-error=3`.

## What it can safely repair

- Remove malformed edges, self-edges and edges referencing missing vertex IDs.
- Remove duplicate undirected edges.
- Re-run validation until the topology is stable or the pass limit is reached.
- Flag high reprojection error or missing/non-finite 3D coordinates for review.

## What it deliberately does not do

It never guesses architectural dimensions, shifts 3D coordinates, fills missing corners, or treats low reprojection error as proof of correctness. A sparse wireframe can be internally consistent and still be wrong if calibration or feature correspondences are wrong. Geometry-level correction requires ground truth or reviewed constraints.

The report always sets `publicationEligible: false`. This is QA scaffolding, not a completed building reconstruction pipeline.
