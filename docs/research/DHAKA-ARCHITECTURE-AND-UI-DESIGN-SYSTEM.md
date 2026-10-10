# Dhaka Architecture, Location, Facade Colour & Map UI Design System

**Research date:** 10 October 2026  
**Status:** Research-backed implementation specification; not a surveyed city model or a declaration of WCAG compliance.  
**Canonical source data:** [Expanded 33-record building reference catalogue](../../data/research/dhaka-building-reference-catalog.json)  
**Canonical tokens and location clusters:** [Machine-readable design system](../../data/research/dhaka-architecture-design-system.json)

## 1. Objective and boundaries

This research consolidates earlier photo/video records, adds named architecture-project references and links research observations to practical design and UI decisions. It covers visible building style, floors/massing clues, balconies/windows/roof treatments, courtyard geometry, location precision, source link/licence, estimated facade palettes and a consistent light/dark map UI.

**This is not an inventory of every Dhaka house.** The catalogue has 33 records, but some are contextual images/video rather than unique individual houses. R23 and R29 are separate sources referring to the same Karim Residence design, not two distinct houses.

## 2. Research findings and sources

### 2.1 Traditional courtyard houses in Old Dhaka

A university journal paper, *Dwelling Morphology of Courtyard Houses in Old Dhaka: A Study on Spatial Adaptations*, studied cases in Shakhari Bazar and Tantibazar using physical observations, sketches, photographs and layouts. It describes inward-facing rooms arranged around a courtyard and documents spatial adaptations as household needs change. For 3D modelling, the courtyard should be modelled as a negative-space void, not merely a texture on top of a solid extrusion.

Source: https://www.duet.ac.bd/storage/journal/volume-8-issue-1-2-december-2022%2813-23%29-1678357453.pdf

A conservation study describes Shakhari Bazaar as a historically detailed neighbourhood whose urban fabric and cultural practices are vulnerable to change. Research on Tantibazar describes transformations from traditional shop-house fabric to multi-level rentable retail/wholesale buildings. An Old Dhaka model must represent both heritage residences and evolving mixed-use shop-house frontages, rather than one generic style.

Sources:
- https://ph01.tci-thaijo.org/index.php/nakhara/article/view/104875
- https://www.researchgate.net/publication/354821449_Changing_Morphology_and_the_Emerging_Pattern_of_a_Traditional_City_A_Case_of_Tanti_Bazar_Area_in_Old_Dhaka

A 2025 paper on multi-courtyard mansions notes European/classical facade elements combined with local courtyard-centred spatial organization. This supports a separate “formal heritage mansion” template with ornament on the outside and courtyard/wing geometry within.

Source: https://www.researchgate.net/publication/396516227_Multicourtyard_Mansion_of_Old_Dhaka

### 2.2 Historical brick modernism and duplex houses

The Chowdhury Residence, associated with architect Bashirul Haq, is a named modernist residence in Dhaka. Archnet describes fair-faced brickwork on a concrete frame, an L-shaped ground-floor mass, a square upper volume and roof terraces, with completion around 1980. It bridges older low-rise private houses and contemporary apartment towers: it has offset volumes rather than a repeated high-rise floor plate.

Source: https://www.archnet.org/sites/282

A 2025 feature on Dhaka's surviving or formerly present 1970s-era duplexes discusses boxy forms, flat roofs, large grilled windows, exposed brick/concrete, vertical louvres, horizontal shading and front/back open spaces. These are typology cues, not current facts about every named street; some example homes may have changed or disappeared.

Source: https://www.tbsnews.net/features/panorama/last-dhakas-70s-era-duplexes-1028486

### 2.3 Contemporary apartments and climate-responsive design

Named contemporary references now recorded in the catalogue include:

- **Karim Residence** — architect-described planter beds, hanging creepers, wide balconies, large openings, cross-ventilation, roof garden and landscaped terraces. The page reports a built project in Dhaka (2013) and built area of 1,834.45 m². Source: https://archfieldbd.com/karim-residence/
- **Bo Metta, Banani DOHS** — stacked concrete balconies, slim metal rails, brick cladding and planting. Source: https://archfieldbd.com/bo-metta/
- **Sakoon, Bashundhara** — the architect describes white walls/glass, large windows, balconies on north/south sides and a shared rooftop green zone. Source: https://www.studio16architectsbd.com/project-apartment-sakoon-bashundhara
- **Nest Florence, Bashundhara** — studio-described contemporary project with clean lines, expansive windows, a lobby and roof terrace. Source: https://wedesignstudiobd.com/portfolio/florence/
- **Palm Grove, Banani** — developer gallery with light stone-like cladding, white plaster, repeated/staggered balconies, glass rails and planting. Source: https://btibd.com/gallery/palm-grove-banani-2021/
- **JCX Autograph and JCX Olympus, Bashundhara** — developer-reported locations, plot areas, storey programmes and amenity lists. This helps create programme hypotheses but is not a cadastral survey. Sources: https://jcxbd.com/projects/autograph/ and https://jcxbd.com/projects/jcx-olympus/

A 2025 study on height-responsive balcony-integrated building envelopes evaluates balcony geometry/material variables against daylight, glare, thermal comfort and energy-use objectives in Dhaka's hot-humid climate. Do not add identical balconies to every floor by default: select depth, projection, side/orientation and shading as parameters and keep context in the design problem.

Source: https://doi.org/10.15627/jd.2025.24

### 2.4 Heritage mansion and courtyard examples

A Prothom Alo historical photo report describes Rose Garden Palace in Tikatuli as a two-storey walled building constructed around 1930, with reported area around 7,000 sq ft and height around 45 ft. It describes a main veranda, three entrance arches, a semi-circular balcony and decorative wood, coloured glass and ironwork. These are published-report facts, not our own survey measurements.

Source: https://www.prothomalo.com/bangladesh/%E0%A6%87%E0%A6%A4%E0%A6%B9%E0%A6%BE%E0%A6%B8%E0%A7%87%E0%A6%B0-%E0%A6%B0%E0%A7%8B%E0%A6%9C-%E0%A6%97%E0%A6%BE%E0%A6%B0%E0%A7%8D%E0%A6%A1%E0%A7%87%E0%A6%A8

Beauty Boarding is another courtyard-facing Old Dhaka reference, with weathered walls and arched verandas facing a green courtyard in the published photo. Editorial imagery is not an open-licensed texture source by default.

Source: https://www.jagonews24.com/photo/bangladesh/photo-feature/1471

### 2.5 Geospatial schema and styling

Overture's Building schema describes a building footprint with optional height, floor count and associated building parts. BuildingPart can contain its own footprint/height/floors, minimum height/floor, facade colour/material and roof material/shape/colour. These fields support progressively more detailed geometry rather than putting every facade feature into one undifferentiated object.

Sources:
- https://docs.overturemaps.org/schema/reference/buildings/building/
- https://docs.overturemaps.org/schema/reference/buildings/building_part/

OpenStreetMap's building:colour tag accepts descriptive colours or hex values and notes that named colours may be interpreted differently by 3D renderers. Use normalized hex for display when a colour is actually sourced, while preserving the original source value and confidence.

Source: https://wiki.openstreetmap.org/wiki/Key:building:colour

## 3. Location register and confidence

The design-system JSON defines nine location clusters. They are search/research groupings, not automatic assignments to every building.

| Cluster | Included places | Evidence suggested by sources | Location confidence |
|---|---|---|---|
| Old Dhaka heritage core | Shakhari Bazar, Tantibazar, Shyambazar, Rankin Street, Shree Shash Lane, KM Das Lane/Tikatuli | Courtyard houses, multi-courtyard mansions, narrow lanes, heritage/shop-house and mixed-use transformation | Some sources name a landmark or street; every footprint still needs matching |
| Gulshan and Banani | Gulshan-1/2, Banani Model Town, Banani DOHS | Mix of private houses/apartments, selected green facades and balcony design | Mixed: some project/camera-viewpoint clues, many exact polygons unresolved |
| Bashundhara R/A | Blocks I, L, M and named roads | Contemporary apartments/condominiums and reported rooftop/community amenities | Project addresses recorded, not GIS-confirmed here |
| Azimpur/Lalbagh | Azimpur, Lalbagh Kella Road | Multi-storey residential complex reference | Neighbourhood-level; the photo date matters |
| Mugda | Mugda | Painted mid-rise facade reference | Neighbourhood level |
| Uttara | Uttara | House/building reference needing visual identity review | Exact building unresolved |
| Banasree | Banasree | Rental-listing and street-frontage clue | Listing-level; exact building/photo match not established |
| Dhanmondi | Dhanmondi Lake and historical duplex references | Lake-edge context plus a separate historical duplex typology | District label does not identify an individual building |
| Citywide views | Unspecified Dhaka skyline/cluster | Dense mid-rise/high-rise urban fabric | Context only unless photo metadata identifies a camera viewpoint |

Location rules:
- Store location text, coordinates (only when the source provides them), coordinate meaning (building/camera/viewpoint/route/unknown), precision, match confidence and source URL separately.
- A panorama camera position must not be stored as the centroid of every visible building.
- If different sites depict the same design/project, link them as related sources rather than counting them as different houses.
- Match a reference to a map footprint using viewpoint, heading if available, visible roof/outline and nearby landmarks. If uncertain, leave the match unresolved.

## 4. Building design families to encode in 3D

### Contemporary white/glass apartment
Evidence: repeated windows/floor bands, light plaster, cool glazing, balconies and sometimes rooftop amenities.

Suggested modules: BuildingMass, FloorStack, FacadeBayPattern, BalconyModule, GroundFloorProgramme and RoofComposition. Ground-floor parking/lobby and roof gardens should only be added where supported by sources.

### Brick, exposed concrete and biophilic apartment
Evidence: brick cladding/infill, concrete slab edges, balconies, vertical greenery, planter boxes and large openings. Vegetation should be separate geometry/assets so users can toggle it and it can have a separate performance budget.

### Painted facade apartment
Evidence: strong coloured wall zones with repeated balcony/window bays. Store colour zones as separate material regions rather than giving the whole building one solid colour.

### Low-rise family duplex / modernist brick house
Evidence: one or two principal masses, flat roof/parapet, large grilles/windows, louvres/shading, open front/back and sometimes a courtyard. Each floor may have a different footprint; the Chowdhury Residence case demonstrates why an L-shaped lower volume and square upper volume can be more accurate than a single extrusion.

### Old Dhaka courtyard house / shop-house
Evidence: narrow streets, close side walls, inward-facing rooms around courtyard, verandas/arches and sometimes mixed residential/retail use. Model courtyard topology before decorative facade detail.

### Formal heritage mansion
Evidence: formal central facade, repeated columns/arches, ornamental parapet, decorative balustrades and separate garden/path/fountain. Keep ornaments and landscape independent, with higher geometry detail budgets only when a user zooms in or selects the landmark.

## 5. Reference facade colour palettes

**These are estimated design swatches based on source previews and written material descriptions. They are not calibrated pixel samples, paint/manufacturer specifications or exact material measurements.** Every reference in the JSON carries its own palette and estimation note.

| Family | Approximate hex palette | Intended use |
|---|---|---|
| Contemporary white/glass | #F1F0EA, #D0D0C8, #91A8B5, #414A50, #4A774F | Light plaster, concrete, glass, frames and landscape |
| Brick + biophilic greenery | #A35338, #B5B0A5, #8FA8B0, #3B7544, #414748 | Brick, concrete, glazing, plants and metal |
| Blue + ochre painted facade | #2F6C96, #D8B044, #D8D4C9, #29363D | Mugda painted-facade reference |
| Weathered Old Dhaka courtyard | #B29A5F, #C5B18C, #2D634E, #3F6E3D, #352F2A | Aged ochre/plaster, green doors, courtyard and shadow |
| Heritage white mansion | #F1EFE7, #D9D3C7, #625D55, #3E6B43 | Rose Garden-like ivory facade, details and garden |
| Brick modernist house | #9A4D34, #C7C1B4, #30383C, #426941 | Fair-faced brick, pale concrete, window shadow, garden |
| Dense skyline context | #E7E8E4, #B8C0C5, #C7B8A5, #55734E | Neutral city blocks, not any one facade |

Colour can vary due to weathering, shade, white balance, display/compression and repainting. For an actual texture, separately record the sample region and source image version.

## 6. Proposed UI design system

Use a restrained **blue + white + light-grey** interface for search/discovery and a dark theme for immersive 3D exploration. Tokens are saved in the JSON design system. This is a proposal, not yet proof that every UI component has been updated.

### Light theme
- Background: #F8FAFC
- Panel: #FFFFFF
- Muted panel: #F1F5F9
- Main text: #0F172A
- Secondary text: #475569
- Border: #CBD5E1
- Primary blue: #2563EB (button text #FFFFFF)
- Hover blue: #1D4ED8
- Cyan accent for highlights: #0891B2
- Accent action with white text: #0E7490
- Keyboard focus: #0EA5E9
- Success: #15803D
- Warning/estimated: #B45309
- Error/destructive: #B91C1C

### Dark theme
- Background: #0B1220
- Panel: #111827
- Raised panel: #253245
- Main text: #F8FAFC
- Secondary text: #CBD5E1
- Border: #334155
- Primary blue: #60A5FA (button text #0B1220, not white)
- Cyan accent: #22D3EE (use dark text on cyan buttons)
- Keyboard focus: #38BDF8
- Success: #4ADE80
- Warning/estimated: #FBBF24
- Error/destructive: #F87171

### Map colours
- Normal building: #A9B7C8 (dark mode #64748B)
- Selected building: #2563EB (dark mode #60A5FA)
- Search/hover highlight: #06B6D4 (dark mode #22D3EE)
- Road: #E5E7EB (dark mode #263445)
- Water: #BDE7F3 (dark mode #164E63)
- Vegetation: #A8D5AE (dark mode #166534)
- Unknown/partial source: #94A3B8

### POI category colours
- Property listing: #2563EB
- Pharmacy: #0D9488
- Hospital: #DC2626
- Clinic/medical centre: #7C3AED
- Supermarket: #D97706
- Market/bazaar: #A16207
- Road/transport context: #64748B

Do not convey a category/state by colour alone; use icons/text as well.

### UI behavior rules
1. The 3D canvas remains the main work surface; floating panels must not hide all navigation controls or the selected building.
2. Keep search/filter controls separate from building details. Show source attribution next to image previews.
3. Label facts explicitly: **Source-reported**, **Estimated**, **Unverified match** or **Not available**.
4. Reuse the same source record in map, gallery and details so licence/provenance does not disappear between components.
5. Show the hex value and confidence for facade swatches; distinguish estimates from sourced colour attributes.
6. Use spacing of 4/8/12/16/24/32 px and card radii of 6/8/12/16 px; avoid one separate card for every small data point.
7. Prefer 14–16 px body text, 12–13 px metadata, clear heading hierarchy and body line-height near 1.5.
8. Target contrast of 4.5:1 for normal text and 3:1 for large text and non-text UI boundaries. Automated and component-state checks are still required before claiming WCAG compliance.

## 7. Suggested data contract

Keep original map data unchanged. Link enrichment as a separate record. Example:

~~~json
{
  "buildingId": "OVERTURE_OR_PROJECT_ID",
  "sourceReferences": ["R24"],
  "styleFamily": "brick-biophilic-apartment",
  "location": {
    "description": "Banani DOHS, Dhaka",
    "precision": "neighbourhood",
    "coordinateMeaning": "unknown",
    "matchConfidence": "medium"
  },
  "observed": {
    "storeys": null,
    "materials": ["brick-cladding", "concrete-slab", "metal-railing"],
    "facadePattern": ["stacked-balconies", "repeated-openings"],
    "roofFeatures": [],
    "streetContext": ["tree-cover"]
  },
  "estimatedRender": {
    "facadeColor": "#9E543B",
    "trimColor": "#D5D1C8",
    "metalColor": "#555653",
    "vegetationColor": "#3F7546"
  },
  "confidence": {
    "buildingIdentity": "medium",
    "massing": "low",
    "visibleFacade": "medium",
    "hiddenFacade": "unknown"
  },
  "provenance": {
    "sourceUrl": "https://archfieldbd.com/bo-metta/",
    "license": "not-established",
    "usageStatus": "research-only",
    "paletteMethod": "estimated-from-preview"
  }
}
~~~

## 8. Model confidence levels

- **L0 — Footprint only:** 2D outline, no claim to facade accuracy.
- **L1 — Estimated massing:** footprint plus reported/sourced height or labelled estimated floor count.
- **L2 — Single-view facade:** the visible frontage is reference-assisted; hidden sides remain generic/unknown.
- **L3 — Multi-view candidate:** overlapping views plausibly show the same building from different useful angles.
- **L4 — Reviewed model:** compare generated geometry against sources, note occlusions/mismatches and review manually.
- **L5 — Survey-backed:** measured drawings or reliable survey linked to the model.

More photos, a high-resolution image or a GPS tag do not by themselves prove identity or accurate geometry.

## 9. Image/video rights and privacy

- KartaView states its street imagery and 3D spatial data are CC BY-SA 4.0 and requires the credit “© Grab and KartaView Contributors”. Check each source and current terms.
  https://kartaview.org/terms
- Mapillary states contributed imagery is under CC BY-SA with attribution and additional usage terms.
  https://help.mapillary.com/hc/en-us/articles/115001770409-CC-BY-SA-license-for-open-data
- Each Wikimedia Commons file has its own licence. Store CC BY 2.0, CC BY-SA 3.0 and CC BY-SA 4.0 separately.
- News/editorial, real-estate, architecture/developer pages and YouTube videos are research-only by default unless rights/terms establish reuse.
- Do not download/re-host video or extract frames for textures/training without rights clearance.
- Keep privacy review for faces, vehicle plates and incidental private interiors in any ingestion workflow.
- Preserve source URL, creator, capture/publication date, retrieval date, licence, attribution, modifications, coordinate meaning and match confidence.

## 10. Implementation sequence

1. Select a small manually reviewed set of named buildings and exact Overture IDs before mass-enriching the city.
2. Add a validated architecture-enrichment schema for source and confidence fields.
3. Make the UI show **Source-reported**, **Estimated** and **Unverified** clearly.
4. Use procedural modules for floor stacks, balcony rhythms, window bays, courtyard voids, roof features and vegetation, with level-of-detail budgets by camera distance.
5. Run photogrammetry only when overlapping views of the same identified building are available and rights permit the use.
6. Store generated meshes and textures separately with source lineage; do not commit copyrighted imagery as open assets.
7. Test light/dark contrast and selected/hover/focus/loading/error states before applying the palette throughout the app.

## 11. Primary source index

- Old Dhaka courtyard-house morphology: https://www.duet.ac.bd/storage/journal/volume-8-issue-1-2-december-2022%2813-23%29-1678357453.pdf
- Shakhari Bazaar conservation study: https://ph01.tci-thaijo.org/index.php/nakhara/article/view/104875
- Tantibazar urban morphology: https://www.researchgate.net/publication/354821449_Changing_Morphology_and_the_Emerging_Pattern_of_a_Traditional_City_A_Case_of_Tanti_Bazar_Area_in_Old_Dhaka
- Multi-courtyard mansion research: https://www.researchgate.net/publication/396516227_Multicourtyard_Mansion_of_Old_Dhaka
- Balcony-envelope research for Dhaka: https://doi.org/10.15627/jd.2025.24
- Chowdhury Residence: https://www.archnet.org/sites/282
- Karim Residence: https://archfieldbd.com/karim-residence/
- Bo Metta: https://archfieldbd.com/bo-metta/
- Rose Garden historical report: https://www.prothomalo.com/bangladesh/%E0%A6%87%E0%A6%A4%E0%A6%BF%E0%A6%B9%E0%A6%BE%E0%A6%B8%E0%A7%87%E0%A6%B0-%E0%A6%B0%E0%A7%8B%E0%A6%9C-%E0%A6%97%E0%A6%BE%E0%A6%B0%E0%A7%8D%E0%A6%A1%E0%A7%87%E0%A6%A8
- Overture Building schema: https://docs.overturemaps.org/schema/reference/buildings/building/
- Overture BuildingPart schema: https://docs.overturemaps.org/schema/reference/buildings/building_part/
- OpenStreetMap building colour tag: https://wiki.openstreetmap.org/wiki/Key:building:colour
- KartaView licensing: https://kartaview.org/terms
- Mapillary licensing: https://help.mapillary.com/hc/en-us/articles/115001770409-CC-BY-SA-license-for-open-data

**Maintenance rule:** Keep source facts, observations, guesses, colour estimates and rendering decisions distinct in both data and UI. Update this guide when individual references are re-checked.
