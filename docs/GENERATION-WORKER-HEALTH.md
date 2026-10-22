# Generation worker health status

The persistent file-backed worker writes an operational heartbeat to:

`.building-engine/generation-queue/worker-status.json`

The authenticated endpoint `GET /api/building-generation/worker-status` returns a sanitized status:

- `online`: the worker heartbeat is recent.
- `stale`: the last `running` heartbeat is older than 90 seconds; the process may have stopped unexpectedly.
- `stopped`: the worker last exited cleanly.
- `offline`: the worker has not written a status record in this workspace.

The response includes phase (`starting`, `idle`, `processing`, `stopped`), heartbeat time, worker ID and current job ID when present. The status API uses `GENERATION_API_TOKEN` and `BUILDING_ENGINE_WORKSPACE`; it never returns tokens or file paths. Set `Cache-Control: no-store` is applied to the response.

The status record is monitoring telemetry only; it does not change generation job state and must not be treated as proof that the worker can complete a particular ML job. It uses the same persistent workspace as the file-backed queue, so it is not suitable for deployment architectures where API instances and workers do not share durable storage.
