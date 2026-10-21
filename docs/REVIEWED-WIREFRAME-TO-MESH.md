# Reviewed wireframe to mesh candidate

This stage converts only reviewed, explicitly supplied triangular faces into a mesh candidate. It does not infer unobserved surfaces or fill holes automatically.

## Input

JSON object with `vertices: [{ id, point: [x,y,z] }]` and `faces: [[vertexIdA, vertexIdB, vertexIdC], ...]`. Face winding should be consistent. Coordinates must be finite and use one agreed coordinate system.

## Run

```powershell
npm run test:wireframe-to-mesh
npm run build:reviewed-wireframe-mesh -- ".\\reviewed-wireframe-faces.json" ".\\mesh-candidate.json"
```

Optional: `--min-triangle-area=0.00000001`.

## QA

The report rejects unknown/duplicate/degenerate triangles and measures boundary and non-manifold edges. Open boundaries are reported, not capped. This is a candidate mesh, not a validated or textured building. `publicationEligible` stays false until independent dimension, scale, geometry and provenance gates pass.
