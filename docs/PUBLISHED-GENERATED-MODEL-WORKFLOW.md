# Reviewed Generated Model Publication

Status: explicit CLI publication, a separately token-authenticated generation-job publication API, static versioned catalog, SHA-256 checks, and version rollback are implemented on the development integration line. This is not an automatic approval system or a multi-user role-management service.

## Workflow

1. Generate a candidate using the existing media-to-model workflow. Outputs under \`.building-engine/jobs/\` remain private review candidates; do not copy them into \`public/\` before review.
2. Inspect the GLB visually and review its architecture, source rights/identity, independently measured scale, horizontal WGS84 placement, and vertical datum. Keep an evidence file/package inside the workspace.
3. Create a review attestation that references the exact candidate hash and evidence-file hash.
4. Run \`npm run publish:building-model -- <workspaceRoot> <candidate.glb> <review-attestation.json>\`.
5. The command copies a content-addressed GLB to \`public/models/generated/\` and updates \`public/models/generated/manifest.json\`. It rejects malformed GLB 2.0 containers, hash mismatches, missing review checks, invalid coordinates, duplicate/invalid catalog entries and unsafe paths.
6. Run the map and choose the active version in **Generated models → Published model catalog**. The catalog selector uses the model's active version and displays the recorded checksum and reviewer.
7. Commit/deploy the published GLB and manifest together. Static hosting serves files placed under \`public/\`; the publish command itself does not deploy the website.

The manifest preserves prior versions. Publishing a new version sets it active, but does not delete the old file. To rollback, use the previous version ID from the manifest:

\`\`\`powershell
npm run activate:building-model-version -- <workspaceRoot> <model-id> <version-id>
\`\`\`

Activation verifies that the versioned GLB still matches the stored SHA-256 before changing \`activeVersion\`. Commit/deploy the updated manifest for a remote deployment to use the rollback.


## Recommended: publish directly from an approved generation job

The connected generation queue has a separate review API. Submit the explicit review after inspecting the exact GLB and QA report, using `GENERATION_REVIEW_API_TOKEN` (not `GENERATION_API_TOKEN`). The approved review record is persisted under the private job workspace and its hash is attached to the job status.

The review request must include the exact complete placement object as part of the approval. The immutable review record stores its canonical SHA-256; the publication CLI/API must receive that exact same placement. The CLI supplies the fixed `WGS84-ellipsoid` height-reference marker rather than allowing callers to select an arbitrary datum. A legacy approval without the placement binding is rejected. Height is interpreted as WGS84 ellipsoid height; convert other datums before review.

After the job is approved, publish the same reviewed bytes with the exact placement recorded at approval:

```powershell
$workspace = "E:\\building-engine-workspace"
$jobId = "gen-<job-uuid>"
npm run publish:approved-generation-job -- $workspace $jobId --longitude 90.40606 --latitude 23.7086 --height 0 --heading 0 --scale 1 --up-axis Y --forward-axis Z
```

Replace the sample coordinates with the surveyed position for this exact model. The longitude, latitude and height flags are required; orientation defaults are shown explicitly above. The command verifies the queue request checksum, approved review-audit checksum, candidate GLB checksum and QA-report checksum before invoking the versioned catalog publisher. It refuses unapproved jobs, missing review checks, tampered records, a changed model/report, or missing placement.

Successful publication writes the content-addressed GLB and updates `public/models/generated/manifest.json`. The review audit remains private. The publication action is explicit and does not mutate the completed queue job into a different status: `mapReady=false` and `publicationEligible=false` remain fail-closed in that job record. This means “approved review” and “published catalog version” are deliberately separate states.

`npm run publish:approved-generation-job` is an operator CLI, not a public endpoint. Do not expose it to untrusted requests or deploy the workspace as static content.

## Map-side publication from an approved generation job

The Generated models dialog now includes **Publish an approved generation job to this map**. It calls `POST /api/building-generation/jobs/<jobId>/publish` with a distinct `GENERATION_PUBLISH_API_TOKEN`, explicit WGS84 position, height, orientation, scale and GLB axes. See [D3M-02 — Generation Job to Cesium Map Publication](D3M-02-GENERATION-JOB-TO-MAP-PUBLISH.md) for the exact contract and deployment requirements.

The API invokes the existing approved-job publisher. It re-verifies the request, approved review record (including the exact placement digest), candidate GLB and QA report from the private workspace; it rejects a changed longitude/latitude/height/orientation/scale/axis and writes only the content-addressed GLB and manifest under the application public root (`process.cwd()/public/models/generated/`). The application public directory must be writable and persistent. The UI then rereads the catalog and checks the exact model ID, active version ID, SHA-256 and asset URL before loading the catalog definition into the current Cesium session.

The publish token is entered in the panel and retained only in component memory; it is not stored in localStorage. Publication is explicit and makes the GLB publicly fetchable. The API does not change the generation job's `mapReady` or `publicationEligible` flags, and the map load is not proof of model accuracy or independent survey acceptance.

Catalog writes are serialized with `.generated-model-catalog.publish.lock`. If a process crashes, verify that no publisher is running before manually removing a stale lock directory. Do not remove an active lock.

## Review attestation format

Save an attestation JSON file inside the workspace, for example \`review/dhaka-building-001.attestation.json\`. Replace every example with verified information; do not mark a check true merely to make the command pass.

\`\`\`json
{
  "schemaVersion": "1.0.0",
  "candidateSha256": "replace-with-64-lowercase-hex-characters",
  "model": {
    "id": "dhaka-building-001",
    "name": "Reviewed building model",
    "position": {
      "longitude": 90.40606,
      "latitude": 23.7086,
      "height": 0
    },
    "headingDegrees": 0,
    "pitchDegrees": 0,
    "rollDegrees": 0,
    "scale": 1,
    "upAxis": "Y",
    "forwardAxis": "Z"
  },
  "review": {
    "reviewer": "review-team-id",
    "reviewedAt": "2026-10-22T10:00:00.000Z",
    "evidenceId": "review-package-dhaka-building-001",
    "evidencePath": "review/dhaka-building-001-review-package.json",
    "evidenceSha256": "replace-with-64-lowercase-hex-characters",
    "checks": {
      "rightsVerified": true,
      "sourceIdentityVerified": true,
      "architectureReviewed": true,
      "metricScaleVerified": true,
      "horizontalGeoreferenceVerified": true,
      "verticalDatumVerified": true
    },
    "notes": "Record exactly what was independently inspected and measured."
  }
}
\`\`\`

Hash values can be collected in PowerShell:

\`\`\`powershell
(Get-FileHash .\.building-engine\jobs\<building-id>\<job-id>-workflow\model.glb -Algorithm SHA256).Hash.ToLowerInvariant()
(Get-FileHash .\review\<evidence-file>.json -Algorithm SHA256).Hash.ToLowerInvariant()
\`\`\`

The sample coordinates, names, IDs, notes and hashes are placeholders, not verified data for a real building. The evidence path is used by the local command and is **not copied into the public catalog**; the catalog stores an evidence ID and checksum only. Use a team ID or public reviewer handle rather than a private person's name.

## Important limitations

- The job publication endpoint is operator-token protected, but it is not a multi-user identity-provider or role-based approval service. The catalog remains a public static JSON catalog, not private object storage.
- Review booleans are human-supplied attestations. The command checks that they are explicit and that files match hashes; it cannot independently prove copyright permission, building identity, architectural fidelity, metric scale, surveyed coordinates or vertical-datum correctness.
- The catalog uses WGS84 longitude/latitude plus height in the map's configured reference. Verify the height datum and local axes before publication.
- An asset under \`public/models/generated/\` is publicly served when the site is deployed. Do not publish private, licensed-restricted or personally identifying evidence.
- Manual/development preview remains available in the map panel and bypasses the catalog. Production use should load from the published catalog.
- Model versions are retained for rollback; cleanup of old files is intentionally manual to avoid deleting assets still referenced by a deployed catalog.


The map-side media intake and job tracker are documented in [D3M-03](D3M-03-MAP-IMAGE-INTAKE-AND-JOB-TRACKING.md). This intake creates private generation candidates; it does not bypass review or publish a generated GLB.