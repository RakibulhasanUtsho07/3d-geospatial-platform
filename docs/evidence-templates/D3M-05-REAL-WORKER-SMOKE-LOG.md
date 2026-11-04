# D3M-05 — Real Worker Smoke Evidence Log

Use one copy of this template for each operator-host execution of the D3M-05 single-image runtime smoke.

**Do not commit** the source image, generated GLB, model weights, private runtime-smoke JSON, raw process logs, absolute workstation paths, hostnames, usernames, API tokens or other secrets. Keep the original report and GLB in the private worker workspace. This template is only a sanitized index for review.

## Run identity

| Field | Value |
|---|---|
| Run date/time (UTC) | `NOT-RECORDED` |
| Run disposition | `not-run` / `blocked` / `failed` / `passed` |
| Smoke job ID | `NOT-RECORDED` |
| Test building ID | `NOT-RECORDED` |
| Operator/reviewer handle (non-secret) | `NOT-RECORDED` |
| Worker platform / architecture | `NOT-RECORDED` |
| Device selection | `cpu` / `cuda:N` / `mps` |
| Hardware class (no hostname) | `NOT-RECORDED` |

## Source and rights

| Field | Value |
|---|---|
| Source ID | `NOT-RECORDED` |
| Source media type | `image/jpeg` / `image/png` |
| Source byte length | `NOT-RECORDED` |
| Source SHA-256 | `NOT-RECORDED` |
| Rights/permission basis | `NOT-RECORDED` |
| Operation-scope confirmation | `confirmed` / `not-confirmed` |
| Single-view inference confirmation | `confirmed` / `not-confirmed` |

A non-empty licence string or operator checkbox is an attestation, not independent legal clearance. Record the actual permission basis in enough detail for a reviewer, without uploading the image or exposing private correspondence.

## Runtime and model readiness

| Field | Value |
|---|---|
| Node.js version | `NOT-RECORDED` |
| Python version | `NOT-RECORDED` |
| PyTorch version | `NOT-RECORDED` |
| ONNX Runtime version | `NOT-RECORDED` |
| rembg package version | `NOT-RECORDED` |
| TripoSR runner revision / source identifier | `NOT-RECORDED` |
| TripoSR runner script SHA-256 (when collected) | `NOT-RECORDED` |
| TripoSR config/model cache | `cached` / `missing` / `unknown` |
| TripoSR config byte length | `NOT-RECORDED` |
| TripoSR config SHA-256 | `NOT-RECORDED` |
| TripoSR config snapshot revision | `NOT-RECORDED` |
| TripoSR checkpoint byte length | `NOT-RECORDED` |
| TripoSR checkpoint SHA-256 | `NOT-RECORDED` |
| TripoSR checkpoint snapshot revision | `NOT-RECORDED` |
| rembg model identifier | `NOT-RECORDED` |
| rembg model-weight cache | `cached` / `missing` / `unknown` |
| rembg weight byte length | `NOT-RECORDED` |
| rembg weight SHA-256 | `NOT-RECORDED` |
| TripoSR code/checkpoint licence basis reviewed | `NOT-RECORDED` |
| rembg model-weight licence basis reviewed | `NOT-RECORDED` |
| Selected device actually available | `yes` / `no` |
| Offline policy | `application-level only` / `host egress denied` / `not verified` |

Do not write model cache paths into this log. The D3M-ENGINE-04 inventory and runtime smoke should capture SHA-256 values and byte lengths for TripoSR config/checkpoint and active rembg weights before and after inference. Require identical fingerprints and the same TripoSR snapshot revision; missing/malformed hashes or drift means the smoke is not passed. This is byte-identity evidence only, not proof of licence, authenticity, or which bytes the inference process opened. The runtime smoke's D3M-04 preflight must report both model caches as `cached` and the selected device must be supported before inference can start. If commercial use is intended, independently verify the exact model-weight terms before running.

## Execution result

| Field | Value |
|---|---|
| CLI exit code | `NOT-RECORDED` |
| Smoke report status | `NOT-RECORDED` |
| TripoSR runner launch attempted | `true` / `false` |
| TripoSR child process emitted spawn | `true` / `false` |
| Inference duration (ms) | `NOT-RECORDED` |
| Private report relative path | `.building-engine/runtime-smokes/<jobId>.json` |
| Independent verifier result | `verified` / `rejected` / `not-run` |
| Verifier summary | `NOT-RECORDED` |
| Worker-host inventory schema | `1.1.0` / `legacy-1.0.0` / `NOT-RECORDED` |
| Worker-host fingerprints stable before/after inference | `true` / `false` / `not-recorded` |
| Pre-inference runner SHA-256 | `NOT-RECORDED` |
| Post-inference runner SHA-256 | `NOT-RECORDED` |
| Pre/post TripoSR + rembg artifact fingerprints match | `yes` / `no` / `not-recorded` |

## GLB and QA result

| Field | Value |
|---|---|
| GLB SHA-256 | `NOT-RECORDED` |
| GLB byte length | `NOT-RECORDED` |
| Mesh count | `NOT-RECORDED` |
| Triangle / vertex / primitive counts | `NOT-RECORDED` |
| Geometry QA status | `NOT-RECORDED` |
| Warning count and sanitized categories | `NOT-RECORDED` |
| Independent viewer inspection | `pass` / `fail` / `not-run` |
| Visual defects / limitations | `NOT-RECORDED` |

A structurally valid GLB and an integrity-verified smoke do not establish architectural fidelity, physical dimensions, scale, orientation, survey control, vertical datum, source rights or representative accuracy.

## Review and follow-up

- [ ] Private smoke report retained in the restricted worker workspace.
- [ ] Independent verifier completed successfully against that report and the exact source/GLB bytes.
- [ ] GLB opened in an independent viewer and inspected for topology, normals, detached geometry, materials/UVs and all visible sides.
- [ ] Source and model-weight permission terms reviewed by an authorized person.
- [ ] Any visual or geometry defects logged as correction tasks and tied to the exact GLB SHA-256.
- [ ] No release flag was enabled by the smoke.

**Release state must remain:** `mapReady=false`, `publicationEligible=false`, `automaticApproval=false`. The smoke is one host/input execution only, not an accuracy benchmark.
