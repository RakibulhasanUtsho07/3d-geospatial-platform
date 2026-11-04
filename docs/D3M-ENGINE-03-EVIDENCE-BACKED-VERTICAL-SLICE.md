# D3M-ENGINE-03 — Evidence-backed building-to-map vertical slice

## What this workflow actually connects

The repository already contains two resumable workflows with distinct stage profiles:

1. `runMediaToModelWorkflow`: licensed local media intake, rights/source records, BuildingSpec provenance sync, selected photogrammetry/single-image/procedural worker and a review-only GLB candidate.
2. `runArchitecturalGeometryWorkflow`: operator-reviewed camera/correspondence input, multi-view registration, wireframe QA/repair, explicit mesh construction, calibrated texture evidence, atlas, textured-GLB export, GLB QA and render review.

They are intentionally separate child jobs. The D3M-ENGINE-03 orchestration module binds them to one parent report without pretending that the first GLB is silently transformed into the second. The media/worker candidate and architectural textured candidate are distinct outputs built against the same exact source-image hashes, IDs, paths and licence records.

## Still-image profile (v1)

The orchestration entry point is `runEvidenceBackedVerticalSlice(options)` in `src/core/building-generation/evidence-backed-vertical-slice.mjs`.

It requires:

- one workspace root, building ID and parent job ID;
- a BuildingSpec and at least three still-image media files;
- an explicit known licence plus `private-media-ingestion`, `photogrammetry-reconstruction` and `texture-baking` permission scopes for every image;
- `confirmRights`, `confirmSameBuilding`, `confirmOverlapReviewed`, `confirmUpAxisReviewed` and a declared up-axis;
- a geometry-input JSON containing cameras, features, edges, explicit faces, and one `textureCandidate.images` row for every media source;
- exact matching source/image IDs, relative paths, byte SHA-256 values and licence values;
- image dimension declarations plus `verifiedSource=true` and `rightsReviewed=true`;
- explicit review attestations for camera calibration, cross-view correspondences, mesh faces and texture evidence.

The media and geometry child jobs receive different deterministic job IDs (`<parent>-media` and `<parent>-geometry`) because the existing resumable job-state store has different stage profiles for the two workflows.

Video sources / extracted frames are deliberately excluded from this first orchestration contract. They require separately reviewed parent-source permissions, frame lineage and selected-frame evidence; they are not coerced into a still-image path.

## Outputs and gate policy

The parent report is written to:

`.building-engine/vertical-slices/<buildingId>/<jobId>/vertical-slice-report.json`

It records:

- exact geometry-input SHA-256;
- exact source manifest and source-set hash;
- selected source view IDs;
- media child job ID, model path, exact GLB SHA-256 and selected IDs;
- geometry child job ID, exact geometry input SHA-256, output textured GLB SHA-256, texture counts, QA checks and blockers;
- failed/blocked stage details while preserving any already-created candidate artifact.

The media model and the final architectural geometry model are reported independently. The orchestration rejects mismatched source IDs, path, licence or byte hashes, re-checks both GLB file hashes, re-checks the geometry input after the child run, and never infers that a successful CI test is a real worker run. It validates the media child against the exact `media-to-model-workflow-v1` engine, building ID, deterministic child job ID and `photogrammetry` strategy; the geometry child must report the exact `architectural-geometry-correspondence-consensus-v6` engine, building ID, deterministic child job ID and geometry input path. Cross-building, cross-job and cross-profile substitution is covered by regression tests. It also validates each child report's exact workflow engine/profile, `buildingId`, deterministic child `jobId`, and (for geometry) the exact input path before accepting that child result; cross-building and cross-job report substitution is rejected by regression tests.

The report always keeps these values false:

- `acceptanceEligible`
- `publicationEligible`
- `mapReady`
- `automaticApproval`

A geometry workflow with blockers or no textured output is recorded as blocked. A complete technical candidate is `completed-requires-human-review`, not accepted or published.

## Structural facade geometry increment in this milestone

The procedural generator now emits actual rectangular window/door and sampled arched front-arcade through-openings. It splits front/back wall surfaces around opening profiles and adds wall-depth jamb, sill/head and end-return surfaces. The generation report records dimensions, shape, edge/floor, provenance and review requirement.

These default openings are still estimated, procedural geometry. They are not inferred from photographs, dimensions measured from an architectural plan, BIM-grade structural semantics, or evidence of the real building. Front-arcade cuts are first-storey only; oversized requested arcade height is clamped with a warning.

## Validation scope

The orchestration tests inject child runners and exercise:
- same-byte source/image binding and exact parent/child hashes;
- distinct job IDs and selected view identity;
- mismatch rejection before worker invocation;
- blocked textured-GLB output;
- preserving the first candidate when the geometry child fails;
- fail-closed release gates.

Injected tests validate orchestration contracts only. Production PR CI must run exact-head Full CI and Blender smoke. A generic demo render is not a real-building benchmark.

## External acceptance gates — not fabricated by code

The following evidence must still be supplied independently:

1. successful inference on the actual worker host with exact model weights, runtime/device and worker report;
2. rights clearance for every exact source image and model weight, including derivative/texture use;
3. independently surveyed/CAD/BIM/LiDAR dimensions, held-out checkpoints and same-building identity;
4. human visual inspection and an authorized signed review record from a provisioned trusted reviewer;
5. surveyed WGS84 horizontal placement plus a defensible vertical height datum;
6. exact approved GLB hash and placement proven in a browser/Cesium release candidate.

No real-building accuracy percentage, geospatial placement accuracy, publication or production map readiness is claimed until these gates are independently satisfied.

## Explicit Cesium catalog handoff

When the two child workflows finish and the geometry child exports a zero-blocker textured GLB, `publishEvidenceBackedVerticalSlice` can bind that exact output to the repository's existing versioned generated-model catalog. The entry point is `src/core/building-generation/publish-evidence-backed-vertical-slice.mjs`.

It requires:
- the completed parent `vertical-slice-report.json`;
- an attestation file inside the same private workspace;
- a separate `reviewReceiptPath` containing an Ed25519-signed reviewer decision receipt;
- `attestation.candidateSha256` equal to the actual textured geometry GLB SHA-256;
- `attestation.verticalSliceReportSha256` equal to the exact parent-report bytes;
- `attestation.sourceSetSha256` equal to the source-set hash recorded by the parent report;
- `attestation.model.id` equal to the parent `buildingId`;
- an exact review-evidence file path and SHA-256;
- all six existing publication checks explicitly true, plus a complete WGS84-ellipsoid placement (longitude, latitude, height, orientation, scale, up/forward axes).

Create a JSON configuration file for the operator CLI:

```json
{
  "workspaceRoot": "D:/building-workspace",
  "reportPath": ".building-engine/vertical-slices/building-a/job-a/vertical-slice-report.json",
  "attestationPath": "review/building-a-publication-attestation.json",
  "reviewReceiptPath": "review/building-a-signed-publication-review.json",
  "publicRoot": "D:/3d-geospatial-platform"
}
```

The attestation must contain the exact parent report SHA-256 and source-set hash as well as the candidate GLB hash. Calculate the parent hash only after its report is final and immutable; any report edit requires a new attestation. Do not copy placeholder coordinates or set checks true without independent evidence.

The signed-review receipt is a JSON envelope with exactly `submission` and `signatureBase64`. Its submission has exactly these fields: `schemaVersion`, `recordType` (`d3m-engine-03-signed-publication-review`), `buildingId`, `verticalSliceReportSha256`, `sourceSetSha256`, `candidateGlbSha256`, `publicationAttestationSha256`, `reviewerId`, `reviewedAtUtc` (canonical UTC ISO timestamp with milliseconds), and `decision` (`approve-for-catalog-handoff`). The Ed25519 signature is over the canonical submission bytes used by D3M-01: recursively sorted object keys, original array order, compact JSON, UTF-8, no trailing newline. All four SHA-256 bindings must match the exact report, source set, GLB and attestation bytes. The attestation's `review.reviewer` and `review.reviewedAt` must exactly match the signed reviewer ID and timestamp.

The publisher reads `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON` only from its runtime environment. Production must receive the versioned public-key-only registry through the deployment secret manager; legacy key arrays are rejected in production. Do not place private keys, registry JSON or public keys in the publication config, repository or CLI arguments. A valid signature proves possession of the key currently trusted by the registry; the platform operator must establish reviewer identity and authority separately.

The verified signature provenance (reviewer ID, key ID, registry ID, public-key fingerprint, signature hash, signed-payload hash and receipt-file hash) is retained in the versioned catalog review metadata. It is integrity/audit evidence, not proof of source rights, survey accuracy or architectural correctness.

Run the explicit command from the repository:

```powershell
npm run publish:evidence-backed-vertical-slice -- .\publish-config.json
```

The handoff delegates to the existing versioned catalog publisher. It writes a content-addressed GLB under `public/models/generated/` and updates `public/models/generated/manifest.json`; deploy/commit those two public outputs together. The Cesium generated-model layer reads the catalog and uses its active version. This explicit catalog write is public distribution of the GLB, not a preview-only action.

**Trust boundary:** this implementation now verifies an Ed25519 receipt against the server-configured D3M-01 trusted-reviewer registry before writing the D3M-ENGINE-03 catalog entry. It no longer treats a plain operator-supplied boolean attestation as sufficient on its own. However, a valid signature proves key possession only; no production reviewer has been onboarded or production registry provisioned in this PR. The signature does not prove civil identity, professional/legal authority, source-owner rights, architectural fidelity, metric scale, independent survey checkpoints or vertical datum. The platform operator must establish reviewer identity/authority through its governance process and complete the BRF-25 independent-truth process. The parent workflow's `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` flags remain false even after an explicit catalog write; catalog existence is not an accuracy or acceptance assertion.
