# Generation worker health and strategy readiness

The file-backed worker writes status to `.building-engine/generation-queue/worker-status.json`. The authenticated `GET /api/building-generation/worker-status` endpoint distinguishes process liveness from per-strategy runtime readiness.

- `online`: heartbeat is recent (within 90 seconds).
- `stale`: last running heartbeat is older than 90 seconds.
- `stopped`: worker last exited cleanly.
- `offline`: no worker status exists in this shared workspace.

Startup probes record:

| Strategy | Reported state | What is checked |
|---|---|---|
| Procedural | `ready` | In-process parametric generator; no external ML runtime |
| Photogrammetry | `ready` / `blocked` | COLMAP executable plus `automatic_reconstructor`, `model_analyzer`, `model_converter`, and `mesh_texturer` help probes |
| Single-image AI | `configured` / `blocked` | TripoSR runner file, runner imports, PyTorch import, and configured CPU/CUDA/MPS availability |

Single-image AI is marked `configured`, not fully ready: pretrained weights/cache and remote model availability are not verified. COLMAP command probes do not prove reconstruction quality, overlap, GPU acceleration or survey accuracy. Runtime failures and human review remain possible.

The worker claims only compatible strategies. Unsupported jobs remain `queued` and do not consume retry attempts; `auto` maps to the procedural path. Probes run at worker startup, so restart after changing executable, Python, runner or device configuration.

The status endpoint returns the check timestamp, strategy state and bounded blocker/caveat descriptions. It does not expose executable paths, environment values, secrets, raw process output or model files. The status API uses `GENERATION_API_TOKEN` and `BUILDING_ENGINE_WORKSPACE`, sets `Cache-Control: no-store`, and shares the queue's persistent-workspace deployment constraint.
