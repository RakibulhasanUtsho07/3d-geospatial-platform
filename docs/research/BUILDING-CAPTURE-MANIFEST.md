# Building Capture Manifest, Source Evidence and Accuracy-Pack Binding

**Document ID:** BCM-001  
**Version:** 1.0  
**Date:** 26 October 2026  
**Status:** Implemented contract and workflow; real-building evidence is not included in this document.

This document describes the M01–M04 implementation on `rakibul-hasan`. It reuses existing BuildingSpec/media intake, dimension validation, ground-control registration, render manifest and building accuracy evidence-pack modules. It does not claim that a rendered GLB is architecturally accurate.

## M01 — Generic 13-view review renderer

`scripts/blender/render-building-review.py` preserves the focused Rangmahal front view when its known component names exist. When those names are absent, it renders the complete non-site model from the generic front camera instead of failing before all views are created. Whole-model back/left/right/top and eight turntable views are unchanged.

Run:

```powershell
npm run test:render-review-manifest
npm run render:building-review -- .\\artifacts\\candidate.glb .\\artifacts\\candidate-review
```

Blender must be installed and available as `blender` or supplied using `--blender=<path>`. Rendering has a bounded 600,000 ms default timeout; use `--timeout-ms=1000..900000` to set an explicit limit. A timeout stops the child process and reports retained partial files without accepting them as a render set. The renderer's front/back labels still follow imported GLB axes; they are not automatic proof of true-world facade direction. A successful renderer run produces evidence for human review, never direct publication.

## M02 — Capture manifest contract

A capture manifest is a versioned JSON record with:
- building identity provenance;
- source records with purpose (`capture`, `reference`, or `measurement-evidence`), kind, facade/side, relative path, byte count and SHA-256;
- rights/permission evidence and reviewer timestamp;
- camera/pose confidence and occlusion status per capture;
- independent X/Y/Z measurements with uncertainty and source/evidence IDs;
- surveyed WGS84 control points that later must also be paired with coordinates in the exact candidate GLB.

The schema is `1.0.0` and is implemented in `src/core/building-generation/building-capture-manifest.mjs`. Missing information is represented as missing/unknown and appears as an incomplete readiness check. Invalid paths, IDs, values, references or hashes are not silently repaired.

A compact illustrative fragment follows. Every identifier, file and number is a placeholder, not real-building evidence. It will not pass unless the referenced files and all required attestations really exist and are reviewed.

```json
{
  "schemaVersion": "1.0.0",
  "manifestId": "replace-with-review-id",
  "buildingId": "replace-with-building-id",
  "createdAt": "2026-10-26T10:00:00Z",
  "buildingIdentity": {
    "status": "operator-attested",
    "sourceId": "replace-with-official-source-id",
    "evidenceDescription": "Replace with the evidence actually reviewed.",
    "verifiedBy": "replace-with-reviewer",
    "verifiedAt": "2026-10-26T10:00:00Z"
  },
  "sources": [
    {
      "id": "capture-front",
      "purpose": "capture",
      "kind": "photo",
      "side": "front",
      "path": "evidence/front.jpg",
      "sha256": "REPLACE_WITH_ACTUAL_64_CHARACTER_SHA256",
      "bytes": 12345,
      "sourceId": "replace-with-source-record-id",
      "rights": {
        "status": "verified",
        "evidenceId": "replace-with-rights-evidence-id",
        "reviewedBy": "replace-with-reviewer",
        "reviewedAt": "2026-10-26T10:00:00Z"
      },
      "camera": {
        "status": "estimated",
        "headingDegrees": 180
      },
      "occlusion": {
        "status": "partial",
        "notes": "Replace with the actual reviewed occlusion notes."
      }
    }
  ],
  "measurements": [
    {
      "id": "dimension-x",
      "axis": "x",
      "valueM": 20,
      "uncertaintyM": 0.05,
      "basis": "surveyed",
      "status": "verified",
      "sourceId": "replace-with-measurement-evidence-source-id",
      "evidenceId": "replace-with-survey-reference-id",
      "verifiedBy": "replace-with-surveyor-reviewer",
      "verifiedAt": "2026-10-26T10:00:00Z"
    }
  ],
  "controlPoints": []
}
```

For a complete multi-view pilot, include separate capture photos covering front/back/left/right, independent reference photos for those sides, a measurement-evidence asset, verified X/Y/Z dimensions and at least three non-collinear surveyed control points. The one-record fragment above is only a schema illustration. For a complete accuracy pack, the existing release evaluator also requires its stricter rights/source identity fields to be independently reviewed; an operator attestation alone does not authenticate copyright.

## M03 — Validate source files and readiness

The validator computes SHA-256 and byte size for every declared source file, refuses project-root escapes and symlink traversal, and checks that computed values match the manifest. It separately assesses source-side coverage, rights provenance, camera/occlusion annotations, independently sourced dimensions, control-point provenance and building identity. Rights/survey entries are still human/operator assertions; the program cannot independently authenticate them.

First run in bootstrap mode to inspect the manifest hash:

```powershell
npm run test:building-capture-manifest
npm run validate:building-capture-manifest -- docs/evidence/building-capture-manifest.json artifacts/capture-manifest-report.json --root=.
```

Bootstrap mode intentionally returns `incomplete` because the manifest's expected digest is not pinned yet. Review the reported `input.manifestSha256`, then rerun with that exact value:

```powershell
npm run validate:building-capture-manifest -- docs/evidence/building-capture-manifest.json artifacts/capture-manifest-report-pinned.json --root=. --expected-sha256=<reviewed-manifest-sha256>
```

Exit codes: `0` means ready-for-review; `2` means incomplete evidence; `1` means invalid/mismatched evidence or invalid input. None of these values directly approves publishing a GLB.

## M04 — Bind the capture manifest to the accuracy evidence pack

Each building in the evidence-pack manifest may now declare:
- `captureManifestPath` — relative path to the versioned capture manifest;
- `expectedCaptureManifestSha256` — digest reviewed and pinned after bootstrap.

For a complete evidence-pack result, these declared assets must be bound to the manifest by ID, purpose, path, content SHA-256, byte length, side/facade and rights-review provenance. The independent `dimensionReference` values and source basis/reference ID must match unique, verified `surveyed` or `published-measurement` X/Y/Z records sourced from a `measurement-evidence` asset, within their recorded uncertainty. Duplicate axes, estimated/inferred dimensions, repeated asset/control IDs, collinear controls, and conflicting GCP coordinates/source links cannot pass their binding checks. A failed source-manifest integrity result remains failed and is never downgraded to incomplete by a separate binding check. Ground-control IDs, WGS84 coordinates and evidence-source references must match the documented control points. The existing benchmark still binds model-space controls to the exact candidate GLB hash.

If the capture manifest is missing, incomplete, unpinned, tied to another building, or inconsistent with declared evidence, the evidence pack cannot report the new binding gate as passed. Existing legacy inputs can still be inspected, but the combined status remains incomplete or failed instead of being promoted to a clean pass.

Run:

```powershell
npm run test:building-accuracy-evidence-pack
npm run test:building-accuracy-benchmark
npm run test:building-release-readiness
```

The evidence-pack report continues to keep `mapReady=false`, `publicationEligible=false`, and `automaticApproval=false`. A complete pack remains review-required.

## Test and verification limits

The committed renderer regression test checks that the Rangmahal-specific hard failure is removed and the generic whole-model fallback remains in the renderer source. That test is not a substitute for executing Blender on a generic GLB. An actual 13-view render must be generated and its images inspected before M01 can be called visually verified. Likewise, passing schema/hash tests does not supply genuine building measurements, permissions, or survey control.

No real-building capture manifest, independent measurement pack, model, or visual accuracy result is fabricated or included here.
