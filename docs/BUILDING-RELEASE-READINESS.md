# Building release readiness gate

This step joins fresh GLB geometry/texture QA with render-manifest, render/reference-review and correction-verification evidence. Its output is a traceable readiness report; it never publishes the model or edits the candidate asset.

## Run it

Use the exact GLB revision from which the latest Blender render set was generated. The render directory must contain `render-review-manifest.json`.

```powershell
npm run test:building-release-readiness
npm run assess:building-release-readiness -- ".\\candidate.glb" ".\\building-review" ".\\render-reference-review-report.json" ".\\render-correction-tasks.json" ".\\render-correction-verification.json" ".\\building-release-readiness.json"
```

The output is created exclusively; if the path already exists, the CLI refuses to overwrite the earlier report. Choose a new output path for every candidate revision.

## Read the decision

- `blocked`: one or more evidence, QA, coverage, rights or task-verification gates failed.
- `ready-for-final-human-review-with-warnings`: hard gates passed, but geometry, texture or render QA reported warnings that need human review.
- `ready-for-final-human-review`: automated evidence gates passed with no recorded warnings. This still requires a release reviewer.

The CLI computes geometry and texture/UV QA from the candidate GLB bytes itself. It checks the candidate SHA-256 against the render manifest and reference review; binds render and reference comparisons to their recorded image hashes; requires all predefined render views to have a human-reported direct-basis `match`; checks reference rights status; and verifies that correction-review tasks have reached their required terminal states using the exact backlog and review report digests.

## Non-negotiable limitations

`publicationEligible` is always `false`. A direct-basis, human-reported match does not independently prove architectural accuracy, historical fidelity, correct georeferencing, or that the model is ready for public distribution. The output is a release-review checklist, not an automatic publication approval. The report does not contain or modify copyrighted model/reference assets.
