# M12 — Wireframe-to-mesh readiness gate

## Contract

`assessWireframeMeshReadiness(graph, options)` is a fail-closed gate before the existing explicit-face mesh builder. It never creates faces, caps holes, moves vertices or enables publication.

## Required input

- Vertices have unique IDs, finite 3D coordinates and `reviewState: "accepted"`.
- Edges have distinct, known endpoints and `reviewState: "accepted"`.
- Faces are explicit triangles (array of three vertex IDs or `{ vertices: [...] }`) and each boundary edge must already exist in the reviewed wireframe.
- The graph and its policy explicitly keep `publicationEligible: false`.
- Required facades must be declared `observed` or `inferred`. Inferred facade coverage produces a warning; unknown or review-required coverage blocks readiness.

## Checks and actionable blockers

- Missing faces or edges, unknown/duplicate vertex references, duplicate triangles and degenerate triangles.
- Boundary edges against configurable `maxBoundaryEdges` (default zero), non-manifold edges, inconsistent adjacent face winding, and disconnected face components.
- Unreviewed vertices/edges, missing facade coverage and unsafe publication flags.

The report contains stable blocker codes, details, counts, boundary-edge evidence, disconnected component counts, facade coverage and warnings. A pass only means the explicit candidate is structurally eligible for the existing mesh-construction stage. It is not a claim of building accuracy and never makes the mesh publishable.

## Verification

`npm run test:wireframe-mesh-readiness`

The existing mesh builder and mesh-surface review remain authoritative downstream checks. M12 adds a gate; it does not replace or auto-repair those stages.
