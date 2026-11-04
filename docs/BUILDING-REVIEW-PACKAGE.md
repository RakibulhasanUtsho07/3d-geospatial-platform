# Building review package

This CLI prepares a new, immutable directory for a final human review. It does not upload, publish or modify the GLB. Only a candidate that has a non-blocked release-readiness report can be packaged.

## Run it

\`\`\`powershell
npm run test:building-review-package
npm run package:building-review -- ".\\candidate.glb" ".\\building-review" ".\\reference-images" ".\\render-reference-review-report.json" ".\\render-correction-tasks.json" ".\\render-correction-verification.json" ".\\building-release-readiness.json" ".\\review-package"
\`\`\`

The render directory must contain the exact \`render-review-manifest.json\` and its PNG images. The reference directory must contain the report's reference image filenames. The CLI re-hashes the candidate, manifest, every render PNG and every reference image; checks dimensions; reruns GLB geometry and texture/UV QA; recomputes correction verification and release readiness; and compares those computations to the saved reports. A changed, missing or stale artifact prevents package creation.

The output directory must not exist beforehand. If packaging fails mid-copy, the newly created output directory is removed. The resulting directory contains the candidate, exact render/reference images, QA reports, task history, release-readiness report, a SHA-256 package manifest and a reviewer README.


Before packaging, recompute release readiness with the required `accuracy-evidence.json` input. The package builder now also accepts that input, recomputes the dimension/georeferencing benchmark, and preserves the source evidence at `reports/accuracy-evidence.json` so its digest can be verified offline.

## Limits

Reference images are included only when their recorded rights status is \`verified\` and their bytes still match the source report. This metadata gate is not legal advice. The package is for final human inspection only; \`publicationEligible\` remains \`false\`.

## Optional D3M-08 single-image georeference evidence

A review package may include the exact evidence from one independently verified D3M-08 single-image runtime smoke. Supply both options together after the positional arguments:

~~~powershell
npm run package:building-review -- ".\\candidate.glb" ".\\building-review" ".\\reference-images" ".\\render-reference-review-report.json" ".\\render-correction-tasks.json" ".\\render-correction-verification.json" ".\\accuracy-evidence.json" ".\\building-release-readiness.json" ".\\review-package" --single-image-smoke-workspace "D:\\BuildingEngineWorkspace" --single-image-smoke-job-id "your-smoke-job-id"
~~~

The builder runs the independent smoke verifier before and after collecting the evidence. It requires smoke schema 1.5.0, a verified generation-artifact receipt, the exact control-point manifest, a successful horizontal registration, matching building ID and candidate GLB SHA-256. It copies the exact smoke report, receipt, workflow report and manifest bytes into the review package and records their hashes in the package manifest. The offline integrity verifier re-hashes those files, cross-checks the smoke/receipt/workflow bindings, and recomputes the horizontal registration from the packaged manifest bytes.

The two options are paired: supplying only one is rejected. When omitted, the package remains a normal review package with no single-image evidence group. A partial evidence group is rejected. The package signature, when used, covers the resulting evidence references and hashes because they are part of the exact signed package-manifest bytes.

This is still human review evidence, not surveyor authentication or proof of physical feature correspondence. Horizontal registration does not solve height/elevation; vertical datum remains `not-solved`. The candidate remains unpublished and `publicationEligible`, `mapReady` and `automaticApproval` remain `false`.
