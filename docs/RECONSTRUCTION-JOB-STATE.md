# Reconstruction Job State and Stage Artifact Contract

## Scope

This is the first implementation step of the staged architectural reconstruction specification. It supplies a versioned, resumable state contract and immutable per-stage JSON artifacts. It does not claim that the computer-vision stages are automatically orchestrated or that architectural reconstruction is accurate. The existing media-to-model CLI is not yet wired to this state machine.

## Stage order

The state machine uses this strict sequence:

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
~~~

The Node.js tests cover stage ordering, immutable/versioned artifacts, checksums, input matching, failure/retry, crash recovery, downstream invalidation, and fail-closed publication gates.
