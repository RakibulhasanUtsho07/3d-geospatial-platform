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
