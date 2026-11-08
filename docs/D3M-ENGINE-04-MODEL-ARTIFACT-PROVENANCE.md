# D3M-ENGINE-04 — Exact worker model-artifact provenance

**Tracking issue:** [#352](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/352)
**Stack:** based on D3M-ENGINE-03 PR #351; do not promote this branch independently to `main` before its parent is integrated.
**Status:** implementation branch in progress; exact-head CI and human review pending. No real worker-host inference is claimed.

## Verified problem

D3M-ENGINE-02 previously recorded TripoSR config/checkpoint cache presence, byte lengths and snapshot revision; rembg model ID and byte length; and the TripoSR runner script SHA-256. It did not hash the exact config/checkpoint/rembg model-file bytes. D3M-05 recorded source and GLB hashes but did not bind the local model cache bytes used around inference.

## Implemented contract

- Worker inventory schema is now `1.1.0`.
- The Python inventory probe streams each config/checkpoint/rembg model artifact through SHA-256 in 8 MiB chunks; the whole model file is never loaded into memory.
- File descriptors and path metadata are checked before and after hashing: device, inode, size, modification time and change time. A missing file returns `missing`; a non-regular, changing, replaced or unreadable file returns `unknown` and fails closed.
- The inventory returns only status, byte length, SHA-256 and TripoSR snapshot revision. It never serializes model-cache paths or model bytes.
- D3M-05 smoke schema `1.1.0` records the redacted pre-inference and post-inference runner/model fingerprints. It blocks before inference if the initial inventory is incomplete, and fails the smoke if the post-inference inventory is incomplete or any runner/model fingerprint changes.
- The independent smoke verifier validates digest formats, positive byte counts, matching TripoSR snapshot revisions, canonical inventory timestamps and exact equality of all pre/post fingerprints.
- Existing smoke schema `1.0.0` reports remain verifiable for source/GLB integrity, but the verifier labels them `not-recorded-legacy-schema`; they are not upgraded or treated as having model-byte evidence.
- Inventory hash timeout is bounded from 1,000 to 180,000 ms; the standalone inventory and D3M-05 smoke default to 180,000 ms. Hashing time is proportional to the total model cache size.

## Commands

Standalone worker inventory on the provisioned host:

```powershell
node scripts/collect-generation-worker-host-inventory.mjs --python "<worker-python>" --runner-script "<TripoSR-run.py>" --device cuda:0 --timeout-ms 180000
```

Real D3M-05 smoke accepts `--inventory-timeout-ms 180000` in addition to its existing source/model rights and operation confirmations. Use a fresh smoke job ID, source ID and authorized input image. Keep the image, cache, worker JSON, GLB and raw logs inside the private worker workspace.

## Validation added

- Inventory unit fixtures require all three exact file digests and reject missing/malformed digests.
- A Python helper test executes the generated streaming hash function against an 8 MiB-plus fixture, checks its SHA-256 against Node's independent digest, confirms the TripoSR snapshot revision, and verifies the returned JSON does not contain the absolute file path.
- D3M-05 fake-workflow tests require model hashes before/after inference, reject missing fingerprints before workflow invocation, and fail when a model hash drifts during inference.
- Independent verifier test mutates a post-inference model hash and requires verification rejection.
- Existing D3M-05 workflow and verifier still keep all release flags false.

## Evidence limits

Matching pre/post fingerprints show that the observed cache files and runner had the same fingerprints at the two inventory checks. They do not prove which exact bytes the inference process opened, rule out a replace-and-restore event between checks, prove model authenticity/licensing, prove the model loaded successfully, establish building identity or geometry quality, or validate map placement. Hashing establishes byte identity only.

Real worker-host inference, asset/model licence approval, independent survey/CAD/BIM/LiDAR truth, authorized reviewer provisioning and Cesium visual acceptance remain separate gates. Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false.

## Branch continuation

- Base: D3M-ENGINE-03 PR #351 head `e4277acccb5ffa61866a5c10c72a03e88dc1fcc8`.
- Feature branch: `feat/d3m-engine04-model-artifact-provenance-20261104`.
- Tracking issue: #352.
- Do not merge #351 or this stacked change automatically. Require exact-head CI, independent code review and the parent PR's approval path.


## Exact-head validation and follow-on boundary — 2026-11-04

The D3M-ENGINE-04 head `53f9887834cfe960ea8875d6fc7d074430400611` completed exact-head Full CI successfully in [run #41789187557](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41789187557). The full Lint and production build job, including production viewport/API/browser verification, ended successfully. This validates the D3M-ENGINE-04 software contract and synthetic test paths only. PR #353 remains open/draft and stacked on PR #351; no merge to `main` was performed.

The remaining evidence boundary identified by the next audit is tracked separately in [D3M-ENGINE-05 issue #354](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/354): D3M-ENGINE-04 pre/post cache fingerprints do not alone prove which exact bytes the inference process handed to model-loader APIs. D3M-ENGINE-05 adds process-side loader receipts in smoke schema 1.2.0. See `docs/D3M-ENGINE-05-PROCESS-MODEL-LOAD-ATTESTATION.md` for its separate contract and limitations. Neither change constitutes real worker-host inference, independent review or publication eligibility.
