# Road query reliability — P3.4

## Measured problem

The real-Dhaka browser baseline captured on 2026-10-25 found that building viewport staging succeeded, but the default Overpass road request failed in all six measured samples. Requests consumed roughly 22 seconds; the server log contained HTTP 504 timeouts and an HTTP 502. This is a road-data availability issue, not evidence of a Cesium geometry bug.

Evidence: [run #40158078673](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40158078673), artifact ID 12585063810.

## Implemented reliability slice

- Use at most two ordered HTTPS Overpass endpoints: FOSSGIS main and Private.coffee global instance. The OpenStreetMap Wiki lists both as global instances; public endpoints can still be overloaded, so this is not an uptime guarantee.
- Bound each endpoint attempt to 9 seconds. Cancelling the viewport request stops fallback immediately.
- For a transient timeout/network failure/HTTP 429 or 5xx, try the next endpoint using a reduced query capped at 350 output ways. It prioritizes motorway/trunk/primary/secondary/tertiary links and residential/unclassified streets; footways, service roads and some local streets can be omitted in fallback mode.
- Do not retry non-transient 4xx responses.
- Mark API response with `detailLevel`, `X-Road-Network-Upstream-Attempts`, and `X-Road-Network-Detail-Level`. If every endpoint fails, return an explicit error instead of fake empty data.

## Validation gates

Tests cover endpoint configuration/HTTPS requirements, primary timeout/503 fallback, reduced query selection, non-retryable 400, invalid JSON, all-endpoint failure and cancellation. Run exact-SHA CI and a repeated real-Dhaka browser capture. The new capture must report full vs reduced detail and confirm actual road render events. If both public endpoints fail, next option is a regional OSM extract or an explicitly operated/paid provider, not unbounded retries.


## P3.4 follow-up: failed-viewport retry cooldown

The real-Dhaka logs show that repeated camera initialization/move events can re-request the same viewport after an expensive upstream timeout. RoadLayerManager now keeps a single bounded failed-viewport key with a 60-second retry deadline. Repeated requests for the same failed bounds are skipped during that cooldown; a different viewport can still load immediately. Expiry permits retry, and hiding the layer clears the cooldown so a user can manually toggle it off/on to retry. A successful road render clears the cooldown. Abort/cancel outcomes do not start the cooldown.

This is load-shedding, not data recovery: while a provider is down, the overlay may remain absent (or retain last rendered geometry). The regional/offline extract or reliable configured provider remains the next availability improvement.
