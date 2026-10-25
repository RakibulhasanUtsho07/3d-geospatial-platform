# P3.4.3 — Local/offline Dhaka road extract

The roads API first honors `DHAKA_ROADS_EXTRACT_PATH` when it is configured. Otherwise, it automatically loads the bundled snapshot at `public/data/roads/dhaka-road-network-v1.json` when that file is present. If the extract coverage fully contains a requested viewport, the API serves local road features with `detailLevel: "offline"`, source URL/date headers and ODbL attribution; no Overpass request is made for that viewport. An invalid explicitly configured path returns an explicit 503 rather than silently waiting on public APIs. If no bundled snapshot exists, or the viewport falls outside extract coverage, the API uses Overpass.

## Data source and licence

Use an OSM-derived road GeoJSON export with a real source URL/date. Geofabrik publishes regional extracts on its [official Bangladesh download page](https://download.geofabrik.de/asia/bangladesh.html). The country file is hundreds of megabytes, so do not commit the raw PBF. Keep the ODbL 1.0 licence and `© OpenStreetMap contributors` attribution.

## Prepare an extract

Install `osmium-tool`, download the Bangladesh PBF, then clip/filter/export roads. Example coverage: 90.30–90.55° E, 23.60–23.90° N.

```bash
osmium extract -b 90.30,23.60,90.55,23.90 bangladesh-latest.osm.pbf -o dhaka-area.osm.pbf
osmium tags-filter dhaka-area.osm.pbf w/highway -o dhaka-roads.osm.pbf
osmium export dhaka-roads.osm.pbf -o dhaka-roads.geojson --geometry-types=linestring
npm run prepare:dhaka-road-extract -- --input ./dhaka-roads.geojson --output ./data/roads/dhaka-road-network-v1.json --source-url https://download.geofabrik.de/asia/bangladesh-latest.osm.pbf --source-date YYYY-MM-DD --source-sha256 "$(sha256sum bangladesh-latest.osm.pbf | cut -d ' ' -f1)" --west 90.30 --south 23.60 --east 90.55 --north 23.90
```

Set `source-date` to the actual date of the downloaded extract. The importer records the upstream source PBF SHA-256 separately from the intermediate GeoJSON normalization-input SHA-256, plus source date, coverage, normalized feature count and licensing metadata. Output files above 256 MiB are rejected so the importer cannot create a file the runtime loader refuses to read. To use this as an operator-managed override, set `DHAKA_ROADS_EXTRACT_PATH` to the generated file in the runtime environment and restart the app; otherwise, the bundled snapshot path is used automatically when present. The loader limits files to 256 MiB and 500,000 road features, validates IDs/coordinates/widths/attribution, caches parsed data by file size/mtime and selects viewport-intersecting roads.

## Honest acceptance gate

The validator/importer, CLI regression tests, and data-backed GitHub Actions workflow are part of the code. The workflow downloads the official Geofabrik Bangladesh PBF, reads the extract's actual timestamp and SHA-256, clips the Dhaka bbox, normalizes the road GeoJSON, stages the normalized file at `public/data/roads/dhaka-road-network-v1.json`, and starts the app **without** setting `DHAKA_ROADS_EXTRACT_PATH`. It verifies API provenance, byte-for-byte SHA-256 equality between the generated and bundled files, and all six cold/warm browser samples. Only after those checks pass does it commit a changed normalized snapshot to `rakibul-hasan`; the build and pull-request CI then validate branch promotion. A 14-day artifact retains the extract and screenshot/report bundle for investigation. The raw PBF is not committed or uploaded.

**Acceptance:** the workflow passes only with six `roadReadiness.status === "rendered"` records, each with positive rendered-feature count, zero pending road requests, `detailLevel: offline`, and zero Overpass attempts for the covered viewport. It stages the validated extract at the bundled runtime path, smoke-tests the API without an environment override, and commits the normalized snapshot to `rakibul-hasan` only after the checks pass. The raw PBF is never committed. Production receives the bundled snapshot through the normal branch promotion/deployment process; any refresh still needs to pass review/CI and must retain ODbL attribution.


## Workflow source timestamp note

The automated workflow reads the PBF's `header.option.osmosis_replication_timestamp`, which is a supported Osmium fileinfo variable for replication extracts. For a PBF without that header it falls back to the extended `data.timestamp.last` value. The downloaded file SHA-256 is captured independently, so the exact input remains pinned even if the upstream `latest` URL later changes.
