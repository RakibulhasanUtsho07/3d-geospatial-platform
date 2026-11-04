# D3M-ENGINE-06 — Exact source-image decoder attestation

**Tracking issue:** [#355](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/355)  
**Implementation branch:** `feat/d3m-engine06-source-image-load-attestation-20261104`  
**Base:** D3M-ENGINE-05 PR [#354](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/354), itself stacked on D3M-ENGINE-04 PR #353 and D3M-ENGINE-03 PR #351.  
**Smoke schema:** `1.3.0`  
**Status:** implementation and exact-head CI pending.

## Why this is a separate gate

The D3M-05 smoke verifies the selected source file in Node before it starts the media-to-model workflow. The single-image worker then launches TripoSR with a filesystem path. The Python runner opens that path later. A path replacement between the earlier Node fingerprint and the Python decoder read could make the model consume different bytes from the source SHA-256 recorded in the smoke report.

D3M-ENGINE-05 closes the corresponding gap for the TripoSR config/checkpoint and rembg ONNX model loaders. It does not prove the actual source image bytes supplied to Pillow. D3M-ENGINE-06 extends the process-side evidence to the image decoder boundary.

## Contract

The smoke passes a private source-image receipt destination and expected source digest/byte count only to the exact TripoSR child process. The expected path is derived from the exact source argument in the runner invocation; paths are not placed into receipts or the public-facing smoke report.

The temporary Python `sitecustomize.py` patches the supported `PIL.Image.open` boundary. When the selected source is opened, the hook:

1. Resolves the source path and requires it to match the runner's expected source argument.
2. Opens the regular file through one descriptor, applies the 20 MiB bound, checks descriptor/path identity and modification metadata before and after the read, and reads the full byte sequence.
3. Computes SHA-256 and byte length and requires both to match the source image fingerprint recorded before inference.
4. Passes a new in-memory `io.BytesIO` over those exact captured bytes to the original Pillow decoder. Subsequent opens of the same source reuse the cached immutable bytes rather than reopening the filesystem path.
5. Writes a private, path-redacted receipt event with schema `1.0.0`, role `sourceImage`, loader `PIL.Image.open`, byte count, SHA-256 and stable/exact-bytes booleans.

Unsupported inputs, a different source path, unstable file identity, a digest mismatch or missing instrumentation evidence must fail closed. The Node smoke requires exactly one valid source-image receipt and binds it to `report.source.bytes` and `report.source.sha256`.

The three D3M-ENGINE-05 loader receipts remain separately required: `omegaconf.OmegaConf.load`, `torch.load` and `onnxruntime.InferenceSession`. The source-image receipt does not replace or relax those checks.

## Report and verifier

Smoke report schema `1.3.0` adds `sourceLoadEvidence`. The independent verifier requires:

- schema `1.0.0` receipt and exactly one source-image event;
- loader `PIL.Image.open` and role `sourceImage`;
- positive byte count and valid SHA-256 matching `report.source`;
- `exactBytesPassed=true` and `stable=true`.

The verifier continues to accept legacy smoke reports:

| Smoke schema | Worker pre/post fingerprints | Model loader receipts | Source-image loader receipt |
|---|---|---|---|
| `1.0.0` | No | No | No |
| `1.1.0` | Yes | No | No |
| `1.2.0` | Yes | Yes | No |
| `1.3.0` | Yes | Yes | Required |

Older reports are explicitly labelled as lacking source-image loader evidence; they are never upgraded or backfilled implicitly.

## Regression coverage

The fixture suite must prove that:

- Pillow receives an in-memory buffer with the exact expected bytes, not the original path.
- Repeated opens reuse the same captured source bytes and create one receipt event.
- The normal `from PIL import Image` and dynamic `importlib.import_module('PIL.Image')` import patterns are observed.
- A mismatched source digest raises before the original decoder executes and writes no receipt.
- A missing receipt blocks the Node smoke.
- The independent verifier rejects a tampered source digest or malformed source-load evidence.
- Existing model config/checkpoint/rembg attestation tests continue to pass.

Fixtures use stub Python modules and synthetic bytes only. They do not download model weights or represent real TripoSR inference.

## Trust limits and release gates

This is process-side Pillow API instrumentation, not OS/hardware attestation, a sandbox or proof that a malicious runner cannot replace the instrumentation. A runner revision that bypasses the instrumented Pillow API or switches to an unsupported decoder must fail closed and be reviewed rather than silently accepted.

This evidence establishes which bytes were passed to the instrumented decoder. It does not prove source-owner permission, licence compliance, same-building identity, building architecture, metric scale, heading, georeferencing, survey truth or representative inference accuracy. It does not replace independent GLB inspection or human review.

Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false. Real worker-host inference, rights clearance, model-weight terms, independent survey/CAD/BIM/LiDAR truth, held-out checkpoints, trusted reviewer provisioning and human Cesium inspection remain separate gates.
