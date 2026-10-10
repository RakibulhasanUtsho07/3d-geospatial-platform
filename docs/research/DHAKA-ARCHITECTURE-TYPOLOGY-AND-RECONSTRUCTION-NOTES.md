# Dhaka Architecture Typology & Reconstruction Notes

**Research date:** 10 October 2026  
**Project:** 3D Geospatial Platform  
**Purpose:** Turn the expanded source catalogue into practical modelling guidance. These are evidence-led hypotheses and model families, not a set of measured building plans.

Related data:
- [Image/video source catalogue](DHAKA-BUILDING-IMAGE-VIDEO-CATALOGUE.md)
- [Structured reference JSON](../../data/research/dhaka-building-reference-catalog.json)

## 1. Research outcome

The sources show that “a Dhaka house” should not be represented by one universal facade generator. A practical first-stage model library should distinguish:
1. contemporary multi-storey apartment blocks;
2. low-rise 1970s–1980s duplex/family houses;
3. Old Dhaka courtyard houses and narrow-lane row buildings;
4. formal heritage mansions and garden houses;
5. dense mid-rise urban blocks where exact building-level evidence is weak.

The distinction matters because the external outline alone does not represent courtyard voids, wings at different heights, balconies, entrances, roof spaces or the close street relationships visible in the sources.

## 2. Building typology families

### A. Contemporary multi-storey apartment

**Research references**
- Banani Model Town photos, CC BY-SA 4.0: https://commons.wikimedia.org/wiki/File:In_Banani_Model_Town_02.jpg and https://commons.wikimedia.org/wiki/File:A_house_in_Banani_Model_Town,_Dhaka_02.jpg
- Open-licensed apartment-building photo with a Dhaka camera viewpoint: https://commons.wikimedia.org/wiki/File:Apartment_buildings_in_Dhaka_(30569828554).jpg
- Bashundhara design case study (rights to page imagery not established): https://www.studio16architectsbd.com/project-apartment-sakoon-bashundhara
- Bashundhara project case study (rights to page imagery not established): https://wedesignstudiobd.com/portfolio/florence/
- Additional developer-reported residential project reference: https://www.ddpl.com.bd/project-info/23

**Observed or source-reported features**
- Repeated floor bands and window/balcony rhythm.
- Balconies may repeat on every floor or vary by side/design.
- White/light plaster and glass are used in some contemporary design projects; other buildings use paint, tile, exposed brick or mixed cladding.
- In the Sakoon project brief, north- and south-side balconies, ground-level parking/lobby, larger windows and a shared roof garden are described by the architect.
- The DDPL project page reports a Ground + 8 building and a defined programme for parking/services at ground level and apartments above. This is project-page data and not a universal pattern.

**Procedural model components**
- **BuildingMass** from a sourced footprint or a clearly marked estimated footprint.
- **FloorStack** controlled by sourced/estimated storey count and floor-to-floor height.
- **FacadeBayPattern** for window, balcony and wall-bay repetition.
- **BalconyModule** that can be omitted, repeated, alternating or terraced.
- **GroundFloorProgramme** to represent parking/open lobby/service rooms only when supported by a source.
- **RoofComposition** for parapet, stair/lift headhouse, terrace or garden only where visible or reported.

**Do not assume**
- All contemporary apartments have a rooftop garden or a glass railing.
- A marketing render matches the finished building.
- Storey count or apartment size reported by a developer is a surveyed measurement.

### B. 1970s–1980s duplex and family house

**Research reference:** The Business Standard's feature on surviving or formerly present duplexes: https://www.tbsnews.net/features/panorama/last-dhakas-70s-era-duplexes-1028486

The article discusses examples from areas including Khilgaon, Dhanmondi, Malibagh, Moghbazar, Shantinagar, Agargaon, Gulshan and Banani. It describes U-shaped or courtyard arrangements in some cases, open space in front/back, flat roofs, boxy massing, large grilled windows, concrete/exposed brick, vertical louvres and horizontal sunshades. Some examples have been changed or replaced.

**Procedural model components**
- Lower **FloorStack** (often one or two levels in the examples discussed, but the count must be confirmed per specific reference).
- Simple boxy mass with flat roof/parapet.
- Broad window openings and separate grille geometry.
- Optional porch, shaded veranda, courtyard and front/back setback.
- Optional existing tree/green canopy as a separate environment asset.

**Modelling note:** When a historic photo shows a courtyard or large tree, model the negative space/tree relationship instead of filling the entire footprint with a solid extrusion. A historic reference does not prove what stands at that address today.

### C. Old Dhaka courtyard house and narrow-lane fabric

**Research references**
- DUET paper, *Dwelling Morphology of Courtyard Houses in Old Dhaka: A Study on Spatial Adaptations*: https://www.duet.ac.bd/storage/journal/volume-8-issue-1-2-december-2022%2813-23%29-1678357453.pdf
- Research on multiple-courtyard mansions: https://www.researchgate.net/publication/267224136_MULTIPLE_COURTYARD_MANSIONS_OF_OLD_DHAKA
- Heritage-street documentation paper: https://zenodo.org/records/4471305
- Photo feature for Beauty Boarding: https://www.jagonews24.com/photo/bangladesh/photo-feature/1471
- Heritage walk/history overview: https://www.thedailystar.net/a-walk-down-history-lane-9601

The DUET paper describes traditional courtyard houses as spatial arrangements where rooms face inward towards a courtyard, while noting that layouts have adapted under changing household needs and pressure to accommodate more households. The multiple-courtyard mansion research describes European/classical facade influences combined with locally arranged space around one or more courtyards. A heritage walk account notes narrow entrances, courtyards, pillars/arches, narrow stairways and roof terraces with railings in visited buildings.

**Procedural model components**
- **CourtyardVoid** cut out from the building mass rather than painted onto a roof.
- **WingMass** pieces with independent heights around the court.
- **ArcadeOrVeranda** modules along inner/outer facade.
- Optional columns, arches, decorated parapet and metal balustrade as separate geometry.
- Narrow entrance/threshold and stair/roof elements only where visible.
- **PartyWall** or close-neighbour relation for row-house settings.

**Important limitation:** The source studies provide typological and spatial observations, not a measured BIM model for every Old Dhaka house. Do not derive an exact room plan from a facade photograph.

### D. Heritage mansion and garden house

**Research reference:** Rose Garden Palace article: https://online92.thedailystar.net/news/bangladesh/news/rose-garden-palace-where-legacy-blooms-4142916

The article places Rose Garden on KM Das Lane in Tikatuli and reports its construction in 1931. It describes a mansion with Greek-style influence, sculpture, a garden, fountain/pond, coloured glass staircase details and a large hall. A separate Old Dhaka source discusses Mangalabash in Shyambazar with multiple courtyards, columns and differently sized wings: https://en.prothomalo.com/lifestyle/tcbns10q0i

**Procedural model components**
- Distinct formal central mass rather than a generic repeated apartment stack.
- Separate facade ornament, columns, window surrounds and parapet.
- Garden walls, pathway, pond/fountain and trees as separate landscape objects.
- Courtyard or wing volumes when a reliable source demonstrates their layout.

**Reuse warning:** Article photographs are research references unless their copyright holder grants reuse. Architectural descriptions can inform a model specification without copying protected photo pixels.

### E. Dense mid-rise blocks and streetscape

**Research references**
- Geolocated viewpoint photo of apartment buildings: https://commons.wikimedia.org/wiki/File:Apartment_buildings_in_Dhaka_(30569828554).jpg
- A panoramic Gulshan-1 context reference: https://commons.wikimedia.org/wiki/File:Red_Rocket_-_panoramio.jpg
- Skyline context: https://commons.wikimedia.org/wiki/File:ক্রমবিকাশমান_ঢাকা_স্কাইলাইন.jpg
- Walking videos: https://www.youtube.com/watch?v=orB6n7bX-uk and https://www.youtube.com/watch?v=vm8t_cW2xD0

**Context features to model separately from individual buildings**
- Distance from facade to road and sidewalk.
- Very narrow passage/lane or more open residential road.
- Neighbouring buildings touching or nearly touching side walls.
- Trees, garden edges, street-level shops, surface parking and overhead utility cables when visible.
- Occlusion and visibility: adjacent buildings may hide the side/rear elevation.

Street videos are helpful for classifying urban context, but not automatically suitable for photogrammetry. The camera is moving, camera calibration/pose may be absent and each view may not overlap the same facade enough for reliable reconstruction.

## 3. Suggested parameter schema

Store observed properties separately from inferred values. A candidate record for the procedural model layer could carry:

| Parameter | Meaning | Evidence rule |
|---|---|---|
| footprintSource | Dataset or survey providing the ground outline | Preserve original source ID and geometry |
| storeyCount | Number of visible/reported floors | Store source and confidence; never guess silently |
| floorHeightEstimate | Estimated vertical module | Label as estimated unless a measured plan exists |
| roofType | Flat, parapet, terrace, pitched or unknown | Populate only when visible/sourced |
| facadeBayCount | Repeating visual facade modules | Estimate from a near-frontal image; record uncertainty |
| windowPattern | Size, rhythm, grille/shading hints | Store observations, not exact physical dimensions |
| balconyPattern | None, repeating, alternating, terraced, unknown | Derive from visible facade view |
| groundFloorUse | Parking, entrance, shops, housing or unknown | Needs visible evidence or source record |
| courtyardTopology | None, inner court, multiple courts, U-shaped opening, unknown | Requires plan-like evidence or enough views |
| roofFeatures | Parapet, stair headhouse, rooftop room, garden, tank | Add only when seen or reliably sourced |
| materialClass | Painted plaster, exposed brick, tile, glass/metal, unknown | Visual class only; don't claim exact material composition from colour alone |
| streetContext | Lane width class, setbacks, trees, adjacent wall relation | Separate streetscape layer from the building mesh |
| sourceProvenance | URL, author, licence, capture date, attribution and edits | Required for every source-derived mesh or texture |
| matchConfidence | Match between reference and mapped footprint | Must reflect location, shape and visual evidence; proximity alone is not enough |

The names above are a proposed project schema, not a claim that these attributes are available for every building.

## 4. Confidence levels for model production

- **L0 — footprint only:** render a basic footprint extrusion; no facade claims.
- **L1 — massing estimate:** use source floor count/height where available, otherwise mark estimated height.
- **L2 — single-view facade reference:** infer visible facade rhythm and colour blocks; hidden sides remain generic and visibly lower confidence.
- **L3 — multi-view candidate:** multiple overlapping views plausibly depict the same structure from useful angles. This is only a candidate for photogrammetry, not proof the mesh will be accurate.
- **L4 — reviewed reconstruction:** inspect the generated mesh against the evidence, note occlusions and review geometry/texture for errors.
- **L5 — surveyed/authoritatively documented:** use measured drawings or reliable survey evidence, retain the evidence and its provenance.

Do not promote a building to a higher confidence level merely because the source image is high resolution. Identity, camera angle, overlap, coverage, scale and independent validation also matter.

## 5. Image and video collection policy

1. Prefer open-licensed sources, including the specific Wikimedia Commons files whose individual file page states CC BY or CC BY-SA; store their actual licence variant at the record level.
2. For CC BY, retain creator attribution, source link, licence link and change notice. For CC BY-SA adaptations, assess ShareAlike obligations before distribution.
3. Do not assume an image on a developer, news or property listing site is reusable. Several such pages in the catalogue are explicitly marked **research-only**.
4. A coordinate in image metadata may be the camera position or a photo viewpoint, not a building's center. Check the visible facade against the footprint before attaching the image.
5. Keep video URLs as discovery/review references. Do not extract frames or use them as a training/texture dataset without rights clearance.
6. Avoid collecting private interiors, personally identifying details, faces or vehicle plates as building assets. If they enter the frame incidentally, apply suitable review/redaction before any publication.
7. A 3D mesh, its textures, and the raw source images must be separately tracked by licence and provenance.

## 6. Recommended workflow for the project

1. Select a mapped Overture footprint and preserve its source attributes/ID.
2. Query on-demand street imagery and search this curated catalogue for likely visual references.
3. Confirm building identity using coordinate viewpoint, heading when available, visible roof/footprint outline and neighbouring landmarks. Keep an unresolved match unresolved.
4. Estimate storeyCount, facade pattern, balconies, roof elements and material class with confidence labels.
5. If only one image exists, generate a procedural facade approximation—not a claim of a complete reconstructed building.
6. If enough overlapping views exist, create a photogrammetry job with a manifest of source IDs, licences and camera metadata, then evaluate COLMAP or Meshroom/AliceVision.
7. Inspect the resulting mesh, note missing/occluded facades, and do not replace the baseline footprint with generated geometry without validation.
8. Preserve a lineage link from every model feature to the sources, inferred parameters, edits, and review state.

## 7. Research sources

- [DUET: Dwelling Morphology of Courtyard Houses in Old Dhaka](https://www.duet.ac.bd/storage/journal/volume-8-issue-1-2-december-2022%2813-23%29-1678357453.pdf)
- [Multiple Courtyard Mansions of Old Dhaka](https://www.researchgate.net/publication/267224136_MULTIPLE_COURTYARD_MANSIONS_OF_OLD_DHAKA)
- [Documenting Architectural Style of Old Buildings on B.K. Das Lane](https://zenodo.org/records/4471305)
- [The Business Standard: The last of Dhaka's '70s era duplexes](https://www.tbsnews.net/features/panorama/last-dhakas-70s-era-duplexes-1028486)
- [The Business Standard: Fading splendours, tales of heritage homes in Old Dhaka](https://www.tbsnews.net/features/panorama/fading-splendours-tales-heritage-homes-old-dhaka-782038)
- [The Daily Star: Rose Garden Palace](https://online92.thedailystar.net/news/bangladesh/news/rose-garden-palace-where-legacy-blooms-4142916)
- [Studio 16 Architects: Sakoon, Bashundhara](https://www.studio16architectsbd.com/project-apartment-sakoon-bashundhara)
- [WeDesign Studio: Nest Florence](https://wedesignstudiobd.com/portfolio/florence/)

**Maintenance rule:** This document should evolve as building-specific references are reviewed. Keep observations distinct from assumptions, and never present the curated sample as every building in Dhaka.
