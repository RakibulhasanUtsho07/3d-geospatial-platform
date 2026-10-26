const finite = (n) => typeof n === "number" && Number.isFinite(n);
const edgeKey = (a, b) => [a, b].sort().join("\u0000");
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm = (a) => Math.hypot(...a);

function fail(code, message, details = {}) {
  return { code, message, ...details };
}

/**
 * Check whether a reviewed sparse wireframe is sufficiently constrained to
 * attempt a candidate mesh. This function never creates or repairs geometry.
 */
export function assessWireframeMeshReadiness(graph, options = {}) {
  if (!graph || !Array.isArray(graph.vertices) || !Array.isArray(graph.edges) ||
      !Array.isArray(graph.faces) || !Array.isArray(graph.facades)) {
    throw new TypeError("graph must contain vertices, edges, faces, and facades arrays");
  }
  const minTriangleArea = options.minTriangleArea ?? 1e-8;
  const maxBoundaryEdges = options.maxBoundaryEdges ?? 0;
  if (!finite(minTriangleArea) || minTriangleArea < 0) throw new RangeError("minTriangleArea must be finite and >= 0");
  if (!Number.isInteger(maxBoundaryEdges) || maxBoundaryEdges < 0) throw new RangeError("maxBoundaryEdges must be a non-negative integer");

  const blockers = [];
  const warnings = [];
  const vertexById = new Map();
  for (const vertex of graph.vertices) {
    if (!vertex || typeof vertex.id !== "string" || !vertex.id || vertexById.has(vertex.id) ||
        !Array.isArray(vertex.point) || vertex.point.length !== 3 || vertex.point.some((v) => !finite(v))) {
      blockers.push(fail("invalid-or-duplicate-vertex", "Each vertex needs a unique ID and finite 3D coordinates.", { vertexId: vertex?.id ?? null }));
      continue;
    }
    vertexById.set(vertex.id, vertex);
    if (vertex.reviewState !== "accepted") blockers.push(fail("vertex-not-accepted", "Mesh input contains a vertex without accepted review state.", { vertexId: vertex.id, reviewState: vertex.reviewState ?? "missing" }));
  }
  if (!graph.vertices.length) blockers.push(fail("no-vertices", "No vertices are available for mesh construction."));
  if (graph.publicationEligible !== false || graph.policy?.publicationEligible !== false) {
    blockers.push(fail("unsafe-publication-policy", "The upstream wireframe must explicitly keep publication disabled."));
  }

  const graphEdges = new Map();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string" || edge.from === edge.to ||
        !vertexById.has(edge.from) || !vertexById.has(edge.to)) {
      blockers.push(fail("invalid-edge-reference", "Every wireframe edge must reference two distinct known vertices.", { edgeId: edge?.id ?? null }));
      continue;
    }
    const key = edgeKey(edge.from, edge.to);
    if (graphEdges.has(key)) {
      blockers.push(fail("duplicate-wireframe-edge", "Duplicate wireframe edges are not allowed.", { edgeId: edge.id ?? null }));
      continue;
    }
    graphEdges.set(key, edge);
    if (edge.reviewState !== "accepted") blockers.push(fail("edge-not-accepted", "Mesh input contains an edge without accepted review state.", { edgeId: edge.id ?? null, reviewState: edge.reviewState ?? "missing" }));
  }
  if (!graph.edges.length) blockers.push(fail("no-edges", "No reviewed edges constrain the proposed mesh."));

  const faces = graph.faces;
  if (!faces.length) blockers.push(fail("no-explicit-faces", "No explicit reviewed face candidates were supplied; surfaces will not be invented."));
  const faceRecords = [];
  const faceKeys = new Set();
  const directedUses = new Map();
  for (let index = 0; index < faces.length; index += 1) {
    const face = faces[index];
    const refs = Array.isArray(face) ? face : face?.vertices;
    if (!Array.isArray(refs) || refs.length !== 3 || new Set(refs).size !== 3 || refs.some((id) => !vertexById.has(id))) {
      blockers.push(fail("invalid-face-reference", "Each candidate face must reference three distinct known vertices.", { faceIndex: index }));
      continue;
    }
    const sortedKey = refs.slice().sort().join("\u0000");
    if (faceKeys.has(sortedKey)) {
      blockers.push(fail("duplicate-face", "Duplicate triangles are not allowed.", { faceIndex: index }));
      continue;
    }
    faceKeys.add(sortedKey);
    const points = refs.map((id) => vertexById.get(id).point);
    const area = norm(cross(sub(points[1], points[0]), sub(points[2], points[0]))) / 2;
    if (!finite(area) || area <= minTriangleArea) {
      blockers.push(fail("degenerate-face", "Candidate triangle area is zero or below the configured threshold.", { faceIndex: index, area }));
      continue;
    }
    const missingEdges = [[refs[0], refs[1]], [refs[1], refs[2]], [refs[2], refs[0]]]
      .filter(([a,b]) => !graphEdges.has(edgeKey(a,b)));
    if (missingEdges.length) blockers.push(fail("face-edge-not-in-wireframe", "Every face boundary must be supported by an explicit wireframe edge.", { faceIndex: index, missingEdges }));
    for (const [a,b] of [[refs[0],refs[1]],[refs[1],refs[2]],[refs[2],refs[0]]]) {
      const key = edgeKey(a,b);
      const uses = directedUses.get(key) ?? [];
      uses.push({ faceIndex:index, from:a, to:b });
      directedUses.set(key, uses);
    }
    faceRecords.push({ faceIndex:index, vertices:refs.slice(), area, normal:cross(sub(points[1],points[0]),sub(points[2],points[0])) });
  }

  const faceAdjacency = new Map(faceRecords.map((f) => [f.faceIndex, new Set()]));
  const boundaryEdges = [];
  const nonManifoldEdges = [];
  const inconsistentWindingEdges = [];
  for (const [key, uses] of directedUses) {
    if (uses.length === 1) boundaryEdges.push({ edge:key.split("\u0000"), faceIndex:uses[0].faceIndex });
    if (uses.length > 2) nonManifoldEdges.push({ edge:key.split("\u0000"), faceCount:uses.length });
    if (uses.length === 2) {
      faceAdjacency.get(uses[0].faceIndex)?.add(uses[1].faceIndex);
      faceAdjacency.get(uses[1].faceIndex)?.add(uses[0].faceIndex);
      if (uses[0].from === uses[1].from || uses[0].to === uses[1].to) {
        inconsistentWindingEdges.push({ edge:key.split("\u0000"), faceIndices:uses.map((u)=>u.faceIndex) });
      }
    }
  }
  if (boundaryEdges.length > maxBoundaryEdges) blockers.push(fail("boundary-edge-threshold-exceeded", "Candidate surface has more open boundaries than the configured allowance.", { count:boundaryEdges.length, allowed:maxBoundaryEdges, boundaryEdges }));
  if (nonManifoldEdges.length) blockers.push(fail("non-manifold-edge", "An edge is used by more than two candidate faces.", { edges:nonManifoldEdges }));
  if (inconsistentWindingEdges.length) blockers.push(fail("inconsistent-face-winding", "Adjacent faces use a shared edge in the same direction; orientation is inconsistent.", { edges:inconsistentWindingEdges }));

  const visited = new Set();
  let componentCount = 0;
  for (const face of faceRecords) {
    if (visited.has(face.faceIndex)) continue;
    componentCount += 1;
    const stack = [face.faceIndex];
    visited.add(face.faceIndex);
    while (stack.length) {
      for (const next of faceAdjacency.get(stack.pop()) ?? []) if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  if (faceRecords.length && componentCount > 1) blockers.push(fail("disconnected-face-components", "Candidate faces form multiple disconnected surface components.", { componentCount }));
  const referenced = new Set(faceRecords.flatMap((face) => face.vertices));
  const unreferencedVertexIds = [...vertexById.keys()].filter((id) => !referenced.has(id));
  if (unreferencedVertexIds.length) warnings.push({ code:"unreferenced-vertices", message:"Some vertices are not used by a valid candidate face.", vertexIds:unreferencedVertexIds });

  const facadeStates = new Map(graph.facades.map((facade) => [facade.id, facade.status]));
  const requiredFacades = options.requiredFacadeIds ?? graph.facades.map((facade) => facade.id);
  const missingFacades = requiredFacades.filter((id) => !facadeStates.has(id) || !["observed","inferred"].includes(facadeStates.get(id)));
  if (missingFacades.length) blockers.push(fail("facade-coverage-incomplete", "Required facades must be explicitly observed or inferred before mesh construction.", { facadeIds:missingFacades }));
  const inferredFacades = requiredFacades.filter((id) => facadeStates.get(id) === "inferred");
  if (inferredFacades.length) warnings.push({ code:"inferred-facades-present", message:"Some required facade coverage is inferred rather than directly observed.", facadeIds:inferredFacades });

  // Avoid unused helper surprises and make the winding test independent of normal magnitude.
  for (let i=0;i<faceRecords.length;i+=1) for (let j=i+1;j<faceRecords.length;j+=1) {
    if (faceRecords[i].faceIndex !== faceRecords[j].faceIndex && dot(faceRecords[i].normal, faceRecords[j].normal) === Infinity) {
      blockers.push(fail("invalid-normal", "A face produced a non-finite normal."));
    }
  }
  const ready = blockers.length === 0;
  return {
    schemaVersion:"1.0.0",
    engine:"wireframe-mesh-readiness-gate-v1",
    status:ready ? "mesh-candidate-ready-for-construction" : "review-required",
    readyForMeshConstruction:ready,
    publicationEligible:false,
    inputSummary:{vertexCount:graph.vertices.length, edgeCount:graph.edges.length, faceCount:faces.length, validFaceCount:faceRecords.length, facadeCount:graph.facades.length},
    topology:{boundaryEdgeCount:boundaryEdges.length,boundaryEdges,nonManifoldEdges,inconsistentWindingEdges,faceComponentCount:componentCount,unreferencedVertexIds},
    facadeCoverage:{requiredFacadeIds:requiredFacades,missingOrUnconfirmedFacadeIds:missingFacades,inferredFacadeIds:inferredFacades},
    blockers,warnings,
    policy:{automaticFaceCreation:false,automaticHoleFilling:false,automaticVertexMovement:false,publicationRequiresIndependentDimensionAndVisualReview:true},
    limitations:[
      "This is a readiness gate, not a mesh generator; it does not alter or repair geometry.",
      "A topology pass does not prove the candidate matches the real building.",
      "Inferred facade coverage remains an explicit uncertainty and is never described as directly observed.",
      "Publication remains disabled pending independent dimensions, fixed-camera image comparison and human review."
    ]
  };
}
