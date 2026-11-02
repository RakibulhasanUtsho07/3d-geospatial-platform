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
| Single-image AI | `ready` / `configured` / `blocked` | TripoSR runner file, Python/PyTorch/ONNX Runtime/rembg imports, configured CPU/CUDA/MPS availability, both `stabilityai/TripoSR` files in the local Hugging Face cache, and the installed rembg `new_session()` default model in its local cache |

Single-image AI is `ready` only when the runtime/device/package probe succeeds, both primary TripoSR model files are cached, and the installed rembg default model is cached. The probe reads the installed `rembg.new_session()` default model name, resolves its registered session class, and calls that class' read-only `resolve_existing("<model-name>.onnx")` cache lookup. It does not construct a session, initiate a download, or expose a cache path. The installed model name is reported as a safe identifier. Missing or unknown rembg cache state keeps AI jobs unclaimable. Cache the TripoSR files with:

```bash
python -c "from huggingface_hub import hf_hub_download; hf_hub_download('stabilityai/TripoSR', 'config.yaml'); hf_hub_download('stabilityai/TripoSR', 'model.ckpt')"
```

The TripoSR cache check uses Hugging Face's local-only `try_to_load_from_cache` helper. Both TripoSR and rembg readiness checks make no network request. To pre-cache the default rembg model in the same Python environment used by the worker, inspect the installed default model name and initialize that session deliberately:

```bash
python -c "import inspect; from rembg import new_session; model=inspect.signature(new_session).parameters['model_name'].default; print(model); new_session(model)"
```

This preparation command may download model weights. Check the effective model's separate licence before using it; the rembg package licence does not grant rights to its model weights. Current rembg documentation identifies `bria-rmbg` as the default; BRIA RMBG 2.0 weights are source-available for non-commercial use unless separately licensed. Cache roots follow the installed rembg package's `U2NET_HOME` / `REMBG_HOME` / `XDG_DATA_HOME` settings. See [rembg environment variables and cache layout](https://github.com/danielgatis/rembg#environment-variables) and the [BRIA RMBG 2.0 model terms](https://huggingface.co/briaai/RMBG-2.0).

The automated Python-probe contract suite runs the actual inline readiness script in a temporary Python environment with isolated stub modules and temporary cache files. It covers both model caches present, each cache missing, an unsupported rembg resolver/API shape, and ONNX Runtime import failure; a worker regression also verifies that a cached TripoSR model with a missing rembg model remains queued at attempt zero. These tests validate the probe/claimability contract without downloading real model weights, creating an ONNX session, or proving compatibility of the deployment's installed model packages.

Model-cache readiness is not proof that inference will succeed: it does not instantiate ONNX Runtime sessions, validate model compatibility, exercise GPU kernels, measure GPU memory, or verify image preprocessing and end-to-end GLB quality. A COLMAP command probe likewise does not prove image overlap, reconstruction quality, GPU acceleration or survey registration. Human review remains mandatory.

The worker claims only compatible strategies. Unsupported jobs remain `queued` and do not consume retry attempts; `auto` maps to the procedural path. Probes run at worker startup, so restart after changing executable, Python, runner, cache or device configuration.

The status endpoint returns the check timestamp, strategy state and bounded blocker/caveat descriptions. It does not expose executable paths, environment values, secrets, raw process output or model files. The status API uses `GENERATION_API_TOKEN` and `BUILDING_ENGINE_WORKSPACE`, sets `Cache-Control: no-store`, and shares the queue's persistent-workspace deployment constraint.
