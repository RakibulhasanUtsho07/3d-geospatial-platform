# Building accuracy evidence pack (P3.2)

This tool evaluates a two- or three-building pilot. It does not reconstruct geometry and cannot authenticate a survey, building identity, or image license. It links the existing dimension/GCP benchmark, GLB geometry QA, deterministic render manifest, independent references and human review.

## Pilot acceptance

- Two buildings: one complex landmark plus one ordinary low-rise or high-rise.
- Three buildings: one complex landmark, one ordinary low-rise and one ordinary high-rise.
- At least four source assets and four independent reference images per building, covering front/back/left/right. Document permissions and source identity.
- Measured dimensions must come from surveyed or published measurement evidence. Horizontal control coordinates must be bound to the exact candidate GLB. Record vertical datum separately; unresolved elevation remains incomplete.
- Render all 13 fixed views: front, back, left, right, top and turntable at 0/45/90/135/180/225/270/315 degrees. Hash the GLB, manifest, each PNG and each reference image. Human review must map every view to the correct reference hash.

## Run it

Copy the JSON template to a manifest under the repository and fill each path and evidence field. All paths are relative to the project root. Put independent dimension/GCP evidence in each per-building benchmark config. Create the 13-view manifest with the existing Blender review runner, and add the human-authored reference review report path to the benchmark config.

Run the unit tests and then generate a report:

    npm run test:building-accuracy-evidence-pack
    npm run build:building-accuracy-evidence-pack -- docs/evidence/building-accuracy-pilot.json artifacts/accuracy-pack/report.json --root=.

First run with missing expected hashes is incomplete by design. Review the generated digests and pin the expected GLB, source, reference and render-manifest SHA-256 values in the input manifest, then rerun. A supplied hash mismatch stops the runner. Empty/missing evidence is incomplete; invalid geometry, explicit view mismatches, stale model bindings or failed measurements fail closed.

## Result policy

The report does not calculate one combined accuracy percentage. It reports dimension/georeferencing benchmark, horizontal GCP residuals, vertical datum, geometry QA, source coverage, rights metadata, render integrity and human review separately. Rights and survey provenance fields are operator-attested: file hashes prove which bytes were reviewed, not that the asserted evidence is true.

Even a complete pack reports benchmark-passed-review-required. The report always leaves mapReady, publicationEligible and automaticApproval false. A green CI run validates only this evaluator, not the accuracy of a real building. No real-building pack is passed until actual source files, verified measurements and human reviews exist.
