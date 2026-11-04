# D3M-ENGINE-07 — Single-image generation artifact receipt

**Tracking issue:** [#356](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/356)  
**Implementation branch:** `feat/d3m-engine07-generation-artifact-receipt-20261104`  
**Base:** D3M-ENGINE-06 PR [#355](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/355)  
**Smoke report schema:** `1.4.0`  
**Receipt schema:** `1.0.0`

## Gap closed

D3M-ENGINE-05 binds the exact TripoSR config/checkpoint and rembg model bytes to their loader APIs. D3M-ENGINE-06 binds the exact selected source-image bytes to the Pillow decoder. The runtime smoke already hashes the produced GLB and independently recomputes GLB geometry QA. D3M-ENGINE-07 combines these facts with the exact on-disk media-to-model workflow report in a distinct write-once receipt.

## Receipt layout and bindings

A successful new smoke writes:

`.building-engine/runtime-smokes/<jobId>.artifact.json`

The file is created exclusively (`wx`); an existing receipt is never overwritten. On POSIX systems the file is owner-only (`0600`). The JSON envelope contains the canonical payload and its SHA-256. The smoke report schema 1.4.0 stores only a relative receipt path, byte length, full-file SHA-256 and payload SHA-256.

The receipt payload binds:

- building and job identity;
- the exact on-disk `workflow-report.json` path, byte length, SHA-256, status and single-image mode;
- source ID, MIME type, byte length, SHA-256 and D3M-ENGINE-06 Pillow decoder receipt;
- D3M-ENGINE-04 pre/post worker fingerprint snapshots and stable status;
- all three D3M-ENGINE-05 loader receipts;
- the exact GLB relative path, format, byte length, SHA-256 and mesh count;
- GLB geometry-QA schema/engine, status, warning list and verified count summary.

The writer checks that the workflow report exists at the exact job path, is a regular non-symlink file inside the workspace, is bounded to 1 MiB, and its parsed content matches the workflow result returned in memory before the hash is recorded. The output receipt and workflow report paths contain no absolute worker/cache paths.

## Independent verification

The independent runtime-smoke verifier re-reads the receipt, checks file permissions and exact bytes/hash, validates the canonical payload digest and rejects an unexpected field set. It then re-reads and hashes the referenced workflow report and checks job/building/source identity, the selected single source, workflow release flags, and the exact GLB linkage. Existing source/GLB disk verification and independent geometry-QA recomputation still run; the receipt payload must match those freshly observed values, not merely the smoke report's claims.

Missing receipts, reused receipt paths, symlinks, oversized files, non-canonical envelopes, changed receipt bytes, changed workflow-report bytes, changed source/GLB bytes, wrong identities, substituted output paths, or mismatched loader/QA evidence fail closed.

## Compatibility

The verifier retains legacy support for smoke schemas `1.0.0` through `1.3.0`. Those reports are explicitly returned with `generationArtifactReceiptStatus: "not-recorded-legacy-schema"`; the verifier does not synthesize a receipt for old runs. Only schema `1.4.0` requires a valid generation artifact receipt.

## Commands

Run a fresh authorized smoke with a new job ID as documented in [D3M-05 runtime smoke](./D3M-05-SINGLE-IMAGE-RUNTIME-SMOKE.md). The smoke output includes `generationArtifactReceipt`.

Verify the report and receipt independently:

```bash
node scripts/verify-single-image-runtime-smoke.mjs <workspaceRoot> <jobId>
```

The verifier output should include `generationArtifactReceiptStatus: "verified"` and the receipt's relative path, bytes, file SHA-256, payload SHA-256 and workflow-report SHA-256.

## Trust limits and release gates

This is a local write-once/hash-bound integrity receipt, **not** a digital signature, trusted timestamp, hardware attestation, WORM storage, authorization record or protection against an actor who can rewrite both files and recompute every hash. Preserve the restricted worker workspace and keep any later signature/trusted-storage layer separate.

The receipt does not establish image rights, TripoSR/rembg licence permission, building identity, actual worker trustworthiness, architectural fidelity, physical dimensions, scale, orientation, WGS84 georeferencing, vertical datum or survey truth. CI fixtures remain synthetic and are not real worker-host inference.

Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false until their independent human, rights, survey and release checks are satisfied. Do not merge or retarget parent PRs #351/#353/#354/#355 as part of this milestone.
