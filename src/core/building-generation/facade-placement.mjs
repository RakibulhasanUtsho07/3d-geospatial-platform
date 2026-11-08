function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(label + " must be a finite number");
  }
}

function normalizedBearing(x, z) {
  const value = Math.atan2(x, z) * 180 / Math.PI;
  return (value + 360) % 360;
}

/**
 * Build a facade-local frame using the existing procedural local axes.
 * outwardSign is +1 for positive signed footprint area and -1 for negative.
 */
export function createFacadeFrame(start, end, outwardSign = 1) {
  for (const [label, point] of [["start", start], ["end", end]]) {
    if (!point || typeof point !== "object") {
      throw new TypeError(label + " point is required");
    }
    finite(point.x, label + ".x");
    finite(point.z, label + ".z");
  }
  if (outwardSign !== 1 && outwardSign !== -1) {
    throw new RangeError("outwardSign must be either 1 or -1");
  }

  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.25) {
    throw new RangeError("facade edge must be at least 0.25 metres long");
  }

  const tangent = { x: dx / len, z: dz / len };
  const out = {
    x: tangent.z * outwardSign,
    z: -tangent.x * outwardSign,
  };
  const yaw = Math.atan2(-tangent.z, tangent.x);
  return { len, tangent, out, yaw };
}

export function offsetFacadePoint(point, frame, tangentOffsetM = 0, outwardOffsetM = 0) {
  if (!point || typeof point !== "object" || !frame || typeof frame !== "object") {
    throw new TypeError("point and facade frame are required");
  }
  finite(point.x, "point.x");
  finite(point.z, "point.z");
  finite(tangentOffsetM, "tangentOffsetM");
  finite(outwardOffsetM, "outwardOffsetM");
  for (const axis of ["x", "z"]) {
    finite(frame.tangent?.[axis], "frame.tangent." + axis);
    finite(frame.out?.[axis], "frame.out." + axis);
  }

  return {
    x: point.x + frame.tangent.x * tangentOffsetM + frame.out.x * outwardOffsetM,
    z: point.z + frame.tangent.z * tangentOffsetM + frame.out.z * outwardOffsetM,
  };
}

/**
 * Place an insert so its inward face sits a small, explicit distance outside
 * the facade plane rather than leaving an arbitrary gap from the wall.
 */
export function surfaceInsertCenterOffset(depthM, faceClearanceM = 0.002) {
  finite(depthM, "depthM");
  finite(faceClearanceM, "faceClearanceM");
  if (depthM <= 0) throw new RangeError("depthM must be greater than zero");
  if (faceClearanceM < 0 || faceClearanceM > 0.05) {
    throw new RangeError("faceClearanceM must be between 0 and 0.05 metres");
  }
  return depthM / 2 + faceClearanceM;
}

/**
 * Select an edge using an explicit edge index, a clockwise-from-north bearing,
 * or (as a review-required fallback) the longest edge.
 *
 * Bearing vectors use the existing local convention in this codebase:
 * +X east and +Z north. This function deliberately does not change that frame.
 */
export function selectFrontFacadeEdge(edges, options = {}) {
  if (!Array.isArray(edges) || edges.length < 3) {
    throw new TypeError("edges must contain at least three facade frames");
  }
  const { frontFacadeEdgeIndex, frontFacingAzimuthDegrees } = options;
  if (frontFacadeEdgeIndex !== undefined && frontFacingAzimuthDegrees !== undefined &&
      frontFacingAzimuthDegrees !== null) {
    throw new TypeError("specify either frontFacadeEdgeIndex or frontFacingAzimuthDegrees, not both");
  }

  for (const [index, edge] of edges.entries()) {
    if (!edge || !edge.out || !Number.isFinite(edge.len) || edge.len < 0.25) {
      throw new TypeError("edges[" + index + "] is not a valid facade frame");
    }
    finite(edge.out.x, "edges[" + index + "].out.x");
    finite(edge.out.z, "edges[" + index + "].out.z");
  }

  let edgeIndex;
  let method;
  let confidence;
  let source;
  let requestedAzimuthDegrees = null;
  let alignmentDot = null;

  if (frontFacadeEdgeIndex !== undefined) {
    if (!Number.isSafeInteger(frontFacadeEdgeIndex) ||
        frontFacadeEdgeIndex < 0 || frontFacadeEdgeIndex >= edges.length) {
      throw new RangeError("frontFacadeEdgeIndex must select an existing footprint edge");
    }
    edgeIndex = frontFacadeEdgeIndex;
    method = "explicit-edge-index";
    confidence = "operator-specified";
    source = "buildingSpec.architecture.frontFacadeEdgeIndex";
  } else if (frontFacingAzimuthDegrees !== undefined && frontFacingAzimuthDegrees !== null) {
    finite(frontFacingAzimuthDegrees, "frontFacingAzimuthDegrees");
    if (frontFacingAzimuthDegrees < 0 || frontFacingAzimuthDegrees > 360) {
      throw new RangeError("frontFacingAzimuthDegrees must be between 0 and 360");
    }
    requestedAzimuthDegrees = frontFacingAzimuthDegrees;
    const radians = frontFacingAzimuthDegrees * Math.PI / 180;
    const requested = { x: Math.sin(radians), z: Math.cos(radians) };
    edgeIndex = edges.reduce((best, edge, index) => {
      const score = edge.out.x * requested.x + edge.out.z * requested.z;
      const bestScore = edges[best].out.x * requested.x + edges[best].out.z * requested.z;
      return score > bestScore ? index : best;
    }, 0);
    alignmentDot = edges[edgeIndex].out.x * requested.x + edges[edgeIndex].out.z * requested.z;
    method = "azimuth-nearest-edge";
    confidence = "operator-specified";
    source = "buildingSpec.architecture.frontFacingAzimuthDegrees";
  } else {
    edgeIndex = edges.reduce((best, edge, index) => edge.len > edges[best].len ? index : best, 0);
    method = "longest-edge-inferred";
    confidence = "estimated";
    source = "longest-edge-inferred";
  }

  const selected = edges[edgeIndex];
  const actualAzimuthDegrees = Number(normalizedBearing(selected.out.x, selected.out.z).toFixed(3));
  const alignmentWarning = alignmentDot !== null && alignmentDot < Math.cos(15 * Math.PI / 180);
  const inferredWarning = method === "longest-edge-inferred";
  const warnings = [];
  if (inferredWarning) {
    warnings.push("Front facade was inferred from the longest footprint edge; specify frontFacadeEdgeIndex or frontFacingAzimuthDegrees to select it explicitly.");
  }
  if (alignmentWarning) {
    warnings.push("Configured front-facing azimuth differs from the nearest footprint edge by more than 15 degrees.");
  }

  return {
    method,
    edgeIndex,
    confidence,
    source,
    requestedAzimuthDegrees,
    actualAzimuthDegrees,
    alignmentDot: alignmentDot === null ? null : Number(alignmentDot.toFixed(6)),
    reviewRequired: inferredWarning || alignmentWarning,
    warnings,
  };
}
