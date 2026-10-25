# P3.4.3 — Local/offline Dhaka road extract

The roads API now supports a verified local extract configured through `DHAKA_ROADS_EXTRACT_PATH`. When the extract coverage fully contains a requested viewport, it serves the local road features directly with `detailLevel: "offline"`, source URL/date headers and ODbL attribution. No Overpass request is made for that viewport. An invalid configured file returns an explicit 503 rather than silently waiting on public APIs. Viewports outside the configured coverage still use Overpass.

## Data source and licence

Use an OSM-derived road GeoJSON export with a real source URL/date. Geofabrik publishes regional extracts on its [official Bangladesh download page](https://download.geofabrik.de/asia/bangladesh.html). The country file is hundreds of megabytes, so do not commit the raw PBF. Keep the ODbL 1.0 licence and `© OpenStreetMap contributors` attribution.

## Prepare an extract

Install `osmium-tool`, download the Bangladesh PBF, then clip/filter/export roads. Example coverage: 90.30–90.55° E, 23.60–23.90° N.

```bash
osmium extract -b 90.30,23.60,90.55,23.90 bangladesh-latest.osm.pbf -o dhaka-area.osm.pbf
osmium tags-filter dhaka-area.osm.pbf w/highway -o dhaka-roads.osm.pbf
osmium export dhaka-roads.osm.pbf -o dhaka-roads.geojson --geometry-types=linestring
npm run prepare:dhaka-road-extract -- --input ./dhaka-roads.geojson --output ./data/roads/dhaka-road-network-v1.json --source-url https://download.geofabrik.de/asia/bangladesh-latest.osm.pbf --source-date YYYY-MM-DD --west 90.30 --south 23.60 --east 90.55 --north 23.90
```

Set `source-date` to the actual date of the downloaded extract. The importer writes the input SHA-256, source date, coverage, normalized feature count and licensing metadata. Then set `DHAKA_ROADS_EXTRACT_PATH` to the generated file in the runtime environment and restart the app. The loader limits files to 256 MiB and 500,000 road features, validates IDs/coordinates/widths/attribution, caches parsed data by file size/mtime and selects viewport-intersecting roads.

## Honest acceptance gate

The validator/importer and synthetic fixture tests are part of the code; **a real Dhaka offline extract is not included in this code change**. Until an actual licensed extract is imported/deployed and the browser baseline records `detailLevel: offline` and positive rendered road-entity counts, offline real-data recovery remains pending.
