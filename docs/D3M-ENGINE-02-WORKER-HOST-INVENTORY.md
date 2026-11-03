# D3M-ENGINE-02 — Worker host inventory and real-runtime proof

**Status:** host inventory tooling implemented; actual worker-host inference is an operator gate, not completed by CI.

## Why this task exists

D3M-04/05/07 already provide a bounded single-image readiness probe, a hash-bound one-image runtime smoke, and an independent smoke verifier. They do not produce a consolidated host snapshot with CPU/RAM/GPU, Python/package versions, ONNX providers, a runner source hash and exact local TripoSR/rembg cache states. Operators otherwise need to assemble these facts manually, increasing the risk of mismatched Python environments or incomplete evidence.

This inventory is a preflight aid. It does not replace the D3M-04 readiness gate or D3M-05 real inference smoke.

## Command

From the repository root on the actual provisioned worker host:

~~~powershell
node scripts/collect-generation-worker-host-inventory.mjs --python "<worker-python>" --runner-script "<TripoSR-run.py>" --device cuda:0
~~~

Use `--device cpu` or `--device mps` when appropriate. The tool writes one sanitized JSON report to stdout. Save it only in the access-controlled private worker workspace; do not commit it or upload raw source/model artifacts to GitHub.

To check syntax and usage without running a probe:

~~~powershell
node scripts/collect-generation-worker-host-inventory.mjs --help
~~~

## What the inventory records

- OS platform/release/architecture; CPU model/count; total/free system memory.
- Node.js and Python version/implementation/platform.
- Installed Torch, ONNX Runtime, rembg, Hugging Face Hub and Transformers package versions when available.
- CUDA availability/runtime and visible GPU names, total VRAM and compute capability; ROCm version; Apple MPS availability; ONNX execution providers.
- TripoSR runner regular-file status, byte length and SHA-256; the Python probe checks that the bytes it syntax-compiles still match that Node-side fingerprint.
- TripoSR `config.yaml` and `model.ckpt` cache byte lengths and their shared Hugging Face snapshot revision (40-character commit); the file paths are never returned.
- rembg default model ID and cached weight byte length from the session class' read-only resolver.
- D3M-04 strategy readiness and cache statuses; missing cache identity or mismatched TripoSR snapshot revisions fail closed.

The report deliberately excludes hostname, username, executable/runner/cache paths, environment values, credentials and raw stdout/stderr. It stores no model weights and performs no model inference.

## Limits and safety

- The tool invokes the authoritative D3M-04 capability probe for only `single-image-ai`; it does not execute unrelated COLMAP readiness checks.
- Imports of PyTorch, ONNX Runtime and rembg execute installed package initialization and can have package-specific side effects. The process sets Hugging Face offline/telemetry flags, but this is not a kernel network firewall, an OS sandbox or a hermetic no-write guarantee.
- A `ready-for-operator-smoke` result means only that this snapshot observed the configured runtime/device and both caches as ready. It does not show that the TripoSR process can complete, that model-weight licensing is approved, or that the resulting GLB is architecturally accurate.
- Model and checkpoint licences remain separate operator/legal gates. Review the exact TripoSR code/checkpoint and active rembg weight terms before smoke execution.
- The runner SHA-256 binds the script file bytes. The TripoSR snapshot revision identifies the cached config/checkpoint revision but is not a byte hash of the weight file; the rembg entry records model ID and byte length but not a weight-file hash. Record the actual repository revision, model identifiers and licence basis separately in the D3M-05 evidence log.
- A fresh D3M-05 smoke must still use fresh job/source IDs, an already-stored rights-cleared JPEG/PNG image, four independent operator confirmations, cached weights and the independent smoke verifier.

## Operator evidence sequence

1. Run this inventory on the actual worker host, saving the sanitized JSON in the restricted workspace.
2. Confirm its Python executable is the same environment used by the worker service; paths are intentionally not included in the report.
3. Review exact source reuse rights, the permitted operation scopes, single-view inference consent, TripoSR code/checkpoint terms and rembg model-weight terms.
4. Confirm the inventory reports both model caches as `cached` and the selected device is actually available.
5. Run the existing D3M-05 one-image workflow on a fresh job/source with host-level egress controls when strict no-egress is required.
6. Run `npm run verify:single-image-runtime-smoke -- "<workspace>" "<fresh-job-id>"`.
7. Open the resulting GLB in an independent viewer. Record dimensions, geometry defects, warnings and the human disposition in `docs/evidence-templates/D3M-05-REAL-WORKER-SMOKE-LOG.md` or the operator's private equivalent.

No CI fixture or synthetic GLB counts as this real-host proof. The output remains private; `mapReady`, `publicationEligible` and `automaticApproval` remain false.
