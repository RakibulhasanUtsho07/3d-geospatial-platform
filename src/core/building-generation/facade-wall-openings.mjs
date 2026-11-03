const EPSILON = 1e-8;

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(label + " must be a finite number");
  }
  return value;
}

function signedArea(points) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.u * next.y - next.u * point.y;
  }, 0) / 2;
}

function orientRing(points, counterClockwise) {
  const copy = points.map((point) => ({ u: point.u, y: point.y }));
  const area = signedArea(copy);
  if (Math.abs(area) <= EPSILON) throw new RangeError("facade opening contour has zero area");
  return (area > 0) === counterClockwise ? copy : copy.reverse();
}

function pointOnSegment(point, start, end) {
  const cross = (point.u - start.u) * (end.y - start.y) -
    (point.y - start.y) * (end.u - start.u);
  if (Math.abs(cross) > EPSILON) return false;
  const dot = (point.u - start.u) * (point.u - end.u) +
    (point.y - start.y) * (point.y - end.y);
  return dot <= EPSILON;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[index], b = ring[previous];
    if (pointOnSegment(point, a, b)) return true;
    const crosses = ((a.y > point.y) !== (b.y > point.y)) &&
      (point.u < (b.u - a.u) * (point.y - a.y) / (b.y - a.y) + a.u);
    if (crosses) inside = !inside;
  }
  return inside;
}

function orientation(a, b, c) {
  return (b.u - a.u) * (c.y - a.y) - (b.y - a.y) * (c.u - a.u);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c), abD = orientation(a, b, d);
  const cdA = orientation(c, d, a), cdB = orientation(c, d, b);
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
      ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
  return (Math.abs(abC) <= EPSILON && pointOnSegment(c, a, b)) ||
    (Math.abs(abD) <= EPSILON && pointOnSegment(d, a, b)) ||
    (Math.abs(cdA) <= EPSILON && pointOnSegment(a, c, d)) ||
    (Math.abs(cdB) <= EPSILON && pointOnSegment(b, c, d));
}

function ringBoundariesIntersect(first, second) {
  for (let a = 0; a < first.length; a++) {
    const a0 = first[a], a1 = first[(a + 1) % first.length];
    for (let b = 0; b < second.length; b++) {
      if (segmentsIntersect(a0, a1, second[b], second[(b + 1) % second.length])) return true;
    }
  }
  return false;
}

function ringsIntersect(first, second) {
  return ringBoundariesIntersect(first, second) ||
    pointInRing(first[0], second) || pointInRing(second[0], first);
}

function dedupeSorted(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    if (!result.length || Math.abs(value - result[result.length - 1]) > EPSILON) result.push(value);
  }
  return result;
}

function tessellateContours(contours) {
  const xValues = dedupeSorted(contours.flatMap((ring) => ring.map((point) => point.u)));
  const frontQuads = [];
  let faceAreaM2 = 0;

  for (let slab = 0; slab < xValues.length - 1; slab++) {
    const x0 = xValues[slab], x1 = xValues[slab + 1];
    if (x1 - x0 <= EPSILON) continue;
    const midX = (x0 + x1) / 2;
    const crossings = [];

    for (const ring of contours) {
      for (let index = 0; index < ring.length; index++) {
        const a = ring[index], b = ring[(index + 1) % ring.length];
        const minU = Math.min(a.u, b.u), maxU = Math.max(a.u, b.u);
        if (Math.abs(b.u - a.u) <= EPSILON || midX <= minU || midX >= maxU) continue;
        const interpolate = (x) => a.y + (b.y - a.y) * ((x - a.u) / (b.u - a.u));
        crossings.push({
          yMid: interpolate(midX),
          y0: interpolate(x0),
          y1: interpolate(x1),
        });
      }
    }

    crossings.sort((a, b) => a.yMid - b.yMid);
    if (crossings.length % 2 !== 0) {
      throw new RangeError("facade opening contours do not form closed, non-intersecting regions");
    }

    for (let index = 0; index < crossings.length; index += 2) {
      const lower = crossings[index], upper = crossings[index + 1];
      if (upper.yMid - lower.yMid <= EPSILON) continue;
      const quad = [
        { u: x0, y: lower.y0 },
        { u: x1, y: lower.y1 },
        { u: x1, y: upper.y1 },
        { u: x0, y: upper.y0 },
      ];
      const area = Math.abs(signedArea(quad));
      if (area <= EPSILON) continue;
      frontQuads.push(quad);
      faceAreaM2 += area;
    }
  }

  const boundaryEdges = [];
  for (let ringIndex = 0; ringIndex < contours.length; ringIndex++) {
    const ring = contours[ringIndex];
    for (let index = 0; index < ring.length; index++) {
      boundaryEdges.push({
        a: ring[index],
        b: ring[(index + 1) % ring.length],
        contourIndex: ringIndex,
      });
    }
  }
  return { frontQuads, boundaryEdges, faceAreaM2 };
}

export function createFacadeOpeningProfile({
  centerU,
  bottomM,
  widthM,
  heightM,
  shape = "rectangular",
  archSegments = 24,
}) {
  finite(centerU, "opening.centerU");
  finite(bottomM, "opening.bottomM");
  finite(widthM, "opening.widthM");
  finite(heightM, "opening.heightM");
  if (bottomM < 0 || widthM <= 0 || heightM <= 0) {
    throw new RangeError("opening bottom must be non-negative and width/height must be positive");
  }
  if (shape !== "rectangular" && shape !== "arched") {
    throw new TypeError("opening shape must be rectangular or arched");
  }
  if (!Number.isSafeInteger(archSegments) || archSegments < 8 || archSegments > 96) {
    throw new RangeError("archSegments must be an integer between 8 and 96");
  }

  const left = centerU - widthM / 2;
  const right = centerU + widthM / 2;
  const top = bottomM + heightM;
  if (shape === "rectangular") {
    return orientRing([
      { u: left, y: bottomM },
      { u: right, y: bottomM },
      { u: right, y: top },
      { u: left, y: top },
    ], true);
  }

  const radiusU = widthM / 2;
  const radiusY = Math.min(radiusU, heightM * 0.55);
  const spring = top - radiusY;
  const profile = [
    { u: left, y: bottomM },
    { u: right, y: bottomM },
    { u: right, y: spring },
  ];
  for (let segment = 1; segment <= archSegments; segment++) {
    const angle = Math.PI * segment / archSegments;
    profile.push({
      u: centerU + radiusU * Math.cos(angle),
      y: spring + radiusY * Math.sin(angle),
    });
  }
  return orientRing(profile, true);
}

function validateProfilesInsidePanel(lengthM, heightM, profiles) {
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index];
    for (const point of profile.points) {
      if (point.u <= EPSILON || point.u >= lengthM - EPSILON ||
          point.y <= -EPSILON || point.y >= heightM + EPSILON) {
        throw new RangeError("opening " + profile.id + " must be fully inside its wall panel");
      }
    }
    for (let other = 0; other < index; other++) {
      if (ringsIntersect(profile.points, profiles[other].points)) {
        throw new RangeError("wall openings must not overlap: " + profiles[other].id + " and " + profile.id);
      }
    }
  }
}

export function createWallPanelTopology({ lengthM, heightM, openings = [] }) {
  finite(lengthM, "wall.lengthM");
  finite(heightM, "wall.heightM");
  if (lengthM <= 0 || heightM <= 0) throw new RangeError("wall dimensions must be positive");
  if (!Array.isArray(openings)) throw new TypeError("wall.openings must be an array");
  if (openings.length > 128) throw new RangeError("a wall panel may contain at most 128 openings");

  const outer = orientRing([
    { u: 0, y: 0 },
    { u: lengthM, y: 0 },
    { u: lengthM, y: heightM },
    { u: 0, y: heightM },
  ], true);
  const seenIds = new Set();
  const records = openings.map((opening, index) => {
    if (!opening || typeof opening !== "object" || Array.isArray(opening)) {
      throw new TypeError("wall.openings[" + index + "] must be an object");
    }
    const id = typeof opening.id === "string" && opening.id.trim()
      ? opening.id.trim()
      : "opening-" + (index + 1);
    if (seenIds.has(id)) throw new TypeError("duplicate wall opening id: " + id);
    seenIds.add(id);
    if (opening.kind !== "window" && opening.kind !== "door") {
      throw new TypeError("wall opening kind must be window or door");
    }
    const points = createFacadeOpeningProfile(opening);
    const profileAreaM2 = Math.abs(signedArea(points));
    return {
      id,
      kind: opening.kind,
      shape: opening.shape ?? "rectangular",
      centerU: opening.centerU,
      bottomM: opening.bottomM,
      widthM: opening.widthM,
      heightM: opening.heightM,
      profileAreaM2,
      points: orientRing(points, false),
    };
  });

  validateProfilesInsidePanel(lengthM, heightM, records);
  const contours = [outer, ...records.map((record) => record.points)];
  const tessellation = tessellateContours(contours);
  const expectedAreaM2 = lengthM * heightM -
    records.reduce((sum, record) => sum + record.profileAreaM2, 0);
  if (Math.abs(tessellation.faceAreaM2 - expectedAreaM2) > Math.max(1e-5, lengthM * heightM * 1e-7)) {
    throw new Error("wall opening tessellation area does not match its declared profiles");
  }
  return {
    schemaVersion: "1.0.0",
    engine: "facade-wall-openings-v1",
    method: "scanline-triangulated-through-wall",
    lengthM,
    heightM,
    wallFaceAreaM2: Number(tessellation.faceAreaM2.toFixed(6)),
    expectedWallFaceAreaM2: Number(expectedAreaM2.toFixed(6)),
    frontQuads: tessellation.frontQuads,
    boundaryEdges: tessellation.boundaryEdges,
    openings: records.map(({ points, profileAreaM2, ...record }) => ({
      ...record,
      profileAreaM2: Number(profileAreaM2.toFixed(6)),
    })),
    contours,
  };
}

function mapWallPoint(edge, baseY, point, depth) {
  return [
    edge.p.x + edge.tangent.x * point.u + edge.out.x * depth,
    baseY + point.y,
    edge.p.z + edge.tangent.z * point.u + edge.out.z * depth,
  ];
}

function boundaryNormal(edge, a, b) {
  const du = b.u - a.u;
  const dy = b.y - a.y;
  return [
    edge.tangent.x * dy,
    -du,
    edge.tangent.z * dy,
  ];
}

function addExtrudedContours(geo, { edge, baseY, contours, frontDepth, depthM, material }) {
  finite(baseY, "wall.baseY");
  finite(frontDepth, "extrusion.frontDepth");
  finite(depthM, "extrusion.depthM");
  if (frontDepth <= 0 || depthM <= 0 || depthM > frontDepth + EPSILON) {
    throw new RangeError("extrusion depth must be positive and remain outside/at the facade plane");
  }
  const normalizedContours = contours.map((ring, index) => orientRing(ring, index === 0));
  const topology = tessellateContours(normalizedContours);
  const backDepth = frontDepth - depthM;

  for (const quad of topology.frontQuads) {
    const front = quad.map((point) => mapWallPoint(edge, baseY, point, frontDepth));
    const back = quad.map((point) => mapWallPoint(edge, baseY, point, backDepth));
    geo.quad(material, ...front, [edge.out.x, 0, edge.out.z]);
    geo.quad(material, ...back, [-edge.out.x, 0, -edge.out.z]);
  }
  for (const boundary of topology.boundaryEdges) {
    const frontA = mapWallPoint(edge, baseY, boundary.a, frontDepth);
    const frontB = mapWallPoint(edge, baseY, boundary.b, frontDepth);
    const backB = mapWallPoint(edge, baseY, boundary.b, backDepth);
    const backA = mapWallPoint(edge, baseY, boundary.a, backDepth);
    geo.quad(material, frontA, frontB, backB, backA, boundaryNormal(edge, boundary.a, boundary.b));
  }
  return { faceAreaM2: topology.faceAreaM2, boundaryEdgeCount: topology.boundaryEdges.length };
}

export function addWallPanelWithOpenings(geo, {
  edge,
  baseY,
  heightM,
  wallThicknessM,
  openings = [],
}) {
  finite(wallThicknessM, "wallThicknessM");
  if (wallThicknessM <= 0) throw new RangeError("wallThicknessM must be positive");
  const topology = createWallPanelTopology({
    lengthM: edge.len,
    heightM,
    openings,
  });
  for (const quad of topology.frontQuads) {
    const front = quad.map((point) => mapWallPoint(edge, baseY, point, 0));
    const back = quad.map((point) => mapWallPoint(edge, baseY, point, -wallThicknessM));
    geo.quad("wall", ...front, [edge.out.x, 0, edge.out.z]);
    geo.quad("wall", ...back, [-edge.out.x, 0, -edge.out.z]);
  }
  for (const boundary of topology.boundaryEdges) {
    const frontA = mapWallPoint(edge, baseY, boundary.a, 0);
    const frontB = mapWallPoint(edge, baseY, boundary.b, 0);
    const backB = mapWallPoint(edge, baseY, boundary.b, -wallThicknessM);
    const backA = mapWallPoint(edge, baseY, boundary.a, -wallThicknessM);
    geo.quad("wall", frontA, frontB, backB, backA, boundaryNormal(edge, boundary.a, boundary.b));
  }
  return {
    wallFaceAreaM2: topology.wallFaceAreaM2,
    openings: topology.openings,
    method: topology.method,
  };
}

export function addExtrudedFacadeProfile(geo, {
  edge,
  baseY,
  profile,
  holes = [],
  frontDepth,
  depthM,
  material,
}) {
  if (!Array.isArray(profile) || profile.length < 3) {
    throw new TypeError("facade profile must contain at least three vertices");
  }
  if (!Array.isArray(holes)) throw new TypeError("facade profile holes must be an array");
  const contours = [profile, ...holes];
  if (holes.length > 0) {
    const outer = orientRing(profile, true);
    const normalizedHoles = holes.map((hole) => orientRing(hole, false));
    for (const hole of normalizedHoles) {
      if (hole.some((point) => !pointInRing(point, outer)) ||
          ringBoundariesIntersect(outer, hole)) {
        throw new RangeError("facade profile hole must be fully inside its outer profile");
      }
    }
    for (let index = 0; index < normalizedHoles.length; index++) {
      for (let other = 0; other < index; other++) {
        if (ringsIntersect(normalizedHoles[index], normalizedHoles[other])) {
          throw new RangeError("facade profile holes must not overlap");
        }
      }
    }
    return addExtrudedContours(geo, {
      edge, baseY, contours: [outer, ...normalizedHoles], frontDepth, depthM, material,
    });
  }
  return addExtrudedContours(geo, {
    edge, baseY, contours, frontDepth, depthM, material,
  });
}
