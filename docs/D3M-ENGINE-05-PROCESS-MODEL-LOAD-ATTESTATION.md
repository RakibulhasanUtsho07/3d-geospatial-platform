# D3M-ENGINE-05 — Process-side model-load attestation

**Tracking issue:** [#354](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/354)  
**Stack:** D3M-ENGINE-05 is based on D3M-ENGINE-04 branch \`feat/d3m-engine04-model-artifact-provenance-20261104\`, which is stacked on D3M-ENGINE-03 PR #351. Do not promote this branch directly to \`main\`.  
**Status:** implementation and fixture tests are committed; exact-head CI and independent review are pending. No real worker-host inference is claimed.

## Why this milestone exists

D3M-ENGINE-04 adds exact SHA-256/byte-count fingerprints for the TripoSR config, TripoSR checkpoint and active rembg weights. D3M-05 records those fingerprints before and after the inference workflow and fails if the observed worker cache changes.

That establishes which bytes the inventory observed. It does not prove which bytes the inference process handed to its loader functions. D3M-ENGINE-05 adds process-side receipts at the loader boundary, matched to the D3M-ENGINE-04 pre-inference snapshot.

## Instrumented loader contract

The exact Python process started for the TripoSR runner gets a private temporary receipt path and a compact JSON map of the three expected pre-inference fingerprints. A temporary \`sitecustomize.py\` wraps the supported loader APIs:

| Role | Loader API | Evidence behavior |
|---|---|---|
| TripoSR config | \`omegaconf.OmegaConf.load\` | Hashes the regular file through one open descriptor, checks its file identity/metadata, and hands that same descriptor to OmegaConf |
| TripoSR checkpoint | \`torch.load\` | Hashes the regular file through one open descriptor, checks its file identity/metadata, and hands that same descriptor to PyTorch |
| rembg weights | \`onnxruntime.InferenceSession\` | Reads a regular ONNX file into one immutable bytes object, hashes that object, and passes that exact object to ONNX Runtime |

For the TripoSR files, the descriptor is hashed again after the loader returns. The file must still have the same device, inode, byte count, modification time and change time, and the second digest must match the first. Unsupported mmap checkpoint loading fails closed.

For rembg, the model is limited to 512 MiB; larger files, non-regular files and unstable reads fail closed. This intentionally uses memory up to the ONNX file size so the exact immutable bytes hashed are also the bytes passed to ONNX Runtime. Operators must provision sufficient RAM headroom.

A loader event is written only when the digest and byte count match the expected pre-inference inventory fingerprint. The smoke then requires all three roles. If a hook is bypassed, a loader signature changes, a model hash differs, or a receipt is missing/malformed, the smoke fails and release flags remain false.

## Receipt and report handling

The receipt is newline-delimited JSON in the private temporary directory. Each event contains only:

- Schema version, role and loader API identifier.
- Byte count and SHA-256.
- \`exactBytesPassed\` and \`stable\` booleans.

It deliberately excludes file/cache paths, model bytes, usernames, hostnames, environment values and raw loader output. The receipt is created with owner-only mode where POSIX permissions apply. The temporary directory and receipt are removed after the smoke returns; the final private report retains the redacted three-role digest records only.

D3M-05 smoke report schema is now \`1.2.0\`. The independent verifier requires exactly the three supported role/loader pairs and checks their SHA-256/byte counts against \`workerHost.before.modelArtifacts\`. Changing a receipt record or report field after inference causes verification to fail.

The verifier remains backward-compatible with:
- \`1.0.0\`: source/GLB integrity only; no worker model fingerprints.
- \`1.1.0\`: D3M-ENGINE-04 pre/post worker fingerprints; no process-side loader receipts.
- \`1.2.0\`: pre/post worker fingerprints and all three process-side loader receipts.

Older schemas are explicitly labelled as lacking process-side evidence. They are not upgraded or treated as if they contained receipts.

## Tests

The new tests run under the repository's CI Python/Node environment using synthetic files and stub loader modules. They check that:

- OmegaConf receives the same config file descriptor whose bytes were hashed.
- PyTorch receives the same checkpoint file descriptor whose bytes were hashed.
- ONNX Runtime receives the same immutable byte sequence that was hashed.
- Expected hashes and byte counts appear in redacted receipts without paths.
- A checkpoint mismatch produces no valid checkpoint receipt.
- The end-to-end smoke refuses to pass when the rembg loader receipt is missing.
- The independent verifier rejects modified process-side receipt evidence.

These are deterministic fixture tests. They do not execute real TripoSR/rembg model weights, GPU inference or an operator-provisioned worker host.

## Security and evidence limits

This is process-side instrumentation, not cryptographic OS/hardware attestation or a sandbox. It proves which bytes were handed to the instrumented loader APIs when those APIs are used. A malicious or materially changed runner could bypass the Python hooks, import a cached loader reference before instrumentation, or use an alternate API. A supported environment change that avoids an instrumented boundary must therefore fail closed and be investigated; do not remove the requirement to make a smoke pass.

The receipt does not prove:
- Model source authenticity, code/checkpoint/weight licensing, owner permission or commercial-use rights.
- Successful GPU kernel execution or the correctness of model outputs.
- Identity of the real building, architectural fidelity, material/texture quality or geometry accuracy.
- Metric scale, heading, WGS84 placement, vertical datum, survey control or held-out accuracy.
- Reviewer identity/authority, publication approval or map readiness.

No real worker-host run, source-rights clearance, model licence approval, reviewer provisioning, independent survey/CAD/BIM/LiDAR reference or human GLB/Cesium review is supplied by this code change. Keep \`groundTruth\`, \`acceptanceEligible\`, \`publicationEligible\`, \`mapReady\` and \`automaticApproval\` false.

## Branch and validation

- Parent D3M-ENGINE-04 exact-head Full CI: [#41789187557](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41789187557) passed on head \`53f9887834cfe960ea8875d6fc7d074430400611\`.
- D3M-ENGINE-05 branch: \`feat/d3m-engine05-process-model-load-attestation-20261104\`.
- Tracking issue: #354.
- Current D3M-ENGINE-05 CI must run against the final branch head after all documentation and test changes. Keep the PR draft until exact-head CI and independent review are complete.
- Merge order remains D3M-ENGINE-03 → D3M-ENGINE-04 → D3M-ENGINE-05. No branch is to be merged to \`main\` by this milestone.
