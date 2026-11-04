# D3M-05 — Offline single-image runtime smoke

**Tracking issue:** [#307](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/307)  
**Source integration:** D3M-05 implementation is integrated into `main` through cumulative promotion PR [#325](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/325). The original implementation PR [#308](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/308) is closed as superseded, not merged independently.  
**Worker-host tooling:** inventory/preflight added to `main` through [D3M-ENGINE-02 PR #347](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/347). D3M-ENGINE-04 extends the inventory and smoke evidence with exact TripoSR/rembg model-file fingerprints on a stacked feature branch; this follow-up is not yet merged.  
**Status:** Implementation and automated CI validation are complete on `main`; the real TripoSR/rembg worker-host inference, independent GLB verification and human inspection are **not run**. Never call the runtime smoke passed until those operator-host steps succeed.

## Purpose and contract

D3M-04 checks whether the configured worker can safely claim a single-image AI job. D3M-05 adds one explicit, operator-invoked inference smoke that traverses the same **runMediaToModelWorkflow** path as the durable queue worker.

The command does not introduce a second TripoSR implementation, does not auto-download missing models, and does not publish the candidate to Cesium. It requires a fresh job ID and source ID; if the corresponding source record or workflow/TripoSR artifact directory already exists, it refuses to reuse that state so a smoke cannot silently pass from a cached prior inference. It writes a private, hash-bound smoke report under:

~~~text
<workspaceRoot>/.building-engine/runtime-smokes/<jobId>.json
~~~

A successful result means only that this one input completed one inference/export on the selected host with the recorded settings. The smoke must observe the TripoSR child process's `spawn` event, and the independent verifier requires both runner-launch evidence flags. A process-spawn event proves that the operating-system process started; it does not by itself prove model quality or architectural accuracy. Geometry warnings still require review. It is not a representative building benchmark and does not establish architectural accuracy, measured scale, front orientation, surveyed WGS84 placement, vertical datum or release readiness.

## Required host prerequisites

Provision the actual worker host first:

- A persistent private BUILDING_ENGINE_WORKSPACE directory with enough free disk for the source, intermediate TripoSR files, the resulting GLB and workflow evidence.
- The TripoSR repository/revision and its run.py entry point, using a Python environment with compatible PyTorch, ONNX Runtime, rembg and TripoSR dependencies.
- The required TripoSR config.yaml and model.ckpt files already present in the selected Python user's Hugging Face cache.
- The effective default rembg model used by the installed rembg.new_session() already present in that same Python environment's model cache.
- A compatible CPU, CUDA device or Apple MPS runtime. The smoke records the configured device; it does not guarantee a CUDA kernel or VRAM capacity before actual inference.
- One non-empty JPEG or PNG source image already stored inside the private workspace, its actual licence/permission basis, and a valid BuildingSpec for the same building ID.
- Explicit operator review of the installed TripoSR code/checkpoint licence and the actual rembg model-weight licence. Package licence and model-weight licence are separate.

Do not assume that the default rembg model is commercially licensed for every use. The current rembg upstream README identifies `bria-rmbg` as the default and notes that its weights require a paid agreement for commercial use; it also states that model-weight licences are separate from rembg's MIT package licence. Verify the model name and licence for the exact installed rembg release before the run. The BRIA RMBG 2.0 model card identifies the self-hosted weights as CC BY-NC 4.0 / non-commercial, with commercial deployment requiring a separate BRIA agreement. The TripoSR model card currently identifies TripoSR as MIT-licensed; still check the exact installed repository revision and checkpoint notices.

- [rembg upstream model defaults, cache locations and model-weight licensing](https://github.com/danielgatis/rembg#models)
- [BRIA RMBG 2.0 model card and terms](https://huggingface.co/briaai/RMBG-2.0)
- [TripoSR model card and MIT licence](https://huggingface.co/stabilityai/TripoSR)
- [TripoSR upstream repository](https://github.com/VAST-AI-Research/TripoSR)

D3M-04's worker health endpoint must report single-image-ai.status=ready, modelWeights=cached and backgroundRemovalWeights=cached before the smoke will start. The smoke performs this preflight again immediately before invoking the workflow.

## Exact worker model-byte provenance — D3M-ENGINE-04

The D3M-ENGINE-04 smoke schema (`1.1.0`) records a redacted worker-host fingerprint snapshot immediately before and after the media-to-model workflow:

- TripoSR runner script byte length and SHA-256.
- TripoSR `config.yaml` byte length, SHA-256 and Hugging Face snapshot revision.
- TripoSR `model.ckpt` byte length, SHA-256 and matching snapshot revision.
- Active rembg model identifier, weight byte length and SHA-256.

The worker inventory hashes model files as regular files in 8 MiB chunks. It compares file identity, size, modification time and change time before/after each read, and fails closed for incomplete or malformed fingerprints. Cache paths and file contents are never written into the inventory or smoke report.

The smoke compares the pre-inference and post-inference fingerprints. A mismatch makes the run fail; a stable pair is retained in the private report. The independent verifier checks the schema, digest formats, positive byte counts, snapshot consistency and exact pre/post equality. Legacy schema `1.0.0` reports can still be integrity-verified, but their result is labelled `not-recorded-legacy-schema` rather than being treated as model-byte fingerprint evidence.

**Evidence limit:** matching snapshots show that the observed cache files and runner had the same fingerprints at the two inventory checks. They do not prove which exact bytes the TripoSR/rembg processes opened, rule out a replace-and-restore event between checks, prove model authenticity/licensing, or establish reconstruction accuracy. The hashes provide byte identity and reproducibility evidence only. Model-weight licensing and human review remain separate.

Hashing reads the full config/checkpoint/rembg weight files twice and adds I/O/CPU time proportional to their combined size. It uses bounded memory rather than loading full model weights. The default --inventory-timeout-ms is 180,000 ms and the supported range is 1,000–180,000 ms; increase from a smaller chosen value when the worker storage is slow. The standalone inventory CLI uses the same 180,000 ms default and bound. No model file is copied or uploaded.
## Operator procedure

Use an isolated test building ID and a test image whose reuse rights permit this inference. The image path must be a workspace-relative path to an already-stored JPEG/PNG file. Do not use a source path outside the worker's shared workspace.

Example (PowerShell; replace every placeholder with a real value from the worker host):

~~~powershell
npm run smoke:single-image-runtime -- "D:\BuildingEngineWorkspace" "D:\BuildingEngineWorkspace\smoke-building-spec.json" "smoke-dhaka-front-20261102" "smoke-dhaka-front-image-20261102" "uploads/smoke-dhaka-front.jpg" --licence "Owner permission recorded in test intake" --triposr-licence-review "Record the TripoSR code and checkpoint licence/terms reviewed" --rembg-licence-review "Record the exact rembg model ID and weight terms reviewed" --runner-script "D:\AI\TripoSR\run.py" --python "D:\AI\TripoSR\.venv\Scripts\python.exe" --device cuda:0 --resolution 256 --timeout-ms 1800000 --inventory-timeout-ms 180000 --confirm-source-rights --confirm-operation-scopes --confirm-single-view-inference --confirm-model-licences
~~~

The example runner path is illustrative; ensure the actual file path is correct. Use a new smoke jobId and sourceId for every run. The operation-scope confirmation is separate from the rights confirmation: it authorizes private-media-ingestion and single-image-ai-reconstruction for that exact source. Evidence files are immutable; an existing source record, job state, workflow artifact directory, TripoSR sub-job directory or smoke report is rejected rather than reused.

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | One inference/export completed and the output/evidence checks passed. Human review is still required. |
| 1 | The TripoSR runner started and generation/export/evidence validation failed, or the workflow failed before the runner process started. The evidence report distinguishes these cases. |
| 2 | Input/configuration/readiness was blocked; inference did not start, or required operator confirmation was missing. |

## Failure classification

- If source intake, provenance, selected-view checks or another workflow stage fails before TripoSR launch, the report records `inference.status=not-started` and `runnerLaunchAttempted=false`.
- If the workflow attempts to launch TripoSR but the operating-system process emits an error before the `spawn` event, the report records `inference.status=not-started`, `runnerLaunchAttempted=true` and `runnerProcessStarted=false`.
- Only after the TripoSR child emits `spawn` can a later workflow/export/evidence failure be recorded as `inference.status=failed`. A passed report and its independent verification both require `runnerLaunchAttempted=true` and `runnerProcessStarted=true`.

## Offline and data-handling boundaries

- Hugging Face, Transformers and datasets offline environment flags are set for the probe/inference Python processes.
- A temporary Python sitecustomize.py denies Python socket connection, connect-ex, send-to and connection-helper calls for the smoke subprocess tree. The temporary policy file is removed after the invocation.
- This is application-level Python socket blocking, **not** operating-system or kernel network isolation. Run the smoke on a host/network policy that already prevents outbound access when strict isolation is required. The report explicitly records that boundary.
- The readiness preflight uses local-only model-cache resolution. It does not instantiate a rembg session or request weights.
- Source and model artifacts remain inside the private workflow directory. The smoke report contains only relative paths, safe model identifiers, source/output hashes, byte counts, the selected device, sanitized QA summary and redacted model artifact hashes. It does not copy cache paths, model weights, API secrets, or raw subprocess output into the smoke evidence.
- On POSIX hosts, the runtime-smokes evidence directory is enforced as owner-only (0700) and report files are written owner-only (0600). On Windows, Node's mode bits do not provide equivalent ACL isolation; provision the worker workspace with a Windows ACL that grants access only to the worker/operator identities that need the evidence.
- The source-rights and operation-scope confirmations are separate operator attestations. The command also requires separate text records describing the TripoSR code/checkpoint licence terms and the installed rembg model-weight terms reviewed by the operator. These statements are not independent legal verification or proof of a commercial grant.

## Output review checklist

After status=passed:

1. Verify the source and output SHA-256 values in the evidence report against the exact source file and private model.glb.
2. Inspect the worker's workflow report and TripoSR report. Confirm one selected view, the expected model ID/device/resolution, and the actual background-removal flag.
3. Open the GLB in an independent viewer. Inspect topology, detached geometry, normals, texture/material state, scale, orientation and all visible sides. Review geometry-QA warnings rather than treating a valid GLB header as a quality pass.
4. Record separate human review and independent references before making any accuracy claim.

The smoke result itself leaves:

- candidateDisposition=ai-proposed-requires-human-review
- scaleCalibration=not-calibrated unless the underlying workflow explicitly supplied separately reviewed calibration
- georeference=not-solved unless the underlying workflow explicitly supplied separate ground-control evidence
- mapReady=false
- publicationEligible=false
- automaticApproval=false

A smoke pass is not a promotion or publication authorization.

## Independent evidence verification

After the smoke process exits, re-open the on-disk evidence with the separate verifier:

~~~powershell
npm run verify:single-image-runtime-smoke -- "D:\BuildingEngineWorkspace" "smoke-dhaka-front-20261102"
~~~

The verifier independently reads the report, rejects symlinked/out-of-workspace paths, re-hashes the source and GLB, verifies byte counts and GLB 2.0 mesh structure, validates the before/after worker model fingerprints for schema `1.1.0`, and checks that readiness, source operation-scope attestation and release flags remain fail-closed. It detects source/GLB/report fingerprint inconsistencies. This is artifact-integrity verification, not a digital signature: it does not independently prove source/model licences, report author, physical building identity, which cache bytes the inference process opened, or architectural accuracy.

## Automated test scope

npm run test:single-image-runtime-smoke uses a fake workflow and synthetic GLB bytes. It checks the gate for missing/unknown model caches, all four separate operator confirmations, fresh-ID enforcement, JPEG/PNG signature enforcement, the Python offline hook, simulated TripoSR child-process spawn evidence, pre-runner and failed-spawn classification, output hash binding, private report permissions, failure sanitization and evidence immutability. It does **not** exercise real TripoSR weights, rembg/ONNX inference, CUDA/MPS kernels, GPU memory, image-to-building quality or a real operator host.

The D3M-02/03/04/05/06/07 implementation stack has since been reconciled onto `main` through PR #325. The post-promotion `main` CI [#41649268743](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41649268743) passed 207/207 steps on `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`, including the D3M-05 smoke contract test and smoke/verifier CLI checks. This is automated code/test validation only; it is not a real worker-host inference result.

## Operator-host preflight and evidence capture

Before invoking the smoke, confirm that the selected Python executable is the same environment that contains the TripoSR, PyTorch, ONNX Runtime and rembg packages. A local version/device check can catch an obviously wrong interpreter before creating a smoke report:

~~~powershell
& "D:\AI\TripoSR\.venv\Scripts\python.exe" -c "import sys, torch, onnxruntime, rembg; print('python', sys.version); print('torch', torch.__version__); print('onnxruntime', onnxruntime.__version__); print('rembg', getattr(rembg, '__version__', 'version-not-exposed')); print('cuda_available', torch.cuda.is_available()); print('cuda_devices', torch.cuda.device_count() if torch.cuda.is_available() else 0); print('mps_available', bool(hasattr(torch.backends, 'mps') and torch.backends.mps.is_available()))"
~~~

Replace the interpreter path with the actual worker environment. Do not paste private cache paths or environment variables containing credentials into an issue or commit. Choose `--device cuda:N` only when that indexed CUDA device is visible to this interpreter; choose `--device mps` only when PyTorch reports MPS available; otherwise use `--device cpu`. The authoritative D3M-04 probe runs again inside the smoke and rejects a device/cache mismatch.

The command's offline socket guard is not a host firewall. When the test requires strict no-egress, deny outbound traffic at the worker host/network layer before execution. On Windows, apply a restrictive workspace ACL; Node mode bits are not a substitute for ACL enforcement.

After the smoke exits, run the independent verifier against the same private workspace and job ID. Copy the sanitized results into [the D3M-05 real-worker smoke log template](evidence-templates/D3M-05-REAL-WORKER-SMOKE-LOG.md). Keep the original JSON report, source image and GLB in the private workspace. Do not commit or attach those files to the repository; the template records only non-secret metadata and hashes.

## CI and real-host status (2026-11-02)

- D3M-05 implementation branch head `07e122053ff99059b72661e85e4f2e44b2a3c8ac` passed exact-head PR Full CI: [run #41412587662](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41412587662), 182 workflow steps, no failed steps.
- The D3M-06 descendant code head `f8b974465ac6d52b32ada50fb2356844a6f126d8` also passed exact-head PR Full CI: [run #41415299310](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41415299310), 182 workflow steps, no failed steps.
- Both runs use CI fakes/fixtures for the inference workflow. **No real TripoSR/rembg inference, CUDA/MPS execution or building-quality result is claimed.**
- **Remaining operational blocker:** an operator must run this command on the provisioned worker host with the authorized source image and verified model-weight terms, then independently verify and inspect the resulting private GLB. Until that happens, D3M-05 remains a runtime-smoke implementation candidate, not a passed real inference.

## D3M-07 non-inference worker preflight

Before collecting rights attestations or invoking a real smoke, run the dedicated non-inference readiness preflight from the repository root:

~~~powershell
npm run preflight:single-image-worker -- --python "D:\AI\TripoSR\.venv\Scripts\python.exe" --runner-script "D:\AI\TripoSR\run.py" --device cuda:0
~~~

Replace both paths with the actual worker environment. Use `--device cpu` or `--device mps` when appropriate. To capture a machine-readable, sanitized report:

~~~powershell
npm run preflight:single-image-worker -- --python "<worker-python>" --runner-script "<TripoSR-run.py>" --device cpu --json
~~~

The command returns exit code `0` only when the installed runtime/device probe succeeds and **both** TripoSR and the installed rembg default model weights are verified as cached. A missing, unknown or merely configured cache state returns exit code `2`. It does not call a model-download API, create a rembg session, run inference or publish anything. Its report deliberately excludes environment variables, executable paths, cache paths and credentials.

The D3M-05 smoke repeats the same single-image-only capability check immediately before inference; neither command launches the unrelated COLMAP `--help` checks. The D3M-05 run still performs the actual TripoSR runner launch through the workflow after all operator/source/model-rights gates pass.

The preflight requests only the `single-image-ai` strategy; it does not launch the unrelated COLMAP `--help` checks. The configured TripoSR `run.py` is opened and syntax-compiled in memory, but its top-level code and `--help` handler are never executed. The Python subprocess disables bytecode writes and sets Hugging Face offline/telemetry flags while checking packages and local cache metadata. Package imports still execute installed package initialization code and may have package-specific side effects; the preflight is not a hermetic read-only environment, OS sandbox or network firewall. Apply host/network egress controls when strict no-egress or no-write guarantees are required.

A `ready` result is only a precondition. It does not prove that the runner will complete inference, that model terms permit the intended use, that sufficient GPU memory is available, or that the resulting building geometry is accurate. Continue with the D3M-05 smoke only after source rights and both model licences have been reviewed; then run the independent evidence verifier and human GLB inspection.


## Main promotion and current real-host status — 2026-11-03

- D3M-05 implementation, D3M-04 capability readiness, D3M-06 reviewed placement and D3M-07 preflight were integrated into `main` by cumulative promotion PR [#325](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/325). The earlier stacked PR #308 is closed as superseded; its code is part of the main-based integration.
- D3M-ENGINE-02 consolidated worker-host inventory was added by [PR #347](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/347). Its squash merge commit is `bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`, the current main head.
- Post-merge main Full CI [#41649268743](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41649268743) completed successfully: 207/207 steps. It passed D3M-05 runtime-smoke contract tests (step 138), D3M-07 preflight tests (139), host inventory tests/CLI (140–141), and D3M-05 smoke/verifier CLI validation (143–144).
- These tests use fake workflow execution and synthetic GLB fixtures. They do **not** run real TripoSR/rembg weights, GPU kernels, a provisioned worker host or a rights-cleared image.
- **Still outstanding:** run the host inventory and single-image preflight on the actual provisioned worker environment; review source and model-weight terms; execute one fresh D3M-05 smoke with fresh IDs and all four operator confirmations; run the independent verifier; inspect the private GLB in an independent viewer; record the sanitized result using the evidence-log template.
- Tracking remains open in [issue #307](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/307). Keep `mapReady=false`, `publicationEligible=false` and `automaticApproval=false`. No private source image, smoke JSON, GLB, model weights, cache path or raw worker log belongs in Git.

## D3M-ENGINE-03 integration status — 2026-11-04

- The evidence-backed multi-view orchestration is being validated on [PR #351](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/351), based on current `main@bf00588e0a63c3b60cca036de3a4ad6637a2bc5d`.
- The orchestration's media and architectural-geometry outputs remain distinct child candidates; its new parent guard binds each child report to the exact building ID, child job ID and expected workflow/profile. This does not replace the fresh single-image worker smoke described above.
- The real TripoSR/rembg worker-host inference is still not recorded in issue [#307](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/307). CI uses fixtures/fakes and must not be reported as real inference.
- Keep D3M-05 runtime acceptance, independent GLB inspection and all production release flags blocked until the actual host run and verifier evidence are supplied.


## D3M-ENGINE-05 process-side model-load evidence — 2026-11-04

The smoke report schema is upgraded to `1.2.0`. In addition to D3M-ENGINE-04's pre/post inventory fingerprints, the exact TripoSR runner process receives a private receipt destination and the three expected pre-inference SHA-256/byte-count pairs. A temporary Python `sitecustomize.py` instruments these loader boundaries:

- `omegaconf.OmegaConf.load` for the TripoSR `config.yaml`.
- `torch.load` for the TripoSR `model.ckpt`.
- `onnxruntime.InferenceSession` for the active rembg ONNX model.

For TripoSR config/checkpoint, the instrumentation opens the regular file, hashes it through a bounded-memory descriptor, verifies device/inode/size/mtime/ctime identity, and hands that same open descriptor to the loader. It verifies the descriptor again after the loader returns. For rembg ONNX files, it reads a regular file of at most 512 MiB into one immutable bytes object, hashes that object and passes the same object to ONNX Runtime. Missing or unsupported loader behavior fails closed. The smoke requires all three path-redacted receipts to match the D3M-ENGINE-04 pre-inference hashes and byte counts before it can report `passed`.

Only role, loader name, byte count, SHA-256 and stable/exact-bytes booleans are stored in the private receipt/report. No model path, cache path, model bytes or raw loader output is recorded. The receipt file is private (0600 where POSIX mode controls apply) and lives in the temporary directory removed after the smoke.

**Compatibility and limitations:** the independent verifier understands smoke schemas `1.0.0`, `1.1.0` and `1.2.0`. Schema 1.0.0 has no worker model fingerprints; schema 1.1.0 has pre/post fingerprints but no process-side loader receipts; both are explicitly labelled as legacy evidence. Only schema 1.2.0 requires and validates the three loader receipts. This is process-side instrumentation, not signed OS/hardware attestation: a modified or malicious runner could bypass the patched APIs or use an alternate loader. A compatibility change in the installed TripoSR/rembg stack that avoids these hooks must fail closed and be investigated rather than weakening the requirement.

Reading a rembg ONNX model into memory adds up to 512 MiB peak model-buffer memory to the worker; plan RAM headroom accordingly. The instrumented file reads are bounded-memory for TripoSR config/checkpoint; they add I/O proportional to artifact size. This evidence establishes which exact bytes were handed to these instrumented loader APIs. It does not prove licence permission, successful/accurate inference, model trustworthiness, physical building truth, metric scale or georeferencing.

The D3M-ENGINE-05 implementation is tracked in [issue #354](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/354) and is stacked on the D3M-ENGINE-04 branch/PR #353. Automated fixtures exercise the loader hooks; they are not a real worker-host inference. Continue to keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false until the separate real-host, rights, reviewer, survey and human-inspection gates are completed.


## Process-side source-image loader evidence (D3M-ENGINE-06)

Smoke schema `1.3.0` adds a separate `sourceLoadEvidence` object. The exact TripoSR child process receives the worker's actual source-path argument plus the expected source SHA-256/byte count through private environment variables. A temporary Python `sitecustomize.py` observes `PIL.Image.open`, captures the source through a bounded descriptor read with before/after file-identity checks, and passes those same bytes to Pillow using an in-memory `io.BytesIO`. Repeated opens of the selected source reuse the cached bytes. The private receipt contains only role `sourceImage`, loader `PIL.Image.open`, bytes, SHA-256 and exact/stable booleans; it never stores the path.

The smoke requires exactly one valid source-image receipt bound to the report's `source.bytes` and `source.sha256`. A changed source, unrecognized loader input, malformed/duplicate receipt, or missing receipt blocks a successful smoke. The three D3M-ENGINE-05 model loader receipts remain separately mandatory.

The independent verifier accepts legacy smoke schemas `1.0.0`, `1.1.0` and `1.2.0`, but labels them as having no source-image loader evidence. Only schema `1.3.0` requires and validates the Pillow receipt. This is process-side loader instrumentation, not OS/hardware attestation; it does not prove rights, building identity, model accuracy, metric scale or georeferencing. See [D3M-ENGINE-06](./D3M-ENGINE-06-SOURCE-IMAGE-LOAD-ATTESTATION.md) for the implementation contract and limits.


## D3M-ENGINE-07 generation artifact receipt (smoke schema 1.4.0)

A successful schema `1.4.0` smoke now writes a separate, write-once `.building-engine/runtime-smokes/<jobId>.artifact.json` receipt. The smoke report contains a relative path plus the exact receipt byte count, SHA-256 and canonical payload SHA-256. The receipt joins the on-disk media-to-model `workflow-report.json`, selected source and Pillow decoder evidence, pre/post TripoSR/rembg worker fingerprints, all three D3M-ENGINE-05 process-side model-loader receipts, the emitted GLB bytes/hash/mesh count and the geometry-QA summary. The workflow report is itself re-read and hashed before the receipt is created.

The independent verifier re-hashes the receipt and workflow report, checks their exact identity and cross-bindings, then independently re-hashes the source/GLB and re-computes geometry QA. A missing, substituted, modified or malformed receipt/report fails closed. Smoke schemas `1.0.0`–`1.3.0` remain verifiable and are labelled `not-recorded-legacy-schema` for the new receipt; only `1.4.0` requires it. See [D3M-ENGINE-07](./D3M-ENGINE-07-GENERATION-ARTIFACT-RECEIPT.md).

This local write-once/hash-bound sidecar is not a signature, hardware attestation or tamper-proof storage. It does not prove rights, model licence, accuracy, scale, georeferencing or survey truth. It cannot enable `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` or `automaticApproval`.


## D3M-ENGINE-08 — optional single-image ground-control evidence (smoke schema 1.5.0)

The single-image runtime smoke accepts an optional workspace-relative control-point manifest JSON file. It binds the building ID, selected source ID and exact source-image SHA-256; declares horizontal CRS EPSG:4326 and horizontal datum WGS84; explicitly leaves vertical datum not-provided; and records survey method/reference/date and declared horizontal accuracy. At least three unique, non-collinear controls are required, and every point must identify the selected source through evidenceSourceId.

The smoke validates and hashes the manifest before model generation, passes the normalized control points and configured RMS/max-residual thresholds into the existing registerModelToWgs84 workflow, then re-reads the manifest after generation and rejects byte/hash drift. The registration is tied to the exact GLB SHA-256 in smoke report schema 1.5.0 and generation-artifact receipt schema 1.1.0.

The independent verifier re-reads and hashes the manifest, validates the building/source binding and recomputes the WGS84 horizontal similarity registration. It rejects altered manifest bytes, changed control points, wrong GLB/source identity, or registration that differs from the workflow report or artifact receipt. Smoke schemas 1.0.0–1.4.0 and receipt schema 1.0.0 remain supported; only schema 1.5.0 requires georeference evidence. No-manifest runs are explicitly labelled not-requested.

Trust limits: survey metadata and control points are operator-supplied, not independently authenticated. A low residual does not prove that points correspond to the correct GLB vertices, prove survey quality, solve height datum or establish model accuracy. Horizontal registration remains human-review-only. Keep groundTruth, acceptanceEligible, publicationEligible, mapReady and automaticApproval false.
