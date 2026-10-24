# P2.10 — Viewport fetch-cost evidence

## Goal

Add repeatable evidence that P2.9 reads only sampled building geometries while preserving the same spatial-grid round-robin result for a fixed generated-tile dataset and viewport.

## Evidence captured

Each real viewport request in the Playwright workload records:
- complete selected-tile payload bytes as the whole-payload baseline;
- compact index bytes read during the workload;
- actual selected feature-geometry bytes read;
- number of geometry features fetched and the request's feature limit.

The first valid viewport API integration request separately logs a cold-request record, including index bytes, geometry bytes, combined bytes, and the reduction ratio. The browser workload runs later against the same production server process and may therefore see a warm index cache; its index-byte aggregate is named as workload-observed index bytes, and its cache-miss request count makes that state visible.

The workload report aggregates the whole-tile baseline, geometry payload bytes, index overhead, the geometry-payload reduction ratio, and fetch-budget violations. It asserts that feature-only payload reads are lower than the whole-tile baseline and that every measured tile-backed geometry fetch stays within its response feature limit. The geometry ratio compares bytes read from selected feature payloads with the complete selected-tile payload baseline; index bytes are reported separately so the report does not hide index overhead.

## Correctness guard

The dense-viewport API test reconstructs the historical geometry-first selection from generated tiles, applying the same exact viewport intersection, identity deduplication, render-role priority and spatial round-robin selector. The production API result must be byte-for-byte-equivalent at the JSON feature-object level to that expected sample, while the reported full-geometry fetch count must stay within the requested feature cap.

## Limitations

The comparison is against the current generated tile/index dataset and existing sampling policy, not a visual ground-truth measurement. Whole-tile payload bytes are a per-request theoretical baseline; index caches and operating-system page caches mean this is not a direct estimate of physical disk I/O or wall-clock speedup.
