# D3M-05 — Real Worker Smoke Evidence Log

Use one copy of this template for each operator-host execution of the D3M-05 single-image runtime smoke. Current Mainline versions (2026-11-08): smoke report 1.6.0, generation-artifact receipt 1.2.0, and georeference evidence 1.1.0 when vertical observations are present. Historical versions are explicitly labelled below.

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


## Process-side model-load evidence (D3M-ENGINE-05)

| Field | Value |
|---|---|
| Smoke report schema | `1.6.0` / legacy `1.0.0`–`1.5.0` / `NOT-RECORDED` |
| Process-side loader evidence status | `verified` / `missing` / `rejected` / `legacy-not-recorded` |
| TripoSR config loader | `omegaconf.OmegaConf.load` — bytes / SHA-256: `NOT-RECORDED` |
| TripoSR checkpoint loader | `torch.load` — bytes / SHA-256: `NOT-RECORDED` |
| rembg ONNX loader | `onnxruntime.InferenceSession` — bytes / SHA-256: `NOT-RECORDED` |
| All three loader values match pre-inference inventory | `yes` / `no` / `not-applicable` |

Schema 1.0.0 has no worker model fingerprints; schema 1.1.0 has pre/post fingerprints but no process-side model-loader receipts. Schemas 1.2.0 and later require the three model-loader receipts. Record older schemas as legacy—not as a successful loader attestation. The current Mainline smoke is schema 1.6.0. Keep detailed private report/receipt paths inside the access-controlled worker workspace; never paste absolute model/cache paths or weights here.


## Source-image decoder evidence (D3M-ENGINE-06)

| Field | Value |
|---|---|
| Source-image loader evidence status | `verified` / `missing` / `rejected` / `legacy-not-recorded` |
| Decoder API | `PIL.Image.open` / `NOT-RECORDED` |
| Decoder input byte length | `NOT-RECORDED` |
| Decoder input SHA-256 | `NOT-RECORDED` |
| Exact immutable bytes handed to Pillow | `true` / `false` / `not-recorded` |
| Stable source descriptor/path identity | `true` / `false` / `not-recorded` |
| Source-image receipt event count | `1` / `0` / `more-than-one` / `not-recorded` |
| Decoder receipt matches source manifest | `yes` / `no` / `not-applicable` |

Smoke schema `1.3.0` and later requires the source-image loader receipt. Schemas `1.0.0`–`1.2.0` predate this decoder-boundary evidence and must be labelled `legacy-not-recorded`. The current Mainline smoke is schema 1.6.0. The Pillow event contains no source path or image bytes. The Python fixture proves the instrumented API contract only; it is not a real TripoSR worker-host inference.



## Generation artifact receipt (D3M-ENGINE-07)

| Field | Value |
|---|---|
| Smoke report schema | `1.6.0` / legacy `1.0.0`–`1.5.0` / `NOT-RECORDED` |
| Generation artifact receipt schema | `1.2.0` / legacy `1.0.0`–`1.1.0` / `NOT-RECORDED` |
| Generation artifact receipt status | `verified` / `rejected` / `not-recorded-legacy-schema` |
| Receipt relative path | `.building-engine/runtime-smokes/<jobId>.artifact.json` / `NOT-RECORDED` |
| Receipt byte length / file SHA-256 | `NOT-RECORDED` |
| Canonical payload SHA-256 | `NOT-RECORDED` |
| Exact workflow-report path / byte length / SHA-256 | `NOT-RECORDED` |
| Receipt binds source + Pillow, three model loaders, pre/post worker fingerprints | `yes` / `no` / `not-recorded` |
| Receipt binds GLB path / bytes / SHA-256 / mesh count | `yes` / `no` / `not-recorded` |
| Receipt binds independent GLB geometry-QA summary | `yes` / `no` / `not-recorded` |

Keep receipt/report files in the restricted worker workspace. Record hashes and relative paths only; do not place source images, GLBs, model weights, absolute worker/cache paths or raw logs in Git. A valid local hash-bound receipt is not a signature, tamper-proof storage, real-world accuracy result or release approval.


## Current georeference evidence (D3M-ENGINE-08 / D3M-ENGINE-13)

| Field | Value |
|---|---|
| Control-point manifest schema | `1.0.0` horizontal-only / `1.1.0` with vertical observations / `not-provided` |
| Horizontal CRS / datum | `EPSG:4326` / `WGS84` / `NOT-RECORDED` |
| Vertical CRS / datum | `EPSG:4979` / `EPSG:4979-ellipsoidal` / `not-provided` |
| Vertical reference-frame realization | `NOT-RECORDED` |
| Coordinate epoch | `NOT-RECORDED` |
| Vertical survey method/reference/time | `NOT-RECORDED` |
| Vertical residual RMS / maximum | `NOT-RECORDED` |
| Georeference evidence schema | `1.1.0` when vertical evidence is supplied / legacy `1.0.0` / `not-requested` |
| Independent surveyor/device/field-record authentication | `NOT-RECORDED` |
| Human verification of model-to-control-point correspondence | `NOT-RECORDED` |

Vertical controls must be WGS 84 ellipsoidal heights in metres with a declared realization and coordinate epoch. Do not convert or relabel orthometric, mean-sea-level, above-ground or other heights as ellipsoidal. No geoid conversion is implemented here. A low residual does not authenticate the survey or prove that a model point is the same physical feature that was measured.

## Mainline and real-host status

- The D3M-ENGINE-04–09 evidence increments and D3M-ENGINE-13 vertical evidence are part of cumulative Main integration [PR #409](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/409); old stacked PRs must not be replayed.
- **Actual host inference:** `NOT-RUN` until this log is filled from a real, provisioned worker-host execution. Fixture/CI success is not operator-host inference.
- **Release state:** `groundTruth=false`, `acceptanceEligible=false`, `publicationEligible=false`, `mapReady=false`, `automaticApproval=false`.
