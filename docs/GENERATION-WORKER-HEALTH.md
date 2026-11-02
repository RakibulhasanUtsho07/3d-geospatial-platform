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
| Single-image AI | `ready` / `configured` / `blocked` | TripoSR runner file, Python runner imports, PyTorch import, configured CPU/CUDA/MPS availability, and presence of both `stabilityai/TripoSR` `config.yaml` and `model.ckpt` in the local Hugging Face cache |

Single-image AI is `ready` only when the runtime/device probe succeeds and both primary TripoSR model files are already cached. It is `configured` when Python/PyTorch/device are available but either model file is missing; the worker will not claim AI jobs in that state. Cache the files with:

```bash
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('stabilityai/TripoSR', 'config.yaml'); hf_hub_download('stabilityai/TripoSR', 'model.ckpt')"
```

The cache check uses Hugging Face's local-only `try_to_load_from_cache` helper and makes no network request. Model-cache readiness is not a proof that actual inference will succeed: the TripoSR background-removal model/cache, real CUDA kernels, GPU memory, image preprocessing and end-to-end GLB export are exercised only by a real job. A COLMAP command probe likewise does not prove image overlap, reconstruction quality, GPU acceleration or survey registration. Human review remains mandatory.

The worker claims only compatible strategies. Unsupported jobs remain `queued` and do not consume retry attempts; `auto` maps to the procedural path. Probes run at worker startup, so restart after changing executable, Python, runner, cache or device configuration.

The status endpoint returns the check timestamp, strategy state and bounded blocker/caveat descriptions. It does not expose executable paths, environment values, secrets, raw process output or model files. The status API uses `GENERATION_API_TOKEN` and `BUILDING_ENGINE_WORKSPACE`, sets `Cache-Control: no-store`, and shares the queue's persistent-workspace deployment constraint.
