# Reviewed Generated Model Publication

Status: explicit local publication command, static versioned catalog, SHA-256 checks, and version rollback are implemented. This is not a hosted admin service or an automatic approval system.

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

- This is a local command and a public static JSON catalog, not authenticated multi-user publishing, role-based approvals, durable server jobs or private object storage.
- Review booleans are human-supplied attestations. The command checks that they are explicit and that files match hashes; it cannot independently prove copyright permission, building identity, architectural fidelity, metric scale, surveyed coordinates or vertical-datum correctness.
- The catalog uses WGS84 longitude/latitude plus height in the map's configured reference. Verify the height datum and local axes before publication.
- An asset under \`public/models/generated/\` is publicly served when the site is deployed. Do not publish private, licensed-restricted or personally identifying evidence.
- Manual/development preview remains available in the map panel and bypasses the catalog. Production use should load from the published catalog.
- Model versions are retained for rollback; cleanup of old files is intentionally manual to avoid deleting assets still referenced by a deployed catalog.
