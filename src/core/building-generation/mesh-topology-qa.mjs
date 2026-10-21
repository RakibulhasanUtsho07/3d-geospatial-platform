const DEFAULTS = Object.freeze({
  maxTopologyVertices: 250_000,
  weldToleranceRelative: 1e-6,
  maxLongEdgeRatio: 0.15,
  maxSmallComponentTriangles: 10,
});

function validNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateOptions(options) {
  const settings = { ...DEFAULTS, ...options };
  if (!Number.isSafeInteger(settings.maxTopologyVertices) || settings.maxTopologyVertices < 3 || settings.maxTopologyVertices > 1_000_000) {
    throw new RangeError("maxTopologyVertices must be between 3 and 1000000");
  }
  if (!validNumber(settings.weldToleranceRelative) || settings.weldToleranceRelative <= 0 || settings.weldToleranceRelative > 0.01) {
    throw new RangeError("weldToleranceRelative must be greater than 0 and at most 0.01");
  }
  if (!validNumber(settings.maxLongEdgeRatio) || settings.maxLongEdgeRatio <= 0 || settings.maxLongEdgeRatio > 1) {
    throw new RangeError("maxLongEdgeRatio must be greater than 0 and at most 1");
  }
  if (!Number.isSafeInteger(settings.maxSmallComponentTriangles) || settings.maxSmallComponentTriangles < 0 || settings.maxSmallComponentTriangles > 1_000_000) {
    throw new RangeError("maxSmallComponentTriangles must be between 0 and 1000000");
  }
  return settings;
}

function findRoot(parent, value) {
  let root = value;
  while (parent[root] !== root) root = parent[root];
  while (parent[value] !== value) {
    const next = parent[value];
    parent[value] = root;
    value = next;
  }
  return root;
}

function join(parent, rank, a, b) {
  let rootA = findRoot(parent, a), rootB = findRoot(parent, b);
  if (rootA === rootB) return;
  if (rank[rootA] < rank[rootB]) [rootA, rootB] = [rootB, rootA];
  parent[rootB] = rootA;
  if (rank[rootA] === rank[rootB]) rank[rootA]++;
}

function edgeKey(a, b) {
  return a < b ? a + ":" + b : b + ":" + a;
}

function distance(positions, a, b) {
  const dx = positions[a * 3] - positions[b * 3];
  const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
  const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
  return Math.hypot(dx, dy, dz);
}

/**
 * Calculate review-only topology hints for a triangle primitive.
 * Positions at texture seams are often duplicated in GLB, so vertices are
 * welded by a scale-relative spatial tolerance before edge/component analysis.
 * The vertex limit keeps memory bounded for large web-delivered models.
 */
export function analyzeTriangleTopology(positions, indices, options = {}) {
  if (!(positions instanceof Float32Array) || positions.length < 9 || positions.length % 3 !== 0) {
    throw new TypeError("positions must be a Float32Array with at least three VEC3 vertices");
  }
  if (!indices || !Number.isSafeInteger(indices.count) || indices.count < 3 || indices.count % 3 !== 0 || typeof indices.read !== "function") {
    throw new TypeError("indices must expose a triangle-aligned count and read(index) function");
  }

  const settings = validateOptions(options);
  const vertexCount = positions.length / 3;
  const triangleCount = indices.count / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis];
      if (!validNumber(value)) throw new TypeError("topology positions contain a non-finite coordinate");
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const longEdgeThreshold = diagonal * settings.maxLongEdgeRatio;
  let maxEdgeLength = 0, totalEdgeLength = 0, longEdgeCount = 0, longEdgeTriangleCount = 0;
  for (let i = 0; i < indices.count; i += 3) {
    const triangle = [indices.read(i), indices.read(i + 1), indices.read(i + 2)];
    let triangleHasLongEdge = false;
    for (const index of triangle) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= vertexCount) {
        throw new RangeError("topology triangle index is outside the POSITION accessor");
      }
    }
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
      const length = distance(positions, a, b);
      maxEdgeLength = Math.max(maxEdgeLength, length);
      totalEdgeLength += length;
      if (diagonal > 0 && length > longEdgeThreshold) {
        longEdgeCount++;
        triangleHasLongEdge = true;
      }
    }
    if (triangleHasLongEdge) longEdgeTriangleCount++;
  }

  const common = {
    vertexCount,
    triangleCount,
    modelDiagonal: Number(diagonal.toFixed(6)),
    longEdgeThreshold: Number(longEdgeThreshold.toFixed(6)),
    maxEdgeLength: Number(maxEdgeLength.toFixed(6)),
    meanEdgeLength: Number((totalEdgeLength / (triangleCount * 3)).toFixed(6)),
    longEdgeCount,
    longEdgeTriangleCount,
    longEdgeTriangleRatio: Number((longEdgeTriangleCount / triangleCount).toFixed(6)),
    weldedVertexCount: null,
    connectedComponentCount: null,
    smallDetachedComponentCount: null,
    uniqueEdgeCount: null,
    boundaryEdgeCount: null,
    boundaryEdgeRatio: null,
    nonManifoldEdgeCount: null,
    topologyAnalyzed: false,
    topologySkipReason: null,
    warnings: [],
  };

  if (vertexCount > settings.maxTopologyVertices) {
    common.topologySkipReason = "vertex-limit";
    common.warnings.push("topology-analysis-skipped-vertex-limit");
    if (longEdgeTriangleCount > 0) common.warnings.push("long-triangle-edges-present");
    return common;
  }

  const tolerance = Math.max(diagonal * settings.weldToleranceRelative, 1e-9);
  const canonical = new Int32Array(vertexCount);
  const coordinateKeys = new Map();
  let weldedVertexCount = 0;
  for (let i = 0; i < vertexCount; i++) {
    const x = Math.round((positions[i * 3] - min[0]) / tolerance);
    const y = Math.round((positions[i * 3 + 1] - min[1]) / tolerance);
    const z = Math.round((positions[i * 3 + 2] - min[2]) / tolerance);
    const key = x + "," + y + "," + z;
    let id = coordinateKeys.get(key);
    if (id === undefined) {
      id = weldedVertexCount++;
      coordinateKeys.set(key, id);
    }
    canonical[i] = id;
  }

  const parent = new Int32Array(weldedVertexCount);
  const rank = new Uint8Array(weldedVertexCount);
  const used = new Uint8Array(weldedVertexCount);
  for (let i = 0; i < weldedVertexCount; i++) parent[i] = i;
  const edgeUses = new Map();
  for (let i = 0; i < indices.count; i += 3) {
    const a = canonical[indices.read(i)], b = canonical[indices.read(i + 1)], c = canonical[indices.read(i + 2)];
    used[a] = 1; used[b] = 1; used[c] = 1;
    join(parent, rank, a, b); join(parent, rank, b, c);
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      if (from === to) continue;
      const key = edgeKey(from, to);
      edgeUses.set(key, (edgeUses.get(key) || 0) + 1);
    }
  }

  const rootTriangleCounts = new Map();
  for (let i = 0; i < indices.count; i += 3) {
    const root = findRoot(parent, canonical[indices.read(i)]);
    rootTriangleCounts.set(root, (rootTriangleCounts.get(root) || 0) + 1);
  }
  const usedRoots = new Set();
  for (let i = 0; i < used.length; i++) if (used[i]) usedRoots.add(findRoot(parent, i));

  let boundaryEdgeCount = 0, nonManifoldEdgeCount = 0;
  for (const uses of edgeUses.values()) {
    if (uses === 1) boundaryEdgeCount++;
    else if (uses > 2) nonManifoldEdgeCount++;
  }
  const connectedComponentCount = usedRoots.size;
  const componentTriangleCounts = [...rootTriangleCounts.values()].sort((a, b) => b - a);
  const smallDetachedComponentCount = componentTriangleCounts.slice(1).filter(count => count <= settings.maxSmallComponentTriangles).length;
  const uniqueEdgeCount = edgeUses.size;
  const boundaryEdgeRatio = uniqueEdgeCount ? boundaryEdgeCount / uniqueEdgeCount : 0;

  common.weldedVertexCount = weldedVertexCount;
  common.connectedComponentCount = connectedComponentCount;
  common.smallDetachedComponentCount = smallDetachedComponentCount;
  common.uniqueEdgeCount = uniqueEdgeCount;
  common.boundaryEdgeCount = boundaryEdgeCount;
  common.boundaryEdgeRatio = Number(boundaryEdgeRatio.toFixed(6));
  common.nonManifoldEdgeCount = nonManifoldEdgeCount;
  common.topologyAnalyzed = true;

  if (connectedComponentCount > 1) common.warnings.push("disconnected-mesh-components-present");
  if (smallDetachedComponentCount > 0) common.warnings.push("small-detached-components-present");
  if (longEdgeTriangleRatioExceeded(common)) common.warnings.push("long-triangle-edges-present");
  if (boundaryEdgeCount > 0) common.warnings.push("open-boundary-edges-present");
  if (nonManifoldEdgeCount > 0) common.warnings.push("non-manifold-edges-present");
  return common;
}

function longEdgeTriangleRatioExceeded(metrics) {
  return metrics.longEdgeTriangleRatio > 0.01;
}
