# Mesh surface review and evidence-gated repair proposals

Run:

```powershell
npm run test:mesh-surface-review
npm run review:mesh-surfaces -- ".\\mesh-candidate.json" ".\\surface-review.json"
```

The input mesh candidate uses `vertices: [{ id, position: [x,y,z] }]` and `triangles: [{ vertices: [idA,idB,idC] }]`.

This stage reports boundary edges, non-manifold edges, invalid triangles and unused vertices. Boundary edges generate review proposals only. The engine deliberately does not cap holes automatically because openings may represent doors, windows, courtyards or incomplete reconstruction. A human-reviewed architectural constraint, calibrated image evidence or independent measurement is needed before filling a surface. The report always keeps `publicationEligible: false`.
