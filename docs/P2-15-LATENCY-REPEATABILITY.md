# P2.15 — Fresh-process viewport latency repeatability

## Goal

Quantify cold-request latency variability across multiple newly started Next.js production processes, and characterize warm request and per-process warm-median spread. P2.14 identified a slower latency sample while byte counts and correctness remained stable; this step measures variability instead of treating a single run as proof of a regression.

## CI methodology

After the primary two-process guard, API tests, Playwright multi-tile workload, and P2.13/P2.14 reports, CI starts four additional production server processes sequentially on ports 3100–3103. Each server receives only invalid-bound HTTP 400 readiness probes before its first valid benchmark request. The existing P2.11 cold/warm benchmark then measures one cold request and five warm repeats. Each process is stopped before the next sample begins.

Raw reports are saved as `p2-15-evidence/fresh-process-samples/sample-01.json` through `sample-04.json`; the aggregate report is `p2-15-evidence/viewport-latency-repeatability.json`. Both are included in the Actions artifact.

## Statistical summaries and gates

The aggregate reports min, p25, median, p75, IQR, p95, max, range, median absolute deviation, mean, standard deviation, and coefficient of variation for cold samples, per-process warm medians, and pooled warm request observations. It includes raw per-process latency observations.

Hard checks require identical manifest/viewport/feature budget and ordered response hashes, positive cold index reads in every fresh process, zero warm index reads, and matching deterministic cold metrics. Millisecond results are descriptive only: the CI job does not fail simply because a latency sample is slower.

## Limitations

Four processes run sequentially on one hosted runner against one build and filesystem. They can share OS page cache, CPU contention and machine-specific characteristics; these are repeated process samples, not independent CI jobs or separate machines. Pooled warm observations are clustered inside each process, so the per-process warm-median distribution should be used for process-to-process variability. Byte counters are application-level reads rather than physical disk I/O. Client request timings exclude full map startup and GPU rendering.
