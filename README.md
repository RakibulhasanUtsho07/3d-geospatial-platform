# 3D Geospatial Platform

An experimental browser-based 3D geospatial app focused on exploring Dhaka buildings. The current pilot combines CesiumJS, OpenStreetMap imagery, and a local Overture-derived building dataset. The project is being built as a modular foundation for future property discovery, nearby-place layers, and interactive property visualization.

## Current capabilities

- Interactive Cesium globe centered on Dhaka with pan, zoom, rotation, tilt, and home-view controls.
- Overture-derived building footprints rendered as extruded 3D geometry.
- Camera-aware viewport requests with bounded feature budgets, spatially sampled results, response caching, request cancellation, and adaptive facade-detail budgets.
- Click-to-select building details, geographic coordinates, source attributes, and a camera-focus action.
- Approximate ground footprint in square metres and square feet; when a floor count exists, an explicitly labeled gross floor-area estimate.
- Bounded building-discovery search across source names, attributes, categories, and Overture IDs; selecting a result moves the camera to its geographic center.
- A map-layer panel to show or hide OpenStreetMap street imagery, Overture 3D buildings, and nearby service markers independently.
- Nearby-place discovery for pharmacies, hospitals, clinics/medical centres, supermarkets, and markets/bazars around the visible map centre; results can be focused and opened in OpenStreetMap.
- A generated spatial-tile pipeline with a GeoJSON-index fallback and API diagnostics.

The displayed facade details are procedural visualizations. Building footprint area is approximated from the selected polygon with a local projection; gross floor area multiplies that estimate by the available floor count. These are not survey measurements, verified total floor areas, or individual flat sizes.

## Tech stack

- **Next.js App Router + TypeScript** for the application and server API routes.
- **CesiumJS** for the 3D globe, camera, imagery, geometry, and picking.
- **GeoJSON + Overture-derived pilot data** for the current building dataset.
- **Node.js test runner** for the pure policy, spatial-tile, cache, search, and API integration tests.

Keep each responsibility behind a focused module; the Cesium-specific implementation lives behind the map-engine contract.

## Getting started

Use Node.js 24 (the same major version used by CI) and npm.

```powershell
npm install
npm run dev
```

Open [http://localhost:3000/map](http://localhost:3000/map). The `predev` script prepares the Cesium static assets automatically.

If the app reports that the Overture pilot dataset is missing, ensure the source GeoJSON file exists at `data/overture/dhaka-buildings-3d-pilot.geojson`, then run the tile build command below.

## Geospatial data pipeline

Generate the coarse spatial tiles and manifest from the pilot dataset:

```powershell
npm run build:geospatial-tiles
npm run test:geospatial-tiles
```

The generated output is written under `data/overture/spatial-tiles`. The viewport API uses intersecting tiles when they are valid and available, and falls back to the indexed pilot GeoJSON when tile data is unavailable or invalid.

## Quality checks

```powershell
npm run lint
npm run test:viewport-budget
npm run test:lod-budget
npm run test:viewport-selection
npm run test:viewport-cache
npm run test:viewport-load-policy
npm run test:building-search
npm run test:footprint-area
npm run test:nearby-places
npm run build:geospatial-tiles
npm run test:geospatial-tiles
npm run build
```

The API integration suite requires a running app. Start the development server in one terminal and run the test in another:

```powershell
npm run dev
npm run test:geospatial-api
```

CI also starts the production server and verifies the viewport and building-search endpoints against the built app.

## API routes

- `GET /api/geospatial/buildings` — legacy bounded OpenStreetMap building query.
- `POST /api/geospatial/buildings` — legacy OSM building query with a bounds payload.
- `GET /api/geospatial/overture-buildings` — pilot building collection.
- `GET /api/geospatial/overture-buildings/viewport?west=…&south=…&east=…&north=…&limit=…` — viewport-specific building data.
- `GET /api/geospatial/overture-buildings/search?q=…&limit=8` — bounded search through names, source attributes, categories, and feature identifiers. Queries must be 2–100 characters; results are capped at 20.
- `GET /api/geospatial/nearby-places?lat=…&lon=…&radius=800&categories=pharmacy,hospital&limit=100` — nearby pharmacies, hospitals, clinics, supermarkets, and markets. Radius is capped at 1.5 km and results at 150.

The viewport endpoint validates coordinate bounds and feature limits. Responses include diagnostic headers for data source, tile count, candidate/matched/returned features, truncation, sampling strategy, and cache activity. The search API caches a compact search index in memory and returns only summary fields needed by the map UI.

Nearby-place results come from the public OpenStreetMap Overpass API and are cached in application memory for five minutes, with duplicate in-flight requests coalesced and active upstream queries bounded. Public Overpass instances are shared community infrastructure intended for modest workloads; a production deployment with growing usage should move to a managed data provider or an operated instance. OSM content is attributed to OpenStreetMap contributors under the ODbL.

## Current pilot limitations

This is not yet a production property marketplace. Property listings, rent/price availability, room and floor-plan modeling, indoor furniture configuration, AI interior design, and categorized nearby-place search still need their own data models and feature modules. The current dataset and visual quality should be treated as a Dhaka-focused technical pilot.

For more detail on tile generation, endpoint validation, diagnostics, and manual map checks, see [the Geospatial Tile Pipeline guide](docs/GEOSPATIAL-TILE-PIPELINE.md).
