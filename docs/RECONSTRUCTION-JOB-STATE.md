# Reconstruction Job State and Stage Artifact Contract

## Scope

The state machine supplies versioned, resumable state and immutable per-stage JSON artifacts. It supports two explicit execution profiles: the complete architectural-reconstruction plan and the implemented media-to-model CLI stages. A profile only marks work completed when that work actually ran. This does not claim that architectural reconstruction is accurate.

## Architectural reconstruction stage order

The reconstruction profile uses this strict sequence:

1. ingest
2. image-analysis
3. tiled-analysis
4. per-view-sketch
5. view-registration
6. wireframe
7. iterative-sketch-repair
8. volume-and-facade-model
9. geometry-repair
10. texture
11. final-acceptance

A stage cannot start until all earlier stages have a completed state and a validated active artifact.

## Architectural geometry evidence execution profile

The command below wires existing reconstruction workers into a checksummed resumable job. It expects one workspace-relative JSON file with:

- cameras: calibrated 3×4 projection matrices in one common frame;
- features: manually verified cross-view observations for the same physical feature IDs;
- edges: explicit feature-ID pairs;
- faces: explicit, reviewed triangular face ID triples;
- textureCandidate: source-image metadata/paths, verified camera calibration records, explicit source-image/camera assignments for each reviewed triangle, and `visibilityReviewed: true` attestations. UV coordinates are computed from the calibrated 3×4 projection matrices and do not need to be supplied.

Every referenced texture image is hashed and its dimensions checked against the input. The operator must explicitly attest that camera calibration, cross-view correspondences, face definitions, and texture source/evidence were reviewed. These attestations are recorded; they are not independent proof that the evidence is correct.

The eleven persisted stages are view-registration, wireframe, iterative-sketch-repair, volume-and-facade-model, geometry-repair, texture, texture-atlas-bake, glb-export, glb-validation, render-review, and final-acceptance. They call the repository's real triangulation, bounded wireframe-QA, explicit-face mesh-building, mesh-surface-review, texture-evidence review, deterministic atlas packer/FFmpeg raster baker, textured GLB exporter, and embedded-texture binding QA workers. A stage is marked complete when its worker ran and a truthful result was durably saved; blocked stages can complete with an explicit blocked status so a final acceptance report is still produced. Quality blockers remain in the report and are not confused with worker completion.

Example:

~~~powershell
npm run test:architectural-geometry-workflow
node scripts/run-architectural-geometry-workflow.mjs . building-001 geometry-job-001 .\geometry-input.json --confirm-camera-calibration-reviewed --confirm-correspondences-reviewed --confirm-face-definitions-reviewed --confirm-texture-evidence-reviewed
~~~

The texture stage computes per-corner UV coordinates from each explicitly assigned calibrated camera's 3×4 projection matrix, checks positive depth, image bounds, projected triangle area, calibration status and reprojection error, and persists per-face projection evidence. Each face also requires `visibilityReviewed: true`: the worker does not automatically choose the best camera or solve occlusion/visibility. The texture-atlas-bake stage composites verified source-image files into an actual PNG atlas using FFmpeg, preserves aspect ratios, extends configured gutter pixels and saves UV-remapped face mappings. The glb-export stage writes geometry, normals, TEXCOORD_0, material bindings and the PNG bytes into a self-contained GLB 2.0 file. The glb-validation stage checks embedded image dimensions/hash, material/texture references, UV layout and seam/content diagnostics. The render-review stage can optionally invoke the existing Blender renderer using renderReview: true; otherwise it records a render plan and correctly says no images were generated. A partial GLB may be retained as a review candidate, but untextured triangles are reported as blockers. mapReady and publicationEligible remain false even when technical checks pass. Human review, measured dimensions, ground-control evidence and a defensible vertical datum remain separate release requirements.

## Media-to-model CLI execution profile

The current local CLI uses a separate, truthful four-stage plan:
1. media-ingestion — local file validation/copy, source rights attestation, and bounded video-frame extraction;
2. building-spec-sync — verified source records are synchronized into a normalized BuildingSpec, and selected views are validated;
3. model-generation — the configured procedural, COLMAP, or single-image AI worker runs and the resulting GLB is checksum-verified;
4. report-finalization — the workflow review report is written with map/publication gates remaining false.

On resume, the CLI reuses completed stage artifacts only when the source manifest, configuration, stage inputs and content hashes still match. A failed or interrupted stage can be retried; an upstream rerun invalidates downstream artifact pointers while preserving their historical files. Intake and video frame extraction are idempotent for matching, verified source content. Changing the source bytes or job configuration requires a new job ID rather than silently mixing outputs.

The four-stage profile does not claim that per-view sketches, wireframe repair, architecture geometry construction or texture repair ran. Those belong to the longer architectural-reconstruction profile and remain separate until connected to actual workers.

## Storage layout

~~~text
<workspaceRoot>/
  .building-engine/
    reconstruction-jobs/
      <buildingId>/
        <jobId>/
          job-state.json
          artifacts/
            <stageId>/
              v0001/
                artifact-<uuid>.json
~~~

The job-state.json file records schema version, source-manifest/configuration SHA-256 fingerprints, attempt/status timestamps, errors, and pointers to active artifacts. Stage artifacts are write-once files with a schema version, stage revision, upstream artifact references, outputs, payload, and a canonical-content SHA-256 digest. Re-running a stage creates a new artifact; it does not overwrite the old file.

## API sketch

~~~js
import {
  createOrResumeReconstructionJob,
  fingerprintStageInput,
  startReconstructionStage,
  completeReconstructionStage,
} from "./src/core/building-generation/reconstruction-job-state.mjs";

const { job } = await createOrResumeReconstructionJob({
  workspaceRoot,
  buildingId: "building-001",
  jobId: "reconstruction-001",
  sourceManifest: [{ sourceId: "front-photo", sha256: "<computed SHA-256>" }],
  config: { tileSize: 1024, overlap: 128, maxRepairPasses: 4 },
});

const inputFingerprint = fingerprintStageInput({
  stageId: "ingest",
  inputs: { sourceManifestSha256: job.sourceManifestSha256 },
  parameters: {},
});

await startReconstructionStage({
  workspaceRoot,
  buildingId: "building-001",
  jobId: "reconstruction-001",
  stageId: "ingest",
  inputFingerprint,
});
await completeReconstructionStage({
  workspaceRoot,
  buildingId: "building-001",
  jobId: "reconstruction-001",
  stageId: "ingest",
  payload: { validatedSourceCount: 1 },
  outputs: { manifest: "source-manifest.json" },
});
~~~

Use a SHA-256 derived from the real stage inputs and relevant parameters in a production worker. The example output path is metadata only; the state module does not generate that file.

## Resume and invalidation behavior

- Reopening the same job with the same source manifest and configuration resumes its existing state. Reusing the job ID with different inputs is rejected; use a new job ID instead.
- If the process left a stage in running, createOrResumeReconstructionJob records it as failed with STAGE_INTERRUPTED. Retry that stage to resume; earlier completed stages and artifacts are retained.
- Completing the same stage with the same input fingerprint returns its active artifact as reusable, without writing a duplicate.
- Rerunning a completed stage with different inputs requires force: true. That stage and all downstream active-artifact pointers are invalidated. Older artifacts remain in history, but stale downstream stages cannot run until their prerequisites are rebuilt.
- A checksum mismatch in any active stage artifact stops the read/resume operation. Unsafe directory symlinks, path traversal and absolute artifact paths are rejected.
- State transitions are intended to be issued by one job runner at a time. This initial contract does not provide distributed locking or a server-side job queue.

## Safety gates

Both job state and every stage artifact explicitly keep mapReady: false and publicationEligible: false. Even when every stage is marked completed, a separate review/release process must establish source coverage, geometry and texture acceptance, independently evidenced scale/dimensions, surveyed horizontal control, vertical datum, and human sign-off. Completion of the state machine alone is not evidence of geographic or architectural accuracy.

## Tests

~~~powershell
npm run test:reconstruction-job-state
npm run test:textured-glb-export
~~~

The Node.js tests cover stage ordering, immutable/versioned artifacts, checksums, input matching, failure/retry, crash recovery, downstream invalidation, and fail-closed publication gates.
