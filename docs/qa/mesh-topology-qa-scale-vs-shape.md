# Mesh topology QA: scale versus shape

The GLB topology audit reports two distinct measurements that must not be conflated.

- **Scale-relative long-edge telemetry** (`longEdgeCount`, `longEdgeTriangleCount`, `longEdgeTriangleRatio`) records edges longer than `modelDiagonal × maxLongEdgeRatio`. These are raw measurements, not automatically geometry defects.
- **Elongated-triangle warning signal** (`elongatedTriangleCount`, `elongatedTriangleRatio`) counts triangles that contain at least one scale-relative long edge and whose longest edge is at least `maxTriangleEdgeRatio` times their shortest edge. This shape-aware signal controls the `long-triangle-edges-present` warning.

Defaults are `maxLongEdgeRatio = 0.15`, `maxTriangleEdgeRatio = 8`, and `maxLongEdgeTriangleRatio = 0.01`. A large, proportionate wall/roof triangle may contribute raw long-edge telemetry without producing a warning. A long, thin triangle can still trigger the warning. Options are validated; the triangle aspect-ratio threshold must be greater than 1 and at most 1000.

This heuristic is still only a triage signal. It does not prove that flagged geometry is defective, and a clean report does not certify architectural accuracy, watertightness, real-world dimensions, texture quality or georeferencing. Degenerate triangles, boundary edges, non-manifold edges and disconnected components are reported separately.

## Unreferenced POSITION vertices

A primitive can carry POSITION accessor entries that no triangle index uses. Those entries are still parsed, counted against the existing accessor-size guard, and rejected if any coordinate is non-finite. They must not affect the primitive's measured min/max bounds, topology `modelDiagonal`, long-edge thresholds, vertex-welding set or connected-component measurements. The existing topology-analysis vertex limit remains based on the full POSITION accessor count because it is a memory-safety guard, not a scale heuristic.

The report preserves `counts.vertexCount` as the total POSITION accessor count and adds `referencedVertexCount` and `unreferencedVertexCount`. The same two counters are included in each `meshDetails` entry and the topology result; a non-zero unreferenced count produces the review warning `unreferenced-vertices-present`. This warning is diagnostic only and does not prove that a model is architecturally wrong.


For a non-indexed `TRIANGLES` primitive, glTF uses sequential vertex order as the implicit triangle index stream. Every `POSITION` entry is therefore referenced and the unreferenced counters remain zero.


## Scene-space bounds versus mesh-local topology

Aggregate `bounds` follow the active glTF scene (the declared default scene, or scene 0 when scenes are present but no default is declared). Node `matrix` or TRS transforms are composed through the parent-child hierarchy and every mesh instance contributes referenced POSITION vertices to the scene-space axis-aligned bounds. If no scene graph is available, the report uses an explicit mesh-local fallback warning. Mesh definitions not instanced in the active scene are still structurally/topologically checked but do not affect scene-space bounds.

Per-primitive topology measurements remain in mesh-local coordinates. They are scale-relative review hints, not per-instance deformed-surface analysis. Static QA does not evaluate glTF animations, skinning or morph-target deformation. Scene-space bounds remain un-georeferenced and do not establish real-world dimensions, survey truth or architectural accuracy. A configurable bounded scene-node, mesh-instance and transformed-vertex budget prevents pathological scene graphs from causing unbounded work.


For mesh-local fallback reports, `scene.meshInstanceCount` remains zero because no active-scene mesh instance was resolved; `boundsTransformCount` records the identity fallback applied to each mesh definition.

## glTF 2.0 sparse accessors

The geometry QA adapter resolves sparse POSITION and primitive-index accessors before referenced-vertex accounting, topology evaluation and scene-space bounds. A dense base `bufferView` is read first; when it is absent the accessor base is zero-initialized as specified by glTF, then sparse replacements are applied.

Sparse replacement indices must be strictly increasing and inside the accessor count. Sparse index/value bufferViews are required to reference the embedded GLB buffer, must not define `target` or `byteStride`, and must satisfy component alignment and tightly packed range bounds. Sparse index component types are limited to unsigned byte, unsigned short and unsigned int. Sparse entry counts are capped by the configurable `maxSparseEntries` guard. Malformed sparse data fails closed.

See the [Khronos glTF 2.0 sparse accessor specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#reference-accessor-sparse).


## POSITION accessor bounds metadata

Every mesh POSITION accessor must declare three-component `min` and `max` arrays. The geometry QA adapter compares those declarations against the decoded accessor values after sparse substitution, using float32 rounding (`Math.fround`) for the JSON values. The comparison includes unreferenced POSITION entries because accessor bounds describe the entire accessor, even though unreferenced vertices remain excluded from referenced-only geometry and topology bounds.

For accessors with neither a base `bufferView` nor sparse replacements, glTF defines a zero-initialized accessor and permits the declared `min`/`max` values to be arbitrary representable component values; QA still requires both POSITION bounds fields to be present but does not compare them to zero.

See the [Khronos glTF 2.0 accessor bounds specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#reference-accessor-bounds).
