# 3D Geospatial Platform

An experimental browser-based 3D geospatial app focused on exploring Dhaka buildings. The current pilot combines CesiumJS, OpenStreetMap imagery, and a local Overture-derived building dataset. The project is being built as a modular foundation for future property discovery, nearby-place layers, and interactive property visualization.

## Current capabilities

- Interactive Cesium globe centered on Dhaka with pan, zoom, rotation, tilt, and home-view controls.
- Overture-derived building footprints rendered as extruded 3D geometry.
- Camera-aware viewport requests with bounded feature budgets, spatially sampled results, response caching, request cancellation, and adaptive facade-detail budgets.
- Click-to-select building details, geographic coordinates, source attributes, and a camera-focus action.
- A map-layer panel to show or hide the OpenStreetMap street imagery and the Overture 3D building layer independently.
- A generated spatial-tile pipeline with a GeoJSON-index fallback and API diagnostics.

The displayed facade details are procedural visualizations. They are illustrative and are not verified architectural measurements.

## Tech stack

- **Next.js App Router + TypeScript** for the application and server API routes.
- **CesiumJS** for the 3D globe, camera, imagery, geometry, and picking.
- **GeoJSON + Overture-derived pilot data** for the current building dataset.
- **Node.js test runner** for the pure policy, spatial-tile, cache, and API integration tests.

Keep each responsibility behind a focused module; the Cesium-specific implementation lives behind the map-engine contract.

## Getting started

Use Node.js 24 (the same major version used by CI) and npm.

```powershell
npm install
npm run dev
```

Open [http://localhost:3000/map](http://localhost:3000/map). The `predev` script prepares the Cesium static assets automatically.

If the app reports that the Overture pilot dataset is missing, ensure the source GeoJSON file exists at `data/overture/dhaka-buildings.geojson`, then run the tile build command below.

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
npm run build:geospatial-tiles
npm run test:geospatial-tiles
npm run build
```

The API integration suite requires a running app. Start the development server in one terminal and run the test in another:

```powershell
npm run dev
npm run test:geospatial-api
```

CI also starts the production server and verifies the viewport endpoint against the built app.

## API routes

- `GET /api/geospatial/buildings` — legacy bounded OpenStreetMap building query.
- `POST /api/geospatial/buildings` — legacy OSM building query with a bounds payload.
- `GET /api/geospatial/overture-buildings` — pilot building collection.
- `GET /api/geospatial/overture-buildings/viewport?west=…&south=…&east=…&north=…&limit=…` — viewport-specific building data.

The viewport endpoint validates coordinate bounds and feature limits. Responses include diagnostic headers for data source, tile count, candidate/matched/returned features, truncation, sampling strategy, and cache activity.

## Current pilot limitations

This is not yet a production property marketplace. Property listings, rent/price availability, room and floor-plan modeling, indoor furniture configuration, AI interior design, and categorized nearby-place search still need their own data models and feature modules. The current dataset and visual quality should be treated as a Dhaka-focused technical pilot.

For more detail on tile generation, endpoint validation, diagnostics, and manual map checks, see [the Geospatial Tile Pipeline guide](docs/GEOSPATIAL-TILE-PIPELINE.md).
