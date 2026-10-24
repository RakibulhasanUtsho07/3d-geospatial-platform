# P2.17 — Selected geometry-read phase breakdown

## Goal

Split the selected tile-geometry read into its internal operations so the next optimization is driven by measurements rather than assumptions. This is instrumentation only: it deliberately keeps byte-range coalescing, feature JSON parsing, bounds validation, render-role validation, and response serialization behavior unchanged.

## Timing contract

Successful viewport responses advertise `X-Building-Timing-Version: p2.17` and expose six additional millisecond headers:

- `Geometry-Range-Planning-Ms`: sort selected records and group nearby byte offsets into bounded read windows.
- `Geometry-File-Open-Ms`: open each selected tile payload file, including failed open attempts.
- `Geometry-Range-Read-Ms`: allocate and fill the chosen bounded buffers from file offsets.
- `Geometry-Json-Parse-Ms`: decode each selected feature record and parse its JSON.
- `Geometry-Integrity-Check-Ms`: validate feature/geometry shape and compare computed bounds plus render role against the index record.
- `Geometry-File-Close-Ms`: close the selected tile payload file.

These six measurements are **nested within** `Selected-Geometry-Read-Ms`; they are not independent top-level phases and must not be added to the enclosing value or tile-query aggregate. The API integration test asserts that their sum fits inside the enclosing selected-geometry duration with a small timer-rounding tolerance.

## Benchmark and regression checks

The cold/warm viewport benchmark now reads and records these headers per request. The P2.15 fresh-process aggregation reports distributions for the additional fields alongside existing phases. CI continues to guard manifest and ordered feature hashes, byte costs, cold index reads, zero warm index reads, feature budgets, and identical request payloads. Phase values are descriptive only, not strict millisecond gates.

## How to use the result

Compare cold and warm process distributions for each new subphase. If JSON parsing or integrity verification dominates, any proposed change must retain the index-to-geometry consistency check and be compared using the same manifest, viewport, feature limit, ordered feature hash, and byte-read budget. If range reads dominate, evaluate read-window grouping with the same correctness and byte-count guards. Do not infer physical disk I/O from these application-level timers.

## Limitations

The measurements cover explicitly timed operations within the API handler, not all runtime, network, framework, or browser/GPU time. Repeated observations on one CI runner can share the OS page cache and are not independent machines. This PR makes no performance improvement claim; it creates finer evidence for selecting and validating the next optimization.
