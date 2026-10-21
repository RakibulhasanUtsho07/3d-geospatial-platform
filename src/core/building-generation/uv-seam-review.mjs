const finite = (value) => typeof value === "number" && Number.isFinite(value);

const distance2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Find candidate UV seams by matching geometric edges, including duplicated
 * vertices. A seam candidate can be intentional; this function never repairs it.
 */
export function reviewUvSeams(input, options = {}) {
  if (!input || !Array.isArray(input.positions) || !Array.isArray(input.uvs) || !Array.isArray(input.indices)) {
    throw new TypeError("input must contain positions, uvs and indices arrays");
  }
  const { positions, uvs, indices } = input;
  if (positions.length < 3 || positions.length !== uvs.length) {
    throw new RangeError("positions and uvs must have the same vertex count and at least three vertices");
  }
  if (indices.length < 3 || indices.length % 3 !== 0) {
    throw new RangeError("indices must contain one or more complete triangles");
  }
  if (!Number.isFinite(options.uvTolerance ?? 1e-5) || (options.uvTolerance ?? 1e-5) < 0) {
    throw new RangeError("uvTolerance must be a non-negative finite number");
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Array.isArray(positions[i]) || positions[i].length !== 3 || positions[i].some((n) => !finite(n))) {
      throw new TypeError("positions must be finite [x,y,z] coordinates");
    }
    if (!Array.isArray(uvs[i]) || uvs[i].length !== 2 || uvs[i].some((n) => !finite(n))) {
      throw new TypeError("uvs must be finite [u,v] pairs");
    }
  }
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= positions.length) {
      throw new RangeError("indices contain a vertex reference outside positions/uvs");
    }
  }

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const point of positions) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]);
    max[axis] = Math.max(max[axis], point[axis]);
  }
  const extent = Math.max(...max.map((value, axis) => value - min[axis]));
  const positionTolerance = options.positionTolerance ?? Math.max(extent * 1e-6, 1e-9);
  if (!finite(positionTolerance) || positionTolerance <= 0) {
    throw new RangeError("positionTolerance must be a positive finite number");
  }
  const uvTolerance = options.uvTolerance ?? 1e-5;
  const positionKey = (point) => point.map((n) => String(Math.round(n / positionTolerance))).join(",");
  const edgeGroups = new Map();

  for (let offset = 0, triangleIndex = 0; offset < indices.length; offset += 3, triangleIndex++) {
    const triangle = [indices[offset], indices[offset + 1], indices[offset + 2]];
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const endpointA = { key: positionKey(positions[a]), position: positions[a], uv: uvs[a], vertexIndex: a };
      const endpointB = { key: positionKey(positions[b]), position: positions[b], uv: uvs[b], vertexIndex: b };
      const sortedKeys = [endpointA.key, endpointB.key].sort();
      if (sortedKeys[0] === sortedKeys[1]) continue;
      const key = sortedKeys.join("|");
      const group = edgeGroups.get(key) ?? { endpoints: new Map(), occurrences: [] };
      group.endpoints.set(endpointA.key, endpointA.position);
      group.endpoints.set(endpointB.key, endpointB.position);
      group.occurrences.push({ triangleIndex, endpoints: [endpointA, endpointB] });
      edgeGroups.set(key, group);
    }
  }

  const candidates = [];
  let sharedEdgeCount = 0;
  for (const [key, group] of edgeGroups) {
    if (group.occurrences.length < 2) continue;
    sharedEdgeCount++;
    for (let leftIndex = 0; leftIndex < group.occurrences.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < group.occurrences.length; rightIndex++) {
        const left = group.occurrences[leftIndex], right = group.occurrences[rightIndex];
        if (left.triangleIndex === right.triangleIndex) continue;
        const byKey = new Map(right.endpoints.map((endpoint) => [endpoint.key, endpoint]));
        const endpointComparisons = left.endpoints.map((endpoint) => {
          const other = byKey.get(endpoint.key);
          return {
            position: endpoint.position,
            leftUv: endpoint.uv,
            rightUv: other?.uv ?? null,
            leftVertexIndex: endpoint.vertexIndex,
            rightVertexIndex: other?.vertexIndex ?? null,
            uvDistance: other ? distance2(endpoint.uv, other.uv) : null,
          };
        });
        if (endpointComparisons.some((item) => item.uvDistance === null)) continue;
        const maxUvDistance = Math.max(...endpointComparisons.map((item) => item.uvDistance));
        if (maxUvDistance <= uvTolerance) continue;
        candidates.push({
          edgeKey: key,
          triangleIndices: [left.triangleIndex, right.triangleIndex],
          endpoints: endpointComparisons,
          maxUvDistance,
          classification: "review-candidate",
          reason: "Adjacent triangles share a geometric edge but map at least one endpoint to different UV coordinates.",
          repair: "none",
        });
      }
    }
  }
  candidates.sort((a, b) => a.triangleIndices[0] - b.triangleIndices[0] ||
    a.triangleIndices[1] - b.triangleIndices[1] || a.edgeKey.localeCompare(b.edgeKey));
  return {
    schemaVersion: "1.0.0",
    engine: "uv-seam-review-v1",
    sharedGeometricEdgeCount: sharedEdgeCount,
    seamCandidateCount: candidates.length,
    positionTolerance,
    uvTolerance,
    candidates,
    limitations: [
      "UV discontinuities may be intentional seams or texture-atlas boundaries; candidates are not automatically classified as defects.",
      "Geometric edge matching uses a scale-relative tolerance and may miss edges with inconsistent or heavily noisy coordinates.",
      "This checks coordinates and UV assignments only; it does not render pixels or prove that a visible seam exists.",
    ],
  };
}
