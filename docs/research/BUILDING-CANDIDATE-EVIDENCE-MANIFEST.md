# Building candidate evidence manifest (BRF-02)

## Purpose

The candidate evidence manifest is the single versioned evidence graph for one generated building candidate. It links the exact GLB to the BuildingSpec, generation report/configuration, source captures, independent reference images, camera/calibration/alignment evidence, independent dimensions, ground control, review renders, geometry/texture QA, reference comparison, accuracy assessment and release-readiness output.

It complements rather than replaces the existing capture manifest, render-review manifest, accuracy evidence pack and immutable review package. Those remain the authoritative detailed records for their domains; this manifest binds their artifacts and candidate hashes together.

## API

```js
import {
  normalizeBuildingCandidateEvidenceManifest,
  assessBuildingCandidateEvidenceManifest,
} from "../src/core/building-generation/building-candidate-evidence-manifest.mjs";

const normalized = normalizeBuildingCandidateEvidenceManifest(input);
const assessment = assessBuildingCandidateEvidenceManifest(normalized, {
  actualArtifacts: [
    { id: "candidate-glb", relativePath: "candidate.glb", sha256: "...64 hex characters...", bytes: 12345 },
  ],
});
```

For the assessment, pass one `actualArtifacts` row for every present artifact. Each row must come from reading the actual file bytes on disk and hashing them; do not copy the declared hash back into the field. The actual path must be the exact safe project-relative path pinned in the manifest. If actual rows are omitted, the result stays incomplete. If an actual hash, byte length or path contradicts the manifest, assessment fails closed.

## Top-level contract

- `schemaVersion`: currently `1.0.0`.
- `manifestId`, `candidateId`, `buildingId`: safe stable identifiers. `candidateCommit` optionally pins the Git commit that generated/reviewed the candidate.
- `artifacts`: unique IDs and unique safe relative paths, SHA-256 and byte count for present artifacts, or an explicit `status: "missing"` with no claimed hash/size.
- `candidate`: exact candidate GLB, BuildingSpec, generation report and generator identity/strategy; optional configuration artifact.
- `evidence`: capture manifest state, capture/reference image references, per-capture camera/calibration/frame-alignment records, independent dimensions with uncertainty/basis, and ground-control evidence with coordinate frame.
- `outputs`: render manifest and all required 13 render-view artifacts, geometry/texture QA, reference comparison, accuracy report and release-readiness report. Each output is linked to the exact candidate GLB SHA-256.
- `confidence`: identity, dimensions, geometry, facade layout, appearance and georeference. Each non-missing confidence label must cite artifact IDs supporting that claim.

## Assessment outcomes

- `ready-for-review`: all assessment checks passed. This is evidence-package readiness, not final human approval or publication approval.
- `incomplete`: no contradiction was found, but one or more evidence/measurement/review checks remain missing or unverified.
- `failed`: contradictory identities, hashes, paths, candidate bindings, invalid declared evidence or an explicit failed gate was detected.

The `evidenceTier` values A–D are evidence completeness routing labels—not similarity percentages. A verified hash proves byte identity only; it does not prove that a photo is of the correct building, a measurement is true, or a licence is valid. All reports force `publicationEligible: false`.

## Fail-closed rules

1. Candidate GLB, BuildingSpec and generation report must exist and be bound to the same `buildingId`.
2. A capture/reference must be an explicit present artifact, identify this building, have unique bytes per view, include its facade side and rights status; capture and independent reference bytes must not be byte-identical.
3. Camera/calibration/alignment claims must have supporting artifacts. A verified dimension requires surveyed/published measurement basis, positive values and stated uncertainties. Verified ground control must specify WGS84 or local ENU.
4. The render manifest must be bound to the exact candidate hash and link the complete fixed 13-view set. QA, reference comparison, accuracy and release-readiness outputs must reference the same candidate hash.
5. A failed capture manifest or accuracy report, inconsistent "measured" confidence, hash/path/byte mismatch, or attempted publication enablement makes the assessment fail.
6. Missing/unknown evidence remains missing/unknown. Never promote a synthetic renderer fixture, procedural BuildingSpec estimate or successful CI run into a claim of real-world architectural accuracy.

## Verification

Run:

```bash
npm run test:building-candidate-evidence-manifest
```

The same suite runs in `.github/workflows/ci.yml`. The tests cover exact artifact bindings, real-versus-declared file hashes/paths, cross-building identity, camera/calibration evidence, evidence tier constraints, missing/failed source and accuracy records, unsafe paths, duplicate records and publication policy.
