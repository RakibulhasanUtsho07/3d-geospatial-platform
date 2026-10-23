const EPSILON = 1e-9;

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(label + " must be a finite number");
  }
}

export function createFacadeFrame(start, end, outwardSign = 1) {
  for (const [label, point] of [["start", start], ["end", end]]) {
    if (!point || typeof point !== "object") throw new TypeError(label + " point is required");
    finite(point.x, label + ".x");
    finite(point.z, label + ".z");
  }

  if (outwardSign !== 1 && outwardSign !== -1) {
    throw new RangeError("outwardSign must be either 1 or -1");
  }

  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.25) throw new RangeError("facade edge must be at least 0.25 metres long");

  const tangent = { x: dx / len, z: dz / len };
  // Local +X follows the facade; local +Z points inward, so 'out' is the exterior normal.
  // The polygon's winding determines which side of an edge is outside.
  const out = { x: tangent.z * outwardSign, z: -tangent.x * outwardSign };
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

export function surfaceInsertCenterOffset(depthM, faceClearanceM = 0.002) {
  finite(depthM, "depthM");
  finite(faceClearanceM, "faceClearanceM");
  if (depthM <= 0) throw new RangeError("depthM must be greater than zero");
  if (faceClearanceM < 0 || faceClearanceM > 0.05) {
    throw new RangeError("faceClearanceM must be between 0 and 0.05 metres");
  }
  // The insert's inner face sits just outside the wall's exterior plane.
  return depthM / 2 + faceClearanceM;
}
