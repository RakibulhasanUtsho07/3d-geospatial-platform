# P2.18 — Bounded selected-geometry LRU cache

## Why

P2.17 measurements on the controlled 2,500-feature Dhaka viewport showed warm selected-geometry reads around 44–46 ms. Bounded range reads accounted for roughly 27–30 ms, JSON parsing around 10–11 ms, and the index-to-geometry integrity verification around 3–4 ms. The viewport repeats the same selected records, so re-reading and reparsing identical feature bytes on every pan/refresh wastes work.

## Change

Cache only individual tile-backed selected features that have already passed the existing JSON shape, geometry-bounds and render-role checks. The key includes the generated tile path, the current tile data-file signature (size and modification time), byte offset, byte length, feature identity, render role and all indexed bounds. Changing the data signature changes the key and therefore makes previous entries ineligible for reuse.

The cache is LRU and bounded to **4 MiB of source-record bytes and 6,000 entries**. A selected feature larger than the byte cap is read and validated normally but is not retained. The existing compact tile index still gets checked against the current data file signature before selected-geometry lookup. The API does not remove the geometry integrity checks from cache-miss reads.

## Benchmark contract

The viewport endpoint reports X-Building-Geometry-Feature-Cache-Hits and X-Building-Geometry-Feature-Cache-Misses. Cold/warm benchmark observations record them, require cold misses on a fresh process, and require repeated test viewport samples to use cached geometry with zero selected-geometry bytes reread. Existing index-read, feature budget, byte baseline and exact ordered feature SHA-256 guards remain active.

The response FeatureCollection must remain byte-for-byte equivalent as parsed JSON for identical requests. Timing is descriptive; the CI benchmark must decide whether wall-clock latency improved rather than assuming that avoiding reads guarantees a particular speedup.

## Scope and limitations

This cache is process-local and only reuses the same file signature and record identity. Tile file signatures use the same size/mtime contract as the existing index cache; it is not a cryptographic content hash. The cache cap bounds retained serialized source-record bytes, not exact JavaScript heap use. This optimization is intended for repeated viewport records and does not cache across deployments or worker processes.
