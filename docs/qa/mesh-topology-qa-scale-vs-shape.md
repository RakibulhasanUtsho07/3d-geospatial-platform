# Mesh topology QA: scale versus shape

The GLB topology audit reports two distinct measurements that must not be conflated.

- **Scale-relative long-edge telemetry** (`longEdgeCount`, `longEdgeTriangleCount`, `longEdgeTriangleRatio`) records edges longer than `modelDiagonal × maxLongEdgeRatio`. These are raw measurements, not automatically geometry defects.
- **Elongated-triangle warning signal** (`elongatedTriangleCount`, `elongatedTriangleRatio`) counts triangles that contain at least one scale-relative long edge and whose longest edge is at least `maxTriangleEdgeRatio` times their shortest edge. This shape-aware signal controls the `long-triangle-edges-present` warning.

Defaults are `maxLongEdgeRatio = 0.15`, `maxTriangleEdgeRatio = 8`, and `maxLongEdgeTriangleRatio = 0.01`. A large, proportionate wall/roof triangle may contribute raw long-edge telemetry without producing a warning. A long, thin triangle can still trigger the warning. Options are validated; the triangle aspect-ratio threshold must be greater than 1 and at most 1000.

This heuristic is still only a triage signal. It does not prove that flagged geometry is defective, and a clean report does not certify architectural accuracy, watertightness, real-world dimensions, texture quality or georeferencing. Degenerate triangles, boundary edges, non-manifold edges and disconnected components are reported separately.

## Unreferenced POSITION vertices

A primitive can carry POSITION accessor entries that no triangle index uses. Those entries are still parsed, counted against the existing accessor-size guard, and rejected if any coordinate is non-finite. They must not affect the primitive's measured min/max bounds, topology `modelDiagonal`, long-edge thresholds, vertex-welding set or connected-component measurements. The existing topology-analysis vertex limit remains based on the full POSITION accessor count because it is a memory-safety guard, not a scale heuristic.

The report preserves `counts.vertexCount` as the total POSITION accessor count and adds `referencedVertexCount` and `unreferencedVertexCount`. The same two counters are included in each `meshDetails` entry and the topology result; a non-zero unreferenced count produces the review warning `unreferenced-vertices-present`. This warning is diagnostic only and does not prove that a model is architecturally wrong.
