# P2.14 — Cross-commit viewport performance comparison

## Baseline provenance

`benchmarks/viewport-performance-baseline-p2-13.json` is a versioned snapshot captured from the successful P2.13 CI run [#40104416317](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40104416317), PR #142. It records the spatial-tile manifest hash and the two-process API plus real multi-tile browser measurements. This is one reference run, not a statistical average.

## CI flow

After the P2.13 trend report is generated, `scripts/compare-viewport-performance-baseline.mjs` compares it with the checked-in baseline and writes `test-results/p2-14-viewport-performance-comparison.json`. The existing `test-results/` artifact upload preserves this output, even if a regression budget is exceeded.

## Regression policy

- The spatial-tile manifest must match exactly. If it changes, the comparator stops and asks for an explicitly reviewed baseline refresh rather than presenting an apples-to-oranges comparison.
- Cold index-read counters must match the baseline when the manifest is unchanged, and the current cross-process deterministic/hash checks plus stale-request, final viewport, postRender, feature-budget and memory guards must pass.
- Geometry/payload read bytes may grow by at most 15% from the baseline; read-reduction ratios may lose at most 5 percentage points. These are explicit budgets for read cost, not wall-clock timing.
- Cold/warm request timings and first-building readiness are compared with deltas, but remain informational because CI runner load, startup state and OS caching introduce noise.
- Heap and DOM deltas are reported, while the existing broad browser memory guard remains the gate.

## Updating the baseline

Only update the checked-in baseline after reviewing a successful run and confirming that any change in data, cost, or output is expected. Preserve the source workflow URL, candidate SHA and spatial-tile manifest SHA when refreshing it.

## Limitations

The baseline currently contains one CI sample, so it does not estimate variance or confidence intervals. Application byte counters are not physical disk I/O. JavaScript heap/DOM evidence does not include GPU/native Cesium allocations or operating-system process memory.
