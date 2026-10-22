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
- Filterable **illustrative demo property listings** with rent, bedrooms, property type, furnishing, area and radius filters; browser-local saved favourites persist between visits.
- Selectable property map pins and a geodesic straight-line indicator from the discovery centre, plus nearest-per-category matching against loaded OpenStreetMap services within 1.5 km.
- A generated spatial-tile pipeline with a GeoJSON-index fallback and API diagnostics.
- A deterministic Building Generation Engine core: validated versioned BuildingSpec, procedural GLB output, and source/confidence + geometry-integrity QA reports.
- A map-side **Generated models** loader for placing already-reviewed GLB assets at explicit WGS84 coordinates, with focus, visibility and removal controls; loading is session-only and does not publish candidate files.
- A checksum-verified, versioned **published model catalog** with explicit human-review attestations and rollback; see [Published Generated Model Workflow](docs/PUBLISHED-GENERATED-MODEL-WORKFLOW.md).
- Local media intake with file-signature checking, SHA-256 content-addressed storage and licence/reuse status tracking; bounded video-to-frame extraction through FFmpeg.
- Multi-view COLMAP reconstruction adapter with textured PLY-to-GLB conversion, an FFmpeg-based image-quality preflight, and a shared GLB integrity/geometry QA report for procedural, photogrammetry, and single-image AI outputs.
- Evidence-based Building Accuracy Benchmark that reports dimension errors, horizontal ground-control residuals, and human visual-review outcomes separately; it never calculates an unsupported single accuracy percentage.

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

### Road geometry and architecture research implementation

- The default **Detailed OSM roads** layer draws viewport-clipped vector road geometry from OpenStreetMap, with mapped road names/classes (including connector ramps and steps), tagged or estimated width, surface colours, bridge/tunnel hints and an OSM way details panel. If width or elevation tags are absent, those visual properties are estimates, not a survey.
- Select an Overture building, then use **Dhaka Architecture Library** to inspect source images (Wikimedia Commons previews only for CC BY/CC BY-SA candidate records) and embedded YouTube street-context videos. Source pages with unclear image reuse rights remain link-only.
- **Apply & save to this building** saves a chosen facade/roof profile against the selected Overture feature ID in this browser. Named research may affect procedural wall texture and, where metadata is unambiguous, rendered height/storey estimate; source-reported built area and metadata are shown separately in Building Details. This is a user-confirmed visual association, not automatically verified identity or a photogrammetry model.
- Broad skyline, panorama and multi-building-cluster references are blocked from assignment to an individual footprint. Mixed-wing house descriptions are not collapsed into one floor count.
- Saved assignments live in browser local storage; they are not shared with other devices/users and are not uploaded to a persistent server database.


If the app reports that the Overture pilot dataset is missing, ensure the source GeoJSON file exists at `data/overture/dhaka-buildings-3d-pilot.geojson`, then run the tile build command below.

## Loading a reviewed generated model in the map

The `/map` view includes a **Generated models** panel that loads an existing GLB static asset and lets you set its WGS84 origin, height, heading and scale. For safety, it does not upload files or automatically expose output from the local generation workspace.

Only after appropriate review, place the approved GLB under `public/models/generated/`, open `/map`, and enter its same-origin URL (for example `/models/generated/my-building.glb`). Model placements exist only in the current map session. See [Generated Model Map Loader](docs/GENERATED-MODEL-MAP-LOADER.md) for the full workflow and limits.

## Building Generation Engine

The engine supports three routes: information/measurements → deterministic procedural GLB; approved multi-view images/video frames → COLMAP textured reconstruction candidate; and one approved image → TripoSR AI-proposed preview. Each route retains source provenance, confidence labels and a QA report.

A single local command now orchestrates **BuildingSpec + image/video inputs → source-rights metadata → (video frame extraction) → chosen generation route → GLB + workflow QA report**. Example with an image:

~~~powershell
npm run build:building-from-media -- E:\Building-Engine-Workspace .\building-spec-base.json dhaka-job-01 --source front-photo=uploads\front.jpg --licence "front-photo=CC BY 4.0" --author "front-photo=Photographer Name" --attribution "front-photo=Required source credit" --confirm-rights --strategy procedural
~~~

For a video input, use --source site-walk=uploads\site-walk.mp4 --licence "site-walk=CC BY 4.0" --confirm-rights; FFmpeg extracts a bounded set of child frame records. To preview one image using locally installed TripoSR, add --strategy single-image-ai --views front-photo --runner-script E:\Tools\TripoSR\run.py --confirm-single-view-inference --device cuda:0. To use COLMAP, provide 3+ selected overlapping views via --views front-photo,side-photo,site-walk-frame-000001, --strategy photogrammetry, --up-axis Z, and --confirm-same-building --confirm-overlap-reviewed --confirm-up-axis-reviewed; install COLMAP separately.

The base BuildingSpec must already contain the building’s real footprint, location and whatever measured dimensions/style facts are available.
For horizontal map alignment from measured survey/control points, place at least three non-collinear control points in JSON with each point's `modelX`, `modelZ` (coordinates in this exact exported GLB), `longitude` and `latitude`. Then pass `--control-points` to the unified command. The engine estimates model scale, rotation, WGS84 origin and fit residuals. The result is still `mapReady: false`: vertical elevation datum and human QA are separate requirements.
 Unknown facts stay unknown: an image/video is not silently treated as measured scale or as a precise WGS84 survey. The command writes the model, normalized BuildingSpec and workflow report under .building-engine/jobs/<buildingId>/<jobId>-workflow. Results remain review candidates, never auto-published to /map.

~~~powershell
npm run test:glb-geometry-qa
npm run test:building-generation
npm run generate:building-model -- tests/fixtures/demo-building-spec.json artifacts/dhaka-demo-01.glb
npm run test:building-media
npm run ingest:building-media -- E:\Building-Engine-Workspace dhaka-demo walkthrough-01 uploads\walkthrough.mp4 auto 0.5 60
npm run test:building-source-workflow
npm run test:media-quality-preflight
npm run test:image-quality-preflight
npm run test:colmap-worker
npm run test:single-image-3d
~~~

**Review each source's rights and metadata.** This command records the operator's explicit licence/permission attestation; it does not prove copyright ownership for them:

~~~powershell
npm run review:building-source -- E:\Building-Engine-Workspace dhaka-demo front-photo --licence "CC BY 4.0" --confirm-rights --author "Photographer name" --attribution "Required credit and source"
~~~

Once source records have been ingested (and the relevant rights reviewed), join their current SHA-256/asset IDs/licence/status into a valid BuildingSpec without hand-copying the source fields:

~~~powershell
npm run prepare:building-spec -- E:\Building-Engine-Workspace .\building-spec-base.json front-photo,walkthrough-01-frame-000001,walkthrough-01-frame-000002 .\building-spec-ready.json
~~~

Before launching COLMAP, optionally create a persistent source-media quality/rights report:

~~~powershell
npm run assess:building-media -- <workspaceRoot> <buildingId> <sourceId1,sourceId2,...>
~~~

The assessment re-verifies ingested source hashes, checks JPEG/PNG dimensions and a small FFmpeg grayscale sample, reports heuristic sharpness/luminance/contrast and perceptual near-duplicates, and writes a timestamped JSON report beside the source metadata. It never proves camera overlap or same-building identity, and it does not replace the worker's required operator confirmations.

For multi-view reconstruction, install COLMAP separately. If the selected views overlap and depict the same building, use the command documented in the engine guide. A minimum of three approved images can be reconstructed as a local mesh even when the images have no GPS tags; precise map placement still needs ground-control registration.

For single-photo AI preview, install TripoSR and its Python/PyTorch dependencies separately:

~~~powershell
npm run generate:building-from-image -- E:\Building-Engine-Workspace .\building-spec-ready.json ai-preview-01 front-photo --runner-script E:\Tools\TripoSR\run.py --confirm-single-view-inference --device cuda:0
~~~

A single image cannot verify hidden sides, dimensions, room plans or real scale. COLMAP/AI outputs remain review-only (mapReady: false, publicationEligible: false); neither route publishes assets to /map. Read [Building Generation Engine](docs/BUILDING-GENERATION-ENGINE.md) for limitations and QA gates.
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
npm run test:property-listings
npm run test:street-imagery
npm run test:architecture-research
npm run test:road-network
npm run test:building-style
npm run test:building-generation
npm run test:building-media
npm run test:building-source-workflow
npm run test:media-quality-preflight
npm run test:media-to-model-workflow
npm run test:ground-control-registration
npm run test:colmap-worker
npm run test:single-image-3d
npm run build:geospatial-tiles
npm run test:geospatial-tiles
npm run build
```

The API integration suite requires a running app. Start the development server in one terminal and run the test in another:

```powershell
npm run dev
npm run test:geospatial-api
```

CI also starts the production server and verifies the viewport endpoint, nearby-place request validation, and a successful filtered property search against the built app.

## API routes

- `GET /api/geospatial/buildings` — legacy bounded OpenStreetMap building query.
- `POST /api/geospatial/buildings` — legacy OSM building query with a bounds payload.
- `GET /api/geospatial/overture-buildings` — pilot building collection.
- `GET /api/geospatial/overture-buildings/viewport?west=…&south=…&east=…&north=…&limit=…` — viewport-specific building data.
- `GET /api/geospatial/overture-buildings/search?q=…&limit=8` — bounded search through names, source attributes, categories, and feature identifiers. Queries must be 2–100 characters; results are capped at 20.
- `GET /api/geospatial/nearby-places?lat=…&lon=…&radius=800&categories=pharmacy,hospital&limit=100` — nearby pharmacies, hospitals, clinics, supermarkets, and markets. Radius is capped at 1.5 km and results at 150.
- `GET /api/geospatial/properties?lat=…&lon=…&radius=5000&minRent=15000&maxRent=45000&minBedrooms=2&type=apartment&furnishing=all&limit=50` — bounded demo-property discovery with rent, type, bedroom, furnishing, text and radius filters. Saved-only queries accept a browser-provided `savedIds` list.
- `GET /api/geospatial/street-imagery?lat=…&lon=…&radius=250&limit=25` — on-demand public KartaView street-image reference discovery for a selected building. Search radius is capped at 500 m and results at 50.
- `GET /api/geospatial/roads?west=…&south=…&east=…&north=…&limit=1000` — viewport-bounded OSM road centerline geometry, road class/name and sourced-or-estimated road width, cached for 10 minutes.
- `GET /api/geospatial/architecture-research?q=…&area=…&style=…&mediaType=image&usage=research-only&limit=50` — bounded research catalogue for Dhaka architectural references, facade color palettes, location confidence and image/video licence status. The maximum result limit is 50.

The viewport endpoint validates coordinate bounds and feature limits. Responses include diagnostic headers for data source, tile count, candidate/matched/returned features, truncation, sampling strategy, and cache activity. The search API caches a compact search index in memory and returns only summary fields needed by the map UI.

Nearby-place results come from the public OpenStreetMap Overpass API and are cached in application memory for five minutes, with duplicate in-flight requests coalesced and active upstream queries bounded. Public Overpass instances are shared community infrastructure intended for modest workloads; a production deployment with growing usage should move to a managed data provider or an operated instance. OSM content is attributed to OpenStreetMap contributors under the ODbL.

## Current pilot limitations

This is not yet a production property marketplace. The property API currently returns clearly labelled illustrative seed records for prototyping; they are not real offers and have no verified prices, owner information, or live availability. Saved listings are stored in the current browser only. Road-network routing, room and floor-plan modeling, indoor furniture configuration and AI interior design still need dedicated data sources and feature modules. Service matching is limited to mapped OpenStreetMap objects returned by the latest nearby query; straight-line distances are not walking or driving routes. The current building dataset and visual quality remain a Dhaka-focused technical pilot. Public street-imagery discovery can show nearby KartaView references for a selected building, but it does not guarantee city-wide or exact-building coverage and does not automatically reconstruct architecture. See [Street Imagery and Reconstruction](docs/STREET-IMAGERY-AND-RECONSTRUCTION.md) for licence, confidence and photogrammetry notes.


## Building visual-reference research

A curated starter set of Dhaka building-photo and video references, architecture observations, source metadata, licence/permission notes, and reconstruction-confidence guidance is stored in [the Dhaka Building Image & Video Research Catalogue](docs/research/DHAKA-BUILDING-IMAGE-VIDEO-CATALOGUE.md). A machine-readable version is available at [the JSON reference catalogue](data/research/dhaka-building-reference-catalog.json). This is not a complete city-wide photo inventory. Copyrighted/editorial/listing imagery is recorded as research-only unless reuse rights are confirmed; external media is not copied into the repository. A separate [Architecture Typology & Reconstruction Notes](docs/research/DHAKA-ARCHITECTURE-TYPOLOGY-AND-RECONSTRUCTION-NOTES.md) document turns the research into procedural-model families, confidence levels, suggested parameters and a safe reconstruction workflow. The map page also provides a filterable Dhaka Architecture Library and a detailed, width-aware OSM vector road layer; selected-building details display source-reported facade/roof attributes, while the procedural facade renderer honours explicit source colours and recognised style/material metadata. To use it, open `/map`, select a 3D building, scroll below the map to **Dhaka Architecture Library**, choose a reference and select **Preview style on selected building**. The preview is temporary and can be reset; it is not a verified match to the real building. Video-only records remain context references and cannot be applied as facade styles. The expanded [Architecture, Location, Facade Colour & UI Design System](docs/research/DHAKA-ARCHITECTURE-AND-UI-DESIGN-SYSTEM.md) consolidates the research, and [the design-system JSON](data/research/dhaka-architecture-design-system.json) contains proposed light/dark UI tokens, map/POI colours, architecture palettes and location clusters. The structured catalogue currently contains 33 image/video/project source records with per-reference design/location confidence fields; colours remain estimated and are not sampled material measurements.
For more detail on tile generation, endpoint validation, diagnostics, and manual map checks, see [the Geospatial Tile Pipeline guide](docs/GEOSPATIAL-TILE-PIPELINE.md).

### Building Accuracy Benchmark

Use `npm run benchmark:building-accuracy -- <candidate.glb> <benchmark.json> [report.json]` to compare a candidate model against independent reference dimensions, optional surveyed ground control, and an exact-GLB-bound render/reference review. See [the benchmark guide](docs/BUILDING-ACCURACY-BENCHMARK.md) for evidence requirements and interpretation. A passing result still requires human release review and never enables map publishing.

### Render/reference image similarity diagnostics

Use `npm run compare:render-reference-images -- <reference.jpg|png> <candidate-render.jpg|png> [report.json]` to calculate bounded grayscale MAE/RMSE, PSNR, local SSIM and difference-hash diagnostics for one manually paired view. These are diagnostic hints only: same-facade/camera alignment remains a human responsibility, and the metrics never certify architectural accuracy or approve publication. See [the diagnostics guide](docs/RENDER-IMAGE-SIMILARITY-DIAGNOSTICS.md).

Optional per-view similarity diagnostics can be attached to the existing reference-review report using `similarityDiagnosticsPath` in each comparison. The workflow validates that report metrics identify the exact render/reference bytes and leaves all human review outcomes unchanged. See the [image diagnostics guide](docs/RENDER-IMAGE-SIMILARITY-DIAGNOSTICS.md).


### Durable building generation, review and map publishing

Generation requests are persisted in a local file-backed queue and run by `scripts/run-generation-worker.mjs`. The separate review API verifies the completed GLB and QA report hashes before recording an explicit decision. To publish a reviewed job to the map's versioned GLB catalog, use `npm run publish:approved-generation-job` with the job ID and explicit surveyed placement. Read the [generation queue/worker guide](docs/GENERATION-JOBS-API-AND-WORKER.md), [reviewed model catalog guide](docs/PUBLISHED-GENERATED-MODEL-WORKFLOW.md), and [map loader guide](docs/GENERATED-MODEL-MAP-LOADER.md). The job itself remains fail-closed after publication; catalog publication does not bypass the review evidence gate.


### Authenticated generation media upload

The backend also provides `POST /api/building-generation/uploads` for authenticated multipart uploads of building photos, videos and floor-plan PDFs. It enforces a bounded request body, validates file signatures, writes a private content-addressed source record, and leaves its rights status `unreviewed`. Set `GENERATION_API_TOKEN` and keep it on the server; never embed it in browser JavaScript. The API upload limit is 50 MiB per file (images retain the intake module's 20 MiB limit). See [Building Generation Engine](docs/BUILDING-GENERATION-ENGINE.md#8-authenticated-media-upload-api) for usage.


Generation job enqueueing now preflights each supplied source: the path must already exist inside the private workspace as a non-empty regular file, with no symlink path components, and must stay within the source-kind size limit. Actual media signature and provenance validation still runs in the worker.


### Measured floor-plan to interior GLB

A deterministic shell builder now extrudes **explicit measured/vector floor-plan geometry** into a reviewable GLB with rooms, floor slabs, walls, doors and windows: `npm run generate:floor-plan-model -- <geometry.json> <output.glb> [original-source-file]`. It does not infer room walls from a PDF/image; floor-plan tracing/conversion and human review are still required. See the [engine guide](docs/BUILDING-GENERATION-ENGINE.md#12-measured-floor-plan-vectors-to-interior-glb).


### Authenticated floor-plan candidate API

The backend can create a private interior GLB candidate from a complete measured/vector floor-plan JSON tied to an uploaded source classified as floor-plan. It verifies the source checksum against the protected intake store, saves a report/model privately, and offers bearer-token-protected report and GLB retrieval endpoints. This does not extract vector geometry from a raster/PDF automatically or publish models to the map. See the engine guide section 13, Authenticated floor-plan candidate API.


### Floor-plan review and publication

Candidates created from measured floor-plan vectors can be reviewed through a separate authenticated review API, then published only via an explicit hash-verified catalog command after approval. Source rights must be reviewed before candidate generation; rejected or changes-requested reviews do not create a publishing attestation. Run `npm run publish:floor-plan-candidate -- <workspaceRoot> <buildingId> <candidateId>` only after an approved review. Automatic PDF/image-to-vector tracing remains unimplemented. See section 14 in [the engine guide](docs/BUILDING-GENERATION-ENGINE.md).


### Raster floor-plan trace candidates

The engine can analyze an uploaded floor-plan raster (JPEG/PNG/WebP) to propose horizontal/vertical wall lines and closed rectangular room candidates. Traces remain private, hash-checked, pixel-based and unreviewed until a human corrects them and supplies measured scale/georeferencing. The detector is a limited orthogonal-line heuristic; it does not read dimensions or infer angled walls, and it does not auto-publish. See section 15 in [the engine guide](docs/BUILDING-GENERATION-ENGINE.md).
