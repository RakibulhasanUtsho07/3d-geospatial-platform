# Loading a Generated Building GLB into the 3D Map

The \`/map\` view has two clearly separated paths:

- **Published model catalog** — load the active version of a reviewed GLB listed in \`public/models/generated/manifest.json\`. This is the preferred path for deployment.
- **Manual / development preview** — load a local static GLB by URL and enter its placement manually. This bypasses the publication catalog and is intended for local QA only.

Neither path runs the generation pipeline in the browser. The map panel does not upload files, inspect private workspace files, infer true scale or georeference a GLB.

## Preferred workflow: publish a reviewed version

### 1. Generate a candidate

For a BuildingSpec with a known footprint and dimensions:

\`\`\`powershell
npm run test:building-generation
npm run generate:building-model -- .\\building-spec.json .\\artifacts\\my-building.glb
\`\`\`

For the staged media workflow, follow [Building Generation Engine](BUILDING-GENERATION-ENGINE.md). It writes review candidates under \`.building-engine/jobs/<buildingId>/<jobId>-workflow/\`.

### 2. Review and prepare an attestation

Inspect the actual GLB and review evidence: source rights and identity, architectural shape and facade, independently measured dimensions, model scale, horizontal WGS84 placement, and vertical datum. Keep an evidence file/package inside your local workspace.

The publish command requires a JSON attestation with the exact candidate SHA-256, the evidence-file path and SHA-256, reviewer identity, timestamp, notes, and all six explicit checks set to \`true\`:

- \`rightsVerified\`
- \`sourceIdentityVerified\`
- \`architectureReviewed\`
- \`metricScaleVerified\`
- \`horizontalGeoreferenceVerified\`
- \`verticalDatumVerified\`

Example structure and exact field names are in [Published Generated Model Workflow](PUBLISHED-GENERATED-MODEL-WORKFLOW.md). Example coordinates and review values in the documentation are placeholders; use only real, checked values.

PowerShell can compute the file digests:

\`\`\`powershell
(Get-FileHash .\\.building-engine\\jobs\\<building-id>\\<job-id>-workflow\\model.glb -Algorithm SHA256).Hash.ToLowerInvariant()
(Get-FileHash .\\review\\<evidence-file>.json -Algorithm SHA256).Hash.ToLowerInvariant()
\`\`\`

### 3. Publish the candidate and version

Run from the project root:

\`\`\`powershell
npm run publish:building-model -- . .\\.building-engine\\jobs\\<building-id>\\<job-id>-workflow\\model.glb .\\review\\<attestation>.json
\`\`\`

The command verifies the actual candidate bytes, evidence bytes, GLB 2.0 container, catalog structure and placement constraints. It copies a content-addressed GLB into \`public/models/generated/\` and updates \`public/models/generated/manifest.json\` with a version record. If the same model ID has an existing release, the new version becomes active and earlier versions are retained.

This is a **local publication-to-static-files command**, not website deployment. Commit/deploy the generated GLB and manifest together for a hosted site to serve the new catalog.

### 4. Load the published model

Run the app and open [http://localhost:3000/map](http://localhost:3000/map). Open **Generated models → Published model catalog**, refresh the catalog if needed, select the building, then choose **Load published model**. The panel displays its active version ID and recorded checksum.

The catalog is versioned in the manifest, but models currently loaded into Cesium remain session-only; refreshing the page clears the in-memory map instances and you can load them again from the catalog.

### 5. Roll back a published version

If a newer version has a problem, read its prior \`versionId\` from the manifest and run:

\`\`\`powershell
npm run activate:building-model-version -- . <model-id> <previous-version-id>
\`\`\`

The command verifies the selected static GLB still matches its recorded SHA-256 before changing the catalog's \`activeVersion\`. Commit/deploy the changed manifest for a hosted deployment.

## Manual / development preview

Use this for initial visual checks before publication. Place the review candidate under \`public/models/generated/\` only in a local development checkout, start the app, and in **Manual / development preview** enter the static path and explicit placement:

- Model URL, such as \`/models/generated/my-building.glb\`
- A unique stable model ID
- Reviewed longitude and latitude
- Height in metres relative to the map's configured ellipsoid/reference
- Heading and explicit scale multiplier

This path bypasses the published catalog and its publication attestation. Do not use it as a substitute for publishing/reviewing an asset for production.

## Important limitations

- The publish command records an operator's review attestation. It checks file hashes and required fields, but it cannot independently prove copyright permission, correct building identity, historical/architectural accuracy, real-world dimensions, survey precision or vertical-datum correctness.
- Any GLB under \`public/\` is publicly served when the site is deployed. Do not put private evidence or restricted material there; the evidence file itself is not copied into the public catalog.
- The published catalog stores public metadata and an evidence identifier/checksum, not private review files.
- Current publishing is a local CLI plus a static JSON manifest, not an authenticated Admin UI, role-based approval workflow, private object store, background job system or database-backed asset service.
- The loader does not solve placement automatically. The operator must supply valid coordinates, axes, heading, scale and height.
- External HTTPS assets in manual preview must be trusted and reachable by the browser; network or CORS restrictions can block them.
- A successful Cesium load means only that the model loaded. It is not evidence of survey quality or architectural correctness.

## Verification

\`\`\`powershell
npm run test:generated-model-policy
npm run test:published-model-catalog
npm run test:building-generation
npm run test:media-to-model-workflow
npm run lint
npm run build
\`\`\`

CI exercises the publication catalog checks—including checksum mismatch rejection and version rollback—alongside the existing generation, geometry QA and production build suites.
