# Geospatial Tile Pipeline

## Build and verify the pilot tiles

Run these commands from the project root after the pilot GeoJSON dataset is present:

```powershell
npm run build:geospatial-tiles
npm run test:geospatial-tiles
npm run lint
npm run build
```

The tile builder creates a manifest and coarse spatial GeoJSON files under
`data/overture/spatial-tiles`. The viewport endpoint selects candidate tiles
from the manifest, filters candidate feature bounds against the requested
viewport, and deduplicates feature identities before returning the result.

## API integration tests

Keep the development server running in one terminal:

```powershell
npm run dev
```

Run the integration suite in a second terminal:

```powershell
npm run test:geospatial-api
```

The suite checks invalid bounds, the viewport-size limit, generated-tile
selection, and reuse of parsed tile data. Set `GEOSPATIAL_API_BASE_URL` to
override the default `http://localhost:3000` base URL.

## Runtime diagnostics

Viewport responses expose these headers:

- `X-Building-Data-Source`: `generated-tiles` or the GeoJSON-index fallback.
- `X-Building-Tile-Count`: number of manifest tiles intersecting the viewport.
- `X-Building-Candidate-Feature-Count`: candidates loaded from selected tile
  files and the optional oversized-feature sidecar, before viewport filtering.
- `X-Building-Feature-Count`: deduplicated features returned to Cesium.
- `X-Building-Tile-Cache-Hits`: cached tile files reused by this request.

The server keeps parsed tiles in a bounded LRU cache. Cache entries retain
precomputed geometry bounds and feature identities and are validated against
each file's size and modification time. Rebuilt tiles are picked up after their
file signatures change.

A successful API response does not prove the Cesium render is visually correct.
After the integration suite passes, inspect the map while zooming and panning
and check the browser console for rendering errors.
