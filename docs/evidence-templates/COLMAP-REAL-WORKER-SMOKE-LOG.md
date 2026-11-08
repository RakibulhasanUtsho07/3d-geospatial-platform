# COLMAP real-worker smoke evidence log

Use one copy for each real, operator-host photogrammetry queue job. Do not fill this from CI fixtures, mocked process launches or the startup --help probe.

**Privacy:** never commit source images, COLMAP database/workspace files, sparse/dense reconstructions, textured meshes, GLBs, raw stdout/stderr, absolute workstation paths, hostnames, usernames, credentials or private correspondence. Record only sanitized IDs, hashes, counts, versions and review outcomes.

## Run identity and worker host

| Field | Value |
|---|---|
| Run date/time (UTC) | `NOT-RECORDED` |
| Run disposition | `not-run` / `blocked` / `failed` / `completed-requires-review` |
| Repository Main SHA | `NOT-RECORDED` |
| Queue job ID | `NOT-RECORDED` |
| Building ID | `NOT-RECORDED` |
| Operator / reviewer handle (non-secret) | `NOT-RECORDED` |
| Worker OS / architecture | `NOT-RECORDED` |
| CPU / RAM class | `NOT-RECORDED` |
| GPU model / VRAM / driver (if used) | `NOT-RECORDED` |
| COLMAP version | `NOT-RECORDED` |
| COLMAP executable SHA-256 (if collected) | `NOT-RECORDED` |
| Configured compute mode / GPU actually used | `NOT-RECORDED` |

Do not store hostnames, usernames or absolute paths. A version or executable hash is provenance metadata, not proof that every reconstruction operation used a particular GPU.

## Source set and permissions

| Field | Value |
|---|---|
| Number of selected views | `NOT-RECORDED` |
| Distinct source IDs | `NOT-RECORDED` |
| Source SHA-256 list (one hash per source ID) | `NOT-RECORDED` |
| Media types (JPEG/PNG only) | `NOT-RECORDED` |
| All inputs distinct bytes / no duplicate content | `yes` / `no` / `NOT-RECORDED` |
| Same-building identity reviewed | `confirmed` / `not-confirmed` |
| Image overlap reviewed | `confirmed` / `not-confirmed` |
| Up-axis and selected axis | `confirmed` / `NOT-RECORDED` |
| Source-rights basis | `NOT-RECORDED` |
| private-media-ingestion scope | `confirmed` / `not-confirmed` |
| photogrammetry-reconstruction scope | `confirmed` / `not-confirmed` |
| texture-baking scope | `confirmed` / `not-confirmed` |

Operator confirmations are attestations only. Attach no private image or permission correspondence to this log. Record enough non-sensitive detail for an authorized reviewer to locate the private rights record.

## Readiness and execution

| Field | Value |
|---|---|
| Worker heartbeat/status | `online` / `stale` / `offline` / `NOT-RECORDED` |
| COLMAP startup probe | `ready` / `blocked` / `NOT-RECORDED` |
| Probe meaning understood (--help only) | `yes` / `no` |
| automatic_reconstructor exit / duration | `NOT-RECORDED` |
| model_analyzer exit / duration | `NOT-RECORDED` / `not-available` |
| model_converter exit / duration | `NOT-RECORDED` / `not-available` |
| mesh_texturer exit / duration | `NOT-RECORDED` / `not-available` |
| Queue job terminal state | `NOT-RECORDED` |
| Workflow report status | `NOT-RECORDED` |
| Workflow warning count/categories | `NOT-RECORDED` |

The startup probe is only CLI entry-point availability; it is not a real reconstruction test. Record each actual command separately. Use not-available for a stage that correctly did not run because an earlier stage failed; do not mark it as passed.

## Reconstruction and coverage diagnostics

| Field | Value |
|---|---|
| Image-quality preflight status | `NOT-RECORDED` |
| Flagged input views | `NOT-RECORDED` |
| Near-duplicate view pairs | `NOT-RECORDED` |
| COLMAP registered images / total input images | `NOT-RECORDED` |
| Registered image ratio | `NOT-RECORDED` |
| Sparse points / observations | `NOT-RECORDED` |
| Mean track length | `NOT-RECORDED` |
| Mean reprojection error | `NOT-RECORDED` |
| Reconstruction diagnostics state | `diagnostics-passed` / `warnings` / `unavailable` / `NOT-RECORDED` |
| Registered camera poses | `NOT-RECORDED` |
| Camera/view coverage status | `passed` / `warnings` / `unavailable` / `NOT-RECORDED` |
| Diagnostic caveats reviewed | `yes` / `no` |

Heuristic metrics do not prove camera overlap, surface completeness, architectural correctness, scale or survey quality. Preserve unavailable when metrics cannot be parsed; never fabricate values.

## Textured model and GLB

| Field | Value |
|---|---|
| Textured PLY produced | `yes` / `no` / `NOT-RECORDED` |
| Texture image produced | `yes` / `no` / `NOT-RECORDED` |
| GLB produced | `yes` / `no` / `NOT-RECORDED` |
| GLB byte length | `NOT-RECORDED` |
| GLB SHA-256 | `NOT-RECORDED` |
| Mesh / vertex / triangle counts | `NOT-RECORDED` |
| Geometry QA status and warning count | `NOT-RECORDED` |
| Model review triage / priority | `NOT-RECORDED` |
| Independent viewer (application/version) | `NOT-RECORDED` |
| Human visual inspection | `pass` / `fail` / `not-run` |
| Observed defects / missing surfaces / texture issues | `NOT-RECORDED` |

Record the exact hash of the inspected GLB. A successful conversion or valid GLB header is not a visual-quality pass.

## Scale, placement and release

| Field | Value |
|---|---|
| Independent known-distance measurement | `NOT-RECORDED` |
| Scale calibration state | `calibrated` / `unknown-scale-preview-only` / `NOT-RECORDED` |
| Horizontal WGS84 control evidence | `not-solved` / `separately-reviewed` / `NOT-RECORDED` |
| Vertical datum / ellipsoidal height evidence | `not-solved` / `separately-reviewed` / `NOT-RECORDED` |
| Heading / front orientation independently reviewed | `yes` / `no` / `NOT-RECORDED` |
| Survey / CAD / BIM / LiDAR truth reference | `NOT-RECORDED` |
| Human acceptance decision and reviewer authority | `NOT-RECORDED` |

The current COLMAP worker does not solve WGS84 ground-control registration or vertical datum. The BuildingSpec location remains a placement hint only. Scale calibration by a known distance does not solve map placement, heading or vertical height.

**Release state must remain:** `groundTruth=false`, `acceptanceEligible=false`, `publicationEligible=false`, `mapReady=false`, `automaticApproval=false`. The run produces a private review candidate, not a published map building.
