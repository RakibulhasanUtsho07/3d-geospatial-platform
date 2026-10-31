const SHA256 = /^[a-f0-9]{64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const TRUTH_BASES = new Set(["surveyed", "official-survey", "lidar", "cad-bim", "published-measurement", "independent-reference-mesh"]);
const DIMENSIONS = ["widthM", "depthM", "heightM"];
const EPSILON = 1e-9;
const RAW_METRICS = Symbol("unrounded comparison metrics");

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function validHash(value) {
  return typeof value === "string" && SHA256.test(value);
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(label + " must be finite.");
  return value;
}
function positive(value, label) {
  const number = finite(value, label);
  if (number <= 0) throw new RangeError(label + " must be greater than zero.");
  return number;
}
function safeId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError(label + " must be a safe identifier.");
  return value;
}
function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function rounded(value, digits = 4) {
  return Number(value.toFixed(digits));
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
function rawStatistics(values) {
  if (!values.length) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    sampleCount: values.length,
    meanM: sum / values.length,
    rmsM: Math.sqrt(values.reduce((total, value) => total + value * value, 0) / values.length),
    p95M: percentile(values, 0.95),
    maxM: Math.max(...values),
  };
}
function statistics(values) {
  const raw = rawStatistics(values);
  if (!raw) return null;
  const result = {
    sampleCount: raw.sampleCount,
    meanM: rounded(raw.meanM),
    rmsM: rounded(raw.rmsM),
    p95M: rounded(raw.p95M),
    maxM: rounded(raw.maxM),
  };
  Object.defineProperty(result, RAW_METRICS, { value: raw });
  return result;
}
function distance2(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
function pointSegmentDistance2(point, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared <= EPSILON) return distance2(point, a);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.z - (a.z + t * dz));
}
function orient(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}
function onSegment(a, b, p) {
  return Math.abs(orient(a, b, p)) <= EPSILON &&
    p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON &&
    p.z >= Math.min(a.z, b.z) - EPSILON && p.z <= Math.max(a.z, b.z) + EPSILON;
}
function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > EPSILON && o2 < -EPSILON) || (o1 < -EPSILON && o2 > EPSILON)) &&
      ((o3 > EPSILON && o4 < -EPSILON) || (o3 < -EPSILON && o4 > EPSILON))) return true;
  return (Math.abs(o1) <= EPSILON && onSegment(a, b, c)) ||
    (Math.abs(o2) <= EPSILON && onSegment(a, b, d)) ||
    (Math.abs(o3) <= EPSILON && onSegment(c, d, a)) ||
    (Math.abs(o4) <= EPSILON && onSegment(c, d, b));
}
function normalizeFootprint(raw, label) {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 500) {
    throw new RangeError(label + " must contain 3 to 500 ordered {x,z} vertices.");
  }
  const points = raw.map((point, index) => {
    if (!object(point)) throw new TypeError(label + "[" + index + "] must be an object.");
    return { x: finite(point.x, label + "[" + index + "].x"), z: finite(point.z, label + "[" + index + "].z") };
  });
  for (let i = 0; i < points.length; i++) {
    if (distance2(points[i], points[(i + 1) % points.length]) <= EPSILON) {
      throw new TypeError(label + " has a zero-length edge or duplicate adjacent vertex.");
    }
  }
  for (let i = 0; i < points.length; i++) {
    const iNext = (i + 1) % points.length;
    for (let j = i + 1; j < points.length; j++) {
      const jNext = (j + 1) % points.length;
      if (i === j || iNext === j || jNext === i) continue;
      if (i === 0 && jNext === 0) continue;
      if (segmentsIntersect(points[i], points[iNext], points[j], points[jNext])) {
        throw new TypeError(label + " self-intersects; supply one simple outer ring without holes.");
      }
    }
  }
  let twiceArea = 0, centroidX = 0, centroidZ = 0, perimeterM = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const cross = a.x * b.z - b.x * a.z;
    twiceArea += cross;
    centroidX += (a.x + b.x) * cross;
    centroidZ += (a.z + b.z) * cross;
    perimeterM += distance2(a, b);
    minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x);
    minZ = Math.min(minZ, a.z); maxZ = Math.max(maxZ, a.z);
  }
  const signedArea = twiceArea / 2;
  const areaM2 = Math.abs(signedArea);
  if (areaM2 <= EPSILON) throw new TypeError(label + " has zero area.");
  return {
    points, areaM2, perimeterM,
    centroid: { x: centroidX / (3 * twiceArea), z: centroidZ / (3 * twiceArea) },
    bounds: { widthM: maxX - minX, depthM: maxZ - minZ },
  };
}
function sampleBoundary(polygon, samplesPerEdge) {
  const points = [];
  for (let i = 0; i < polygon.points.length; i++) {
    const a = polygon.points[i], b = polygon.points[(i + 1) % polygon.points.length];
    for (let step = 0; step < samplesPerEdge; step++) {
      const t = step / samplesPerEdge;
      points.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  return points;
}
function boundaryDistances(sourceSamples, target) {
  return sourceSamples.map((point) => {
    let nearest = Infinity;
    for (let i = 0; i < target.points.length; i++) {
      nearest = Math.min(nearest, pointSegmentDistance2(point, target.points[i], target.points[(i + 1) % target.points.length]));
    }
    return nearest;
  });
}
function compareFootprints(candidateRaw, referenceRaw, samplesPerEdge = 8) {
  if (!Number.isSafeInteger(samplesPerEdge) || samplesPerEdge < 1 || samplesPerEdge > 16) {
    throw new RangeError("footprintSamplesPerEdge must be an integer from 1 to 16.");
  }
  const candidate = normalizeFootprint(candidateRaw, "candidate.footprint");
  const reference = normalizeFootprint(referenceRaw, "reference.footprint");
  const candidateToReference = boundaryDistances(sampleBoundary(candidate, samplesPerEdge), reference);
  const referenceToCandidate = boundaryDistances(sampleBoundary(reference, samplesPerEdge), candidate);
  const allDistances = [...candidateToReference, ...referenceToCandidate];
  const symmetricBoundary = statistics(allDistances);
  const areaAbsoluteErrorM2 = Math.abs(candidate.areaM2 - reference.areaM2);
  const areaRelativeErrorPercentRaw = areaAbsoluteErrorM2 / reference.areaM2 * 100;
  const result = {
    method: "symmetric sampled boundary-to-segment distance; each edge sampled at fixed fractions",
    candidateAreaM2: rounded(candidate.areaM2),
    referenceAreaM2: rounded(reference.areaM2),
    areaAbsoluteErrorM2: rounded(areaAbsoluteErrorM2),
    areaRelativeErrorPercent: rounded(areaRelativeErrorPercentRaw, 3),
    candidatePerimeterM: rounded(candidate.perimeterM),
    referencePerimeterM: rounded(reference.perimeterM),
    centroidOffsetM: rounded(distance2(candidate.centroid, reference.centroid)),
    candidateBounds: { widthM: rounded(candidate.bounds.widthM), depthM: rounded(candidate.bounds.depthM) },
    referenceBounds: { widthM: rounded(reference.bounds.widthM), depthM: rounded(reference.bounds.depthM) },
    boundaryDistance: {
      method: "two directed boundary samples measured to the nearest reference polygon segment",
      candidateToReference: statistics(candidateToReference),
      referenceToCandidate: statistics(referenceToCandidate),
      symmetric: symmetricBoundary,
    },
    sampleCount: allDistances.length,
    caveat: "Boundary distances are deterministic samples, not polygon IoU and not a continuous Hausdorff-distance proof. One simple outer ring is supported; holes are not represented.",
  };
  Object.defineProperty(result, RAW_METRICS, {
    value: {
      areaRelativeErrorPercent: areaRelativeErrorPercentRaw,
      boundaryP95M: symmetricBoundary[RAW_METRICS].p95M,
      boundaryMaxM: symmetricBoundary[RAW_METRICS].maxM,
    },
  });
  return result;
}
function normalizeDimensions(raw, label) {
  if (!object(raw)) throw new TypeError(label + " must be an object.");
  return Object.fromEntries(DIMENSIONS.map((key) => [key, positive(raw[key], label + "." + key)]));
}
function compareDimensions(candidateRaw, referenceRaw) {
  const candidate = normalizeDimensions(candidateRaw, "candidate.dimensionsM");
  const reference = normalizeDimensions(referenceRaw, "reference.dimensionsM");
  const relativeErrorsRaw = DIMENSIONS.map((key) => Math.abs(candidate[key] - reference[key]) / reference[key] * 100);
  const axes = DIMENSIONS.map((key, index) => {
    const absoluteErrorM = Math.abs(candidate[key] - reference[key]);
    return {
      dimension: key,
      candidateM: rounded(candidate[key]),
      referenceM: rounded(reference[key]),
      absoluteErrorM: rounded(absoluteErrorM),
      relativeErrorPercent: rounded(relativeErrorsRaw[index], 3),
    };
  });
  const maxRelativeErrorPercentRaw = Math.max(...relativeErrorsRaw);
  const result = {
    axes,
    maxRelativeErrorPercent: rounded(maxRelativeErrorPercentRaw, 3),
    rmsRelativeErrorPercent: rounded(Math.sqrt(relativeErrorsRaw.reduce((sum, value) => sum + value ** 2, 0) / relativeErrorsRaw.length), 3),
  };
  Object.defineProperty(result, RAW_METRICS, { value: { maxRelativeErrorPercent: maxRelativeErrorPercentRaw } });
  return result;
}
function normalizeCheckPoints(raw, label, reference = false) {
  if (!Array.isArray(raw) || raw.length > 1000) throw new TypeError(label + " must be an array of at most 1000 checkpoints.");
  const seen = new Set();
  return raw.map((point, index) => {
    if (!object(point)) throw new TypeError(label + "[" + index + "] must be an object.");
    const id = safeId(point.id, label + "[" + index + "].id");
    if (seen.has(id)) throw new TypeError(label + " contains duplicate point ID " + id + ".");
    seen.add(id);
    if (reference && point.independentOfFit !== true) {
      throw new TypeError("Reference check point " + id + " must explicitly declare independentOfFit: true.");
    }
    return { id, x: finite(point.x, label + "[" + index + "].x"),
      y: finite(point.y, label + "[" + index + "].y"), z: finite(point.z, label + "[" + index + "].z") };
  });
}
function compareCheckPoints(candidateRaw, referenceRaw) {
  const candidate = normalizeCheckPoints(candidateRaw, "candidate.checkPoints");
  const reference = normalizeCheckPoints(referenceRaw, "reference.checkPoints", true);
  if (!reference.length) throw new TypeError("At least one independently surveyed check point is required.");
  const candidateById = new Map(candidate.map((point) => [point.id, point]));
  const referenceIds = new Set(reference.map((point) => point.id));
  const matched = [], rawDistances = [], missingCandidatePointIds = [];
  for (const referencePoint of reference) {
    const modelPoint = candidateById.get(referencePoint.id);
    if (!modelPoint) { missingCandidatePointIds.push(referencePoint.id); continue; }
    const dxM = modelPoint.x - referencePoint.x;
    const dyM = modelPoint.y - referencePoint.y;
    const dzM = modelPoint.z - referencePoint.z;
    const errorM = Math.hypot(dxM, dyM, dzM);
    rawDistances.push(errorM);
    matched.push({
      id: referencePoint.id,
      dxM: rounded(dxM),
      dyM: rounded(dyM),
      dzM: rounded(dzM),
      errorM: rounded(errorM),
    });
  }
  const extraCandidatePointIds = candidate.filter((point) => !referenceIds.has(point.id)).map((point) => point.id);
  if (!matched.length) throw new TypeError("No candidate checkpoint IDs match independent reference checkpoints.");
  return { method: "3D Euclidean residual at held-out check points; check points must not be used for fitting",
    matchedPointCount: matched.length, referencePointCount: reference.length, candidatePointCount: candidate.length,
    missingCandidatePointIds, extraCandidatePointIds, points: matched, residuals: statistics(rawDistances) };
}
function vec3(raw, label) {
  if (!Array.isArray(raw) || raw.length !== 3) throw new TypeError(label + " must be a [x,y,z] tuple.");
  return raw.map((value, index) => finite(value, label + "[" + index + "]"));
}
function normalizeMesh(raw, label, candidateGlbSha256 = null) {
  if (!object(raw)) throw new TypeError(label + " must be an object.");
  if (candidateGlbSha256 && (!validHash(raw.sourceGlbSha256) ||
      raw.sourceGlbSha256.toLowerCase() !== candidateGlbSha256.toLowerCase())) {
    throw new TypeError(label + ".sourceGlbSha256 must bind mesh samples to the exact candidate GLB.");
  }
  if (!candidateGlbSha256 && !validHash(raw.sha256)) throw new TypeError(label + ".sha256 must identify the independent reference mesh bytes.");
  if (!Array.isArray(raw.vertices) || raw.vertices.length < 3 || raw.vertices.length > 25000) {
    throw new RangeError(label + ".vertices must contain 3 to 25000 vertices.");
  }
  if (!Array.isArray(raw.triangles) || raw.triangles.length < 1 || raw.triangles.length > 50000) {
    throw new RangeError(label + ".triangles must contain 1 to 50000 triangles.");
  }
  const vertices = raw.vertices.map((point, index) => vec3(point, label + ".vertices[" + index + "]"));
  const triangles = raw.triangles.map((face, index) => {
    if (!Array.isArray(face) || face.length !== 3 || face.some((vertex) => !Number.isSafeInteger(vertex) || vertex < 0 || vertex >= vertices.length)) {
      throw new TypeError(label + ".triangles[" + index + "] must contain three valid vertex indexes.");
    }
    if (new Set(face).size !== 3) throw new TypeError(label + ".triangles[" + index + "] repeats a vertex index.");
    const a = vertices[face[0]], b = vertices[face[1]], c = vertices[face[2]];
    const ab = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], ac = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const cross = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
    if (Math.hypot(...cross) <= EPSILON) throw new TypeError(label + ".triangles[" + index + "] is degenerate.");
    return { ids: face, a, b, c, min: [0,1,2].map((axis) => Math.min(a[axis], b[axis], c[axis])),
      max: [0,1,2].map((axis) => Math.max(a[axis], b[axis], c[axis])),
      center: [0,1,2].map((axis) => (a[axis] + b[axis] + c[axis]) / 3) };
  });
  return { vertices, triangles, sha256: candidateGlbSha256 || raw.sha256 };
}
function boundsFor(triangles) {
  return {
    min: [0,1,2].map((axis) => Math.min(...triangles.map((triangle) => triangle.min[axis]))),
    max: [0,1,2].map((axis) => Math.max(...triangles.map((triangle) => triangle.max[axis]))),
  };
}
function buildBvh(triangles) {
  const bounds = boundsFor(triangles);
  if (triangles.length <= 8) return { ...bounds, triangles };
  const centerBounds = {
    min: [0,1,2].map((axis) => Math.min(...triangles.map((triangle) => triangle.center[axis]))),
    max: [0,1,2].map((axis) => Math.max(...triangles.map((triangle) => triangle.center[axis]))),
  };
  const extents = centerBounds.max.map((value, axis) => value - centerBounds.min[axis]);
  const axis = extents.indexOf(Math.max(...extents));
  const ordered = [...triangles].sort((a, b) => a.center[axis] - b.center[axis]);
  const middle = Math.floor(ordered.length / 2);
  return { ...bounds, left: buildBvh(ordered.slice(0, middle)), right: buildBvh(ordered.slice(middle)) };
}
function pointAabbDistanceSquared(point, node) {
  let distance = 0;
  for (let axis = 0; axis < 3; axis++) {
    const delta = point[axis] < node.min[axis] ? node.min[axis] - point[axis] :
      point[axis] > node.max[axis] ? point[axis] - node.max[axis] : 0;
    distance += delta * delta;
  }
  return distance;
}
function pointTriangleDistanceSquared(p, a, b, c) {
  const ab = b.map((value, i) => value - a[i]), ac = c.map((value, i) => value - a[i]), ap = p.map((value, i) => value - a[i]);
  const dot = (u, v) => u.reduce((sum, value, i) => sum + value * v[i], 0);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = p.map((value, i) => value - b[i]), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3), closest = a.map((value, i) => value + v * ab[i]);
    return dot(p.map((value, i) => value - closest[i]), p.map((value, i) => value - closest[i]));
  }
  const cp = p.map((value, i) => value - c[i]), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6), closest = a.map((value, i) => value + w * ac[i]);
    const diff = p.map((value, i) => value - closest[i]); return dot(diff, diff);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const closest = b.map((value, i) => value + w * c[i] - w * b[i]);
    const diff = p.map((value, i) => value - closest[i]); return dot(diff, diff);
  }
  const denominator = 1 / (va + vb + vc), v = vb * denominator, w = vc * denominator;
  const closest = a.map((value, i) => value + ab[i] * v + ac[i] * w);
  const diff = p.map((value, i) => value - closest[i]); return dot(diff, diff);
}
function nearestTriangleDistanceSquared(point, node, best = Infinity) {
  if (pointAabbDistanceSquared(point, node) > best) return best;
  if (node.triangles) {
    for (const triangle of node.triangles) best = Math.min(best, pointTriangleDistanceSquared(point, triangle.a, triangle.b, triangle.c));
    return best;
  }
  const leftDistance = pointAabbDistanceSquared(point, node.left);
  const rightDistance = pointAabbDistanceSquared(point, node.right);
  if (leftDistance <= rightDistance) {
    best = nearestTriangleDistanceSquared(point, node.left, best);
    return nearestTriangleDistanceSquared(point, node.right, best);
  }
  best = nearestTriangleDistanceSquared(point, node.right, best);
  return nearestTriangleDistanceSquared(point, node.left, best);
}
function vertexToSurface(vertices, targetBvh) {
  return vertices.map((point) => Math.sqrt(nearestTriangleDistanceSquared(point, targetBvh)));
}
function compareSurfaceMeshes(candidateRaw, referenceRaw, candidateGlbSha256, referenceSourceSha256) {
  const candidate = normalizeMesh(candidateRaw, "candidate.surfaceMesh", candidateGlbSha256);
  const reference = normalizeMesh(referenceRaw, "reference.surfaceMesh");
  if (reference.sha256.toLowerCase() !== referenceSourceSha256.toLowerCase()) {
    throw new TypeError("reference.surfaceMesh.sha256 must bind the reference mesh to the exact independent source SHA-256.");
  }
  const candidateBvh = buildBvh(candidate.triangles), referenceBvh = buildBvh(reference.triangles);
  const candidateToReference = vertexToSurface(candidate.vertices, referenceBvh);
  const referenceToCandidate = vertexToSurface(reference.vertices, candidateBvh);
  const all = [...candidateToReference, ...referenceToCandidate];
  const directionalCandidate = statistics(candidateToReference), directionalReference = statistics(referenceToCandidate);
  const symmetricRaw = rawStatistics(all);
  const symmetric = {
    sampleCount: all.length,
    meanM: rounded(symmetricRaw.meanM),
    rmsM: rounded(symmetricRaw.rmsM),
    p95M: rounded(symmetricRaw.p95M),
    maxM: rounded(symmetricRaw.maxM),
  };
  Object.defineProperty(symmetric, RAW_METRICS, { value: symmetricRaw });
  return {
    method: "symmetric nearest-triangle distance sampled at vertices of both meshes using a bounding-volume hierarchy",
    candidateVertexCount: candidate.vertices.length, candidateTriangleCount: candidate.triangles.length,
    referenceVertexCount: reference.vertices.length, referenceTriangleCount: reference.triangles.length,
    candidateToReference: directionalCandidate, referenceToCandidate: directionalReference,
    symmetric,
    caveat: "This is vertex-sampled nearest-triangle distance, not continuous signed Hausdorff distance; triangle interiors are not uniformly sampled and surface completeness/topology require separate review.",
  };
}
function thresholdValue(tolerances, key, label, record) {
  const value = tolerances?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    record(label + "-threshold-configured", false, "No valid non-negative threshold was supplied for " + label + ".", "warning");
    return null;
  }
  return value;
}
function addMetricThreshold(record, tolerances, key, label, displayValue, unit, comparisonValue = displayValue) {
  const limit = thresholdValue(tolerances, key, label, record);
  if (limit === null) return null;
  const passed = comparisonValue <= limit;
  record(label + "-within-tolerance", passed,
    label + " = " + displayValue + unit + "; configured tolerance = " + limit + unit + ".");
  return { limit, passed };
}

/**
 * Compare candidate geometry against independently sourced geometry in the same
 * metre-based coordinate frame. Metrics remain evidence diagnostics; this function
 * never approves, publishes or marks a building map-ready.
 */
/**
 * Low-level, pure geometry-metric kernel.
 *
 * This function consumes already-normalized in-memory geometry and performs no
 * filesystem reads, source-byte replay or reviewer authentication. It is not
 * an authorized truth-evaluation entry point and its output is not a release
 * decision. The supported source-bound CLI performs the D3M-01.D receipt check
 * and exact-source replay before invoking this kernel.
 */
export function evaluateIndependentBuildingTruth(input = {}) {
  if (!object(input)) throw new TypeError("evaluation input must be an object.");
  if (input.schemaVersion !== "1.0.0") throw new TypeError("schemaVersion must be 1.0.0.");
  const evaluationId = safeId(input.evaluationId, "evaluationId");
  const buildingId = safeId(input.buildingId, "buildingId");
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!validTimestamp(generatedAt)) throw new TypeError("generatedAt must be a valid timestamp.");
  const candidate = input.candidate, reference = input.reference;
  if (!object(candidate) || !object(reference)) throw new TypeError("candidate and reference records are required.");
  if (!validHash(candidate.glbSha256)) throw new TypeError("candidate.glbSha256 must be a SHA-256 hash.");
  if (!validHash(reference.sourceSha256)) throw new TypeError("reference.sourceSha256 must be a SHA-256 hash.");
  safeId(reference.sourceId, "reference.sourceId");
  const checks = [], failures = [], warnings = [];
  function record(id, passed, detail, severity = "failure") {
    const item = { id, status: passed ? "passed" : severity === "warning" ? "warning" : "failed", detail };
    checks.push(item);
    if (!passed && severity === "warning") warnings.push(item);
    if (!passed && severity === "failure") failures.push(item);
  }
  const candidateHashMatches = validHash(candidate.geometrySourceGlbSha256) &&
    candidate.geometrySourceGlbSha256.toLowerCase() === candidate.glbSha256.toLowerCase();
  record("candidate-geometry-binds-to-exact-glb", candidateHashMatches,
    candidateHashMatches ? "Candidate geometry records declare the exact GLB SHA-256." :
      "Candidate geometry records must declare the same SHA-256 as the exact candidate GLB.");
  const referenceHashMatches = validHash(reference.geometrySourceSha256) &&
    reference.geometrySourceSha256.toLowerCase() === reference.sourceSha256.toLowerCase();
  record("reference-geometry-binds-to-source", referenceHashMatches,
    referenceHashMatches ? "Reference geometry records declare the exact independent source SHA-256." :
      "Reference geometry records must declare the SHA-256 of the independent truth source.");
  const evidenceValid = TRUTH_BASES.has(reference.evidenceBasis) && nonEmpty(reference.sourceDescription) &&
    nonEmpty(reference.reviewedBy) && validTimestamp(reference.reviewedAt);
  record("independent-truth-provenance", evidenceValid,
    evidenceValid ? "Reference basis and curator review metadata are present; source truth is still operator-attested, not independently authenticated." :
      "Reference truth needs an accepted evidence basis, source description, reviewer and valid review timestamp.");
  const frameMatches = nonEmpty(candidate.coordinateFrameId) &&
    candidate.coordinateFrameId === reference.coordinateFrameId &&
    candidate.units === "m" && reference.units === "m";
  record("shared-metric-coordinate-frame", frameMatches,
    frameMatches ? "Candidate and reference geometry declare the same coordinate-frame ID and metre units." :
      "Candidate and reference need the same coordinate-frame ID and metre units; do not compare unregistered local frames.");
  const toleranceConfiguration = input.tolerances && object(input.tolerances) ? input.tolerances : {};

  let footprint = null, dimensions = null, checkPoints = null, surfaceDistance = null;
  if (!Array.isArray(candidate.footprint) || !Array.isArray(reference.footprint)) {
    record("footprint-evidence-present", false, "Candidate and independent reference footprints are both required.", "warning");
  } else {
    try {
      footprint = compareFootprints(candidate.footprint, reference.footprint, input.footprintSamplesPerEdge ?? 8);
      record("footprint-geometry-computed", true,
        "Compared simple footprint rings using area, perimeter, centroid offset and symmetric sampled boundary distance.");
      addMetricThreshold(record, toleranceConfiguration, "footprintAreaRelativeErrorPercent",
        "footprint-area-relative-error", footprint.areaRelativeErrorPercent, "%", footprint[RAW_METRICS].areaRelativeErrorPercent);
      addMetricThreshold(record, toleranceConfiguration, "footprintBoundaryP95M",
        "footprint-boundary-p95", footprint.boundaryDistance.symmetric.p95M, " m", footprint[RAW_METRICS].boundaryP95M);
      addMetricThreshold(record, toleranceConfiguration, "footprintBoundaryMaxM",
        "footprint-boundary-max", footprint.boundaryDistance.symmetric.maxM, " m", footprint[RAW_METRICS].boundaryMaxM);
    } catch (error) {
      record("footprint-geometry-valid", false, error instanceof Error ? error.message : String(error));
    }
  }
  if (!object(candidate.dimensionsM) || !object(reference.dimensionsM)) {
    record("independent-dimensions-present", false, "Candidate and independently measured width/depth/height are required.", "warning");
  } else {
    try {
      dimensions = compareDimensions(candidate.dimensionsM, reference.dimensionsM);
      record("independent-dimensions-computed", true,
        "Width, depth and height are compared individually in metres; axis convention must match the declared frame.");
      addMetricThreshold(record, toleranceConfiguration, "dimensionRelativeErrorPercent",
        "dimension-relative-error-max", dimensions.maxRelativeErrorPercent, "%", dimensions[RAW_METRICS].maxRelativeErrorPercent);
    } catch (error) {
      record("independent-dimensions-valid", false, error instanceof Error ? error.message : String(error));
    }
  }
  if (!Array.isArray(candidate.checkPoints) || !Array.isArray(reference.checkPoints) ||
      !candidate.checkPoints.length || !reference.checkPoints.length) {
    record("independent-check-points-present", false,
      "Held-out reference check points are required and must not be used to fit scale, pose or model geometry.", "warning");
  } else {
    try {
      checkPoints = compareCheckPoints(candidate.checkPoints, reference.checkPoints);
      record("check-points-excluded-from-fit", true,
        "Reference check points are explicitly marked independentOfFit and compared by ID.");
      if (checkPoints.missingCandidatePointIds.length) {
        record("candidate-check-points-complete", false,
          "Candidate is missing held-out check points: " + checkPoints.missingCandidatePointIds.join(", ") + ".");
      }
      if (checkPoints.extraCandidatePointIds.length) {
        record("candidate-check-point-ids-match", false,
          "Candidate contains unmatched checkpoint IDs: " + checkPoints.extraCandidatePointIds.join(", ") + ".");
      }
      addMetricThreshold(record, toleranceConfiguration, "checkPointRmseM",
        "check-point-rmse", checkPoints.residuals.rmsM, " m", checkPoints.residuals[RAW_METRICS].rmsM);
      addMetricThreshold(record, toleranceConfiguration, "checkPointMaxM",
        "check-point-max", checkPoints.residuals.maxM, " m", checkPoints.residuals[RAW_METRICS].maxM);
    } catch (error) {
      record("check-points-valid", false, error instanceof Error ? error.message : String(error));
    }
  }
  const hasCandidateSurface = candidate.surfaceMesh !== undefined && candidate.surfaceMesh !== null;
  const hasReferenceSurface = reference.surfaceMesh !== undefined && reference.surfaceMesh !== null;
  if (hasCandidateSurface !== hasReferenceSurface) {
    record("surface-reference-pair-complete", false,
      "A surface metric needs both candidate and independently sourced reference meshes.", "warning");
  } else if (hasCandidateSurface && hasReferenceSurface) {
    try {
      surfaceDistance = compareSurfaceMeshes(candidate.surfaceMesh, reference.surfaceMesh, candidate.glbSha256, reference.sourceSha256);
      record("surface-distance-computed", true,
        "Computed symmetric vertex-sampled nearest-triangle distances with exact source-hash bindings.");
      addMetricThreshold(record, toleranceConfiguration, "surfaceDistanceP95M",
        "surface-distance-p95", surfaceDistance.symmetric.p95M, " m", surfaceDistance.symmetric[RAW_METRICS].p95M);
      addMetricThreshold(record, toleranceConfiguration, "surfaceDistanceMaxM",
        "surface-distance-max", surfaceDistance.symmetric.maxM, " m", surfaceDistance.symmetric[RAW_METRICS].maxM);
    } catch (error) {
      record("surface-distance-valid", false, error instanceof Error ? error.message : String(error));
    }
  }
  const status = failures.length ? "benchmark-failed" : warnings.length ? "benchmark-incomplete" : "benchmark-review-required";
  return {
    schemaVersion: "1.0.0", engine: "independent-building-truth-evaluator-v1",
    evaluationId, buildingId, generatedAt, status,
    candidate: { glbSha256: candidate.glbSha256.toLowerCase(), coordinateFrameId: candidate.coordinateFrameId ?? null, units: candidate.units ?? null },
    reference: {
      sourceId: reference.sourceId, sourceSha256: reference.sourceSha256.toLowerCase(),
      evidenceBasis: reference.evidenceBasis ?? "unknown", reviewedBy: reference.reviewedBy ?? null,
      reviewedAt: reference.reviewedAt ?? null, independentlyAuthenticated: false,
    },
    metrics: { footprint, dimensions, checkPoints, surfaceDistance },
    checks, warnings, failures,
    counts: { passed: checks.filter((item) => item.status === "passed").length,
      warnings: warnings.length, failures: failures.length },
    policy: {
      candidateGeometryValidated: false,
      independentReferenceVerified: false,
      heldOutCheckpointAccuracyVerified: false,
      groundTruth: false,
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
      dispatchAllowed: false,
    },
    limitations: [
      "This evaluator measures supplied geometry evidence; it does not independently extract footprint, dimensions, checkpoint identities or surface meshes from the GLB or survey source.",
      "A source hash binds the declared bytes but does not authenticate source identity, survey accuracy, curator independence or usage rights.",
      "Footprint boundary distances are sampled; polygon IoU, holes and continuous Hausdorff distance are not computed.",
      "Surface distance samples mesh vertices against the opposite mesh triangles; it is not continuous signed Hausdorff distance and cannot prove surface completeness or correct topology.",
      "Checkpoint independence is a manifest declaration. The curator must verify that these points were excluded from fitting and registration.",
      "No overall accuracy percentage, automatic model selection, publication approval or map-ready decision is produced.",
      "This pure in-memory metric kernel does not authenticate the D3M-01.D reviewer receipt; only the source-bound evaluator CLI performs that authorization check before calling this function.",
    ],
  };
}
