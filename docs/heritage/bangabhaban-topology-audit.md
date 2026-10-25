# Bangabhaban — candidate-specific topology audit

Decision: blocked-review-required. This is a geometry triage report, not a historical accuracy certificate.

## Candidate identity

GLB SHA-256: 6ed82d6e0d9717f5a0f26a789b722e3f1aee559f4f94ae48945e768da01a77c6
GLB bytes: 429992
Geometry QA status: review-recommended
Triangles: 8684
Degenerate triangles: 0
Meshes / primitives: 15 / 19

## Global warnings

- disconnected-mesh-components-present
- long-triangle-edges-present
- no-texture-atlas-embedded-or-declared

## Per-primitive findings

| Mesh | Semantic node | Triangles | Components | Boundary edges | Non-manifold edges | Long-edge triangles | Warnings |
|---:|---|---:|---:|---:|---:|---:|---|
| 0 | Plinth | 20 | 1 | 0 | 0 | 16 | long-triangle-edges-present |
| 1 | WestWing | 12 | 1 | 0 | 0 | 12 | long-triangle-edges-present |
| 2 | CentralHall | 12 | 1 | 0 | 0 | 12 | long-triangle-edges-present |
| 3 | EastWing | 12 | 1 | 0 | 0 | 12 | long-triangle-edges-present |
| 4 | RearHall | 12 | 1 | 0 | 0 | 12 | long-triangle-edges-present |
| 5 | RoofDeck | 48 | 4 | 0 | 0 | 44 | disconnected-mesh-components-present, long-triangle-edges-present |
| 5 | RoofDeck | 12 | 1 | 0 | 0 | 12 | long-triangle-edges-present |
| 6 | DomePavilion | 12 | 1 | 0 | 0 | 12 | long-triangle-edges-present |
| 7 | DomeDrum | 128 | 1 | 0 | 0 | 128 | long-triangle-edges-present |
| 8 | Dome | 864 | 1 | 0 | 0 | 48 | long-triangle-edges-present |
| 9 | Finial | 336 | 2 | 0 | 0 | 24 | disconnected-mesh-components-present, long-triangle-edges-present |
| 10 | Loggia | 240 | 20 | 0 | 0 | 0 | disconnected-mesh-components-present |
| 10 | Loggia | 4552 | 284 | 0 | 0 | 0 | disconnected-mesh-components-present |
| 10 | Loggia | 24 | 2 | 0 | 0 | 16 | disconnected-mesh-components-present, long-triangle-edges-present |
| 11 | FacadeTrim | 168 | 14 | 0 | 0 | 0 | disconnected-mesh-components-present |
| 12 | WindowsAndDoors | 1584 | 132 | 0 | 0 | 0 | disconnected-mesh-components-present |
| 12 | WindowsAndDoors | 528 | 44 | 0 | 0 | 0 | disconnected-mesh-components-present |
| 13 | Parapet | 36 | 3 | 0 | 0 | 24 | disconnected-mesh-components-present, long-triangle-edges-present |
| 14 | EntranceStair | 84 | 7 | 0 | 0 | 56 | disconnected-mesh-components-present, long-triangle-edges-present |

## Review policy

Warnings are preserved rather than suppressed. Inspect high-impact facade, dome, plinth, roof and wing primitives before accepting any warning.
A valid GLB, a clean plinth or zero degenerate triangles does not prove architectural accuracy.
