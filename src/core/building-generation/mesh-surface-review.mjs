const finite = (n) => typeof n === "number" && Number.isFinite(n);
const edgeKey = (a, b) => [a, b].sort().join("\u0000");

export function reviewMeshSurfaces(mesh, options = {}) {
  if (!mesh || !Array.isArray(mesh.vertices) || !Array.isArray(mesh.triangles)) {
    throw new TypeError("mesh must contain vertices and triangles arrays");
  }
  const maxBoundaryEdges = options.maxBoundaryEdges ?? 0;
  if (!Number.isInteger(maxBoundaryEdges) || maxBoundaryEdges < 0) {
    throw new RangeError("maxBoundaryEdges must be a non-negative integer");
  }
  const byId = new Map();
  for (const v of mesh.vertices) {
    if (!v || typeof v.id !== "string" || byId.has(v.id) ||
      !Array.isArray(v.position) || v.position.length !== 3 || v.position.some((n) => !finite(n))) {
      throw new TypeError("mesh vertices require unique IDs and finite 3D positions");
    }
    byId.set(v.id, v.position);
  }
  const edges = new Map();
  const acceptedTriangles = [];
  const rejectedTriangles = [];
  mesh.triangles.forEach((triangle, index) => {
    const ids = triangle?.vertices;
    if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3 || ids.some((id) => !byId.has(id))) {
      rejectedTriangles.push({ index, reason: "invalid-triangle-references" });
      return;
    }
    acceptedTriangles.push(ids.slice());
    for (const [a,b] of [[ids[0],ids[1]],[ids[1],ids[2]],[ids[2],ids[0]]]) {
      const key = edgeKey(a,b);
      const record = edges.get(key) ?? { vertices: [a,b].sort(), triangleIndices: [] };
      record.triangleIndices.push(index);
      edges.set(key, record);
    }
  });
  const boundaryEdges = [...edges.values()].filter((e) => e.triangleIndices.length === 1);
  const nonManifoldEdges = [...edges.values()].filter((e) => e.triangleIndices.length > 2);
  const unusedVertexIds = [...byId.keys()].filter((id) => !acceptedTriangles.some((tri) => tri.includes(id)));
  const proposals = boundaryEdges.map((edge) => ({
    type: "boundary-edge",
    vertices: edge.vertices,
    triangleIndex: edge.triangleIndices[0],
    action: "needs-evidence",
    reason: "A boundary may be a real opening or a missing surface; do not auto-cap without evidence.",
  }));
  const reasons = [];
  if (rejectedTriangles.length) reasons.push("invalid-triangles");
  if (boundaryEdges.length > maxBoundaryEdges) reasons.push("boundary-edges-exceed-threshold");
  if (nonManifoldEdges.length) reasons.push("non-manifold-edges");
  return {
    schemaVersion: "1.0.0",
    status: reasons.length ? "review-required" : "topology-check-passed",
    acceptedTriangleCount: acceptedTriangles.length,
    rejectedTriangles,
    boundaryEdges,
    nonManifoldEdges,
    unusedVertexIds,
    repairProposals: proposals,
    blockers: reasons,
    policy: {
      automaticHoleFilling: false,
      automaticVertexMovement: false,
      inferredSurfacesAllowed: false,
      maxBoundaryEdges,
    },
    limitations: [
      "Topology checks cannot determine whether a boundary is a door, window, open structure or reconstruction hole.",
      "Surface repair requires a reviewed constraint, a reference image with usable camera calibration, or independent measurements.",
      "Passing topology checks does not prove the mesh matches the real building.",
    ],
    publicationEligible: false,
  };
}
