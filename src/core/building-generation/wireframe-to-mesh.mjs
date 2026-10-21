const finite = (n) => typeof n === "number" && Number.isFinite(n);
const distance = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const norm = (v) => Math.hypot(...v);

export function buildMeshFromReviewedWireframe(input, options = {}) {
  if (!input || !Array.isArray(input.vertices) || !Array.isArray(input.faces)) {
    throw new TypeError("input must contain vertices and explicit faces");
  }
  const minTriangleArea = options.minTriangleArea ?? 1e-8;
  if (!finite(minTriangleArea) || minTriangleArea < 0) throw new RangeError("minTriangleArea must be finite and >= 0");
  const ids = new Map();
  for (const v of input.vertices) {
    if (!v || typeof v.id !== "string" || ids.has(v.id) || !Array.isArray(v.point) ||
      v.point.length !== 3 || v.point.some((n) => !finite(n))) {
      throw new TypeError("vertices need unique string IDs and finite 3D point coordinates");
    }
    ids.set(v.id, v.point);
  }
  const triangles = [];
  const rejectedFaces = [];
  const faceKeys = new Set();
  for (let i = 0; i < input.faces.length; i += 1) {
    const face = input.faces[i];
    if (!Array.isArray(face) || face.length !== 3 || new Set(face).size !== 3 || face.some((id) => !ids.has(id))) {
      rejectedFaces.push({ index: i, reason: "face-must-reference-three-distinct-known-vertices" });
      continue;
    }
    const key = [...face].sort().join("\u0000");
    if (faceKeys.has(key)) {
      rejectedFaces.push({ index: i, reason: "duplicate-triangle" });
      continue;
    }
    faceKeys.add(key);
    const [a, b, c] = face.map((id) => ids.get(id));
    const area = norm(cross(sub(b, a), sub(c, a))) / 2;
    if (!finite(area) || area <= minTriangleArea) {
      rejectedFaces.push({ index: i, reason: "degenerate-or-near-zero-area-triangle" });
      continue;
    }
    triangles.push({ vertices: face.slice(), area });
  }
  const edgeUse = new Map();
  for (const triangle of triangles) {
    const f = triangle.vertices;
    for (const [a, b] of [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]]) {
      const key = [a, b].sort().join("\u0000");
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const boundaryEdges = [...edgeUse].filter(([, count]) => count === 1).map(([edge]) => edge.split("\u0000"));
  const nonManifoldEdges = [...edgeUse].filter(([, count]) => count > 2).map(([edge, count]) => ({ vertices: edge.split("\u0000"), faceCount: count }));
  const referenced = new Set(triangles.flatMap((t) => t.vertices));
  const unreferencedVertices = [...ids.keys()].filter((id) => !referenced.has(id));
  return {
    schemaVersion: "1.0.0",
    method: "reviewed-wireframe-explicit-triangle-mesh",
    vertices: input.vertices.filter((v) => referenced.has(v.id)).map((v) => ({ id: v.id, position: v.point })),
    triangles,
    qa: {
      inputFaceCount: input.faces.length,
      acceptedFaceCount: triangles.length,
      rejectedFaces,
      boundaryEdgeCount: boundaryEdges.length,
      boundaryEdges,
      nonManifoldEdges,
      unreferencedVertexIds: unreferencedVertices,
      closedManifoldCandidate: triangles.length > 0 && boundaryEdges.length === 0 && nonManifoldEdges.length === 0,
    },
    limitations: [
      "Only explicitly supplied triangular faces are used; no missing surfaces are guessed.",
      "A closed manifold result is not proof of architectural accuracy.",
      "Texture, scale, georeferencing, watertightness of the real building and semantic correctness require separate validation.",
    ],
    publicationEligible: false,
  };
}
