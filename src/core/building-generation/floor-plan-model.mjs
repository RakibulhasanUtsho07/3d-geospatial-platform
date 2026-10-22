import { createHash } from "node:crypto";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const EPSILON = 1e-8;
const MATERIALS = [
  { key: "wall", name: "Interior Wall", color: "#E5E0D6", roughness: 0.9 },
  { key: "floor", name: "Floor Slab", color: "#B9A88B", roughness: 0.85 },
  { key: "door", name: "Door Leaf", color: "#79543B", roughness: 0.82 },
  { key: "glass", name: "Window Glass", color: "#668BA5", roughness: 0.25 },
  { key: "frame", name: "Door and Window Frame", color: "#F1EEE6", roughness: 0.65 },
];

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be an object.");
  }
  return value;
}

function number(value, label, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(label + " must be a finite number.");
  }
  if (value < min || value > max) {
    throw new RangeError(label + " must be between " + min + " and " + max + ".");
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new TypeError(label + " must be a safe identifier of at most 80 characters.");
  }
  return value;
}

function text(value, label, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new TypeError(label + " must be a non-empty string of at most " + max + " characters.");
  }
  return value.trim();
}

function point(value, label) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError(label + " must be [x, z] in metres.");
  }
  return {
    x: number(value[0], label + "[0]", -1000, 1000),
    z: number(value[1], label + "[1]", -1000, 1000),
  };
}

function cross2(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function polygonArea(points) {
  return points.reduce((sum, p, index) => {
    const next = points[(index + 1) % points.length];
    return sum + p.x * next.z - next.x * p.z;
  }, 0) / 2;
}

function between(value, a, b) {
  return value >= Math.min(a, b) - EPSILON && value <= Math.max(a, b) + EPSILON;
}

function onSegment(a, b, p) {
  return Math.abs(cross2(a, b, p)) <= EPSILON &&
    between(p.x, a.x, b.x) && between(p.z, a.z, b.z);
}

function segmentsIntersect(a, b, c, d) {
  const abC = cross2(a, b, c);
  const abD = cross2(a, b, d);
  const cdA = cross2(c, d, a);
  const cdB = cross2(c, d, b);
  if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON)) &&
      ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))) return true;
  return (Math.abs(abC) <= EPSILON && onSegment(a, b, c)) ||
    (Math.abs(abD) <= EPSILON && onSegment(a, b, d)) ||
    (Math.abs(cdA) <= EPSILON && onSegment(c, d, a)) ||
    (Math.abs(cdB) <= EPSILON && onSegment(c, d, b));
}

function simplifyCollinear(points) {
  let result = points.slice();
  let changed = true;
  while (changed && result.length > 3) {
    changed = false;
    for (let i = 0; i < result.length; i += 1) {
      const before = result[(i + result.length - 1) % result.length];
      const current = result[i];
      const after = result[(i + 1) % result.length];
      if (Math.abs(cross2(before, current, after)) <= EPSILON &&
          between(current.x, before.x, after.x) && between(current.z, before.z, after.z)) {
        result.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

function normalizePolygon(value, label) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 256) {
    throw new TypeError(label + " must contain between 3 and 256 points.");
  }
  let points = value.map((entry, index) => point(entry, label + "[" + index + "]"));
  const same = (a, b) => Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.z - b.z) <= EPSILON;
  if (points.length > 3 && same(points[0], points[points.length - 1])) points = points.slice(0, -1);
  for (let i = 0; i < points.length; i += 1) {
    if (same(points[i], points[(i + 1) % points.length])) {
      throw new RangeError(label + " contains a duplicate adjacent point.");
    }
    const next = points[(i + 1) % points.length];
    if (Math.hypot(next.x - points[i].x, next.z - points[i].z) < 0.05) {
      throw new RangeError(label + " contains an edge shorter than 0.05 metres.");
    }
  }
  points = simplifyCollinear(points);
  if (points.length < 3) throw new RangeError(label + " is degenerate.");
  const area = polygonArea(points);
  if (Math.abs(area) < 0.25) throw new RangeError(label + " must cover at least 0.25 square metres.");
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let j = i + 1; j < points.length; j += 1) {
      const adjacent = j === i || j === (i + 1) % points.length || i === (j + 1) % points.length;
      if (adjacent) continue;
      const c = points[j];
      const d = points[(j + 1) % points.length];
      if (segmentsIntersect(a, b, c, d)) throw new RangeError(label + " self-intersects.");
    }
  }
  return points;
}

function triangulate(points, label) {
  const signedArea = polygonArea(points);
  const order = points.map((_, index) => index);
  if (signedArea < 0) order.reverse();
  const triangles = [];
  let guard = 0;
  while (order.length > 3 && guard < points.length * points.length) {
    guard += 1;
    let clipped = false;
    for (let i = 0; i < order.length; i += 1) {
      const a = order[(i + order.length - 1) % order.length];
      const b = order[i];
      const c = order[(i + 1) % order.length];
      if (cross2(points[a], points[b], points[c]) <= EPSILON) continue;
      const inside = order.some((index) => {
        if (index === a || index === b || index === c) return false;
        const p = points[index];
        return cross2(points[a], points[b], p) >= -EPSILON &&
          cross2(points[b], points[c], p) >= -EPSILON &&
          cross2(points[c], points[a], p) >= -EPSILON;
      });
      if (inside) continue;
      triangles.push([points[a], points[b], points[c]]);
      order.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new RangeError(label + " could not be triangulated; inspect the traced polygon.");
  }
  if (order.length !== 3) throw new RangeError(label + " could not be triangulated.");
  triangles.push(order.map((index) => points[index]));
  return triangles;
}

function normalizeFloorPlan(raw) {
  const input = record(raw, "floor plan");
  if ((input.schemaVersion ?? "1.0.0") !== "1.0.0") {
    throw new TypeError("schemaVersion must be 1.0.0.");
  }
  if (input.units !== "m") throw new TypeError("units must be 'm'; all vector coordinates and dimensions are metres.");
  const id = identifier(input.id, "id");
  const buildingId = identifier(input.buildingId, "buildingId");
  const name = text(input.name, "name");
  const origin = record(input.origin, "origin");
  const normalizedOrigin = {
    longitude: number(origin.longitude, "origin.longitude", -180, 180),
    latitude: number(origin.latitude, "origin.latitude", -85, 85),
    heightM: number(origin.heightM, "origin.heightM", -1000, 10000),
    headingDegrees: number(origin.headingDegrees, "origin.headingDegrees", 0, 359.999999),
  };
  const level = record(input.level, "level");
  const normalizedLevel = {
    elevationM: number(level.elevationM, "level.elevationM", -1000, 10000),
    wallHeightM: number(level.wallHeightM, "level.wallHeightM", 2, 8),
    wallThicknessM: number(level.wallThicknessM, "level.wallThicknessM", 0.05, 0.75),
    floorThicknessM: number(level.floorThicknessM, "level.floorThicknessM", 0.03, 0.5),
  };
  if (!Array.isArray(input.rooms) || input.rooms.length < 1 || input.rooms.length > 500) {
    throw new TypeError("rooms must contain between 1 and 500 room polygons.");
  }
  if (!Array.isArray(input.walls) || input.walls.length < 1 || input.walls.length > 2000) {
    throw new TypeError("walls must contain between 1 and 2000 explicit wall centre-lines.");
  }
  const allIds = new Set([id, buildingId]);
  function uniqueId(value, label) {
    const valueId = identifier(value, label);
    if (allIds.has(valueId)) throw new TypeError("duplicate floor-plan identifier: " + valueId);
    allIds.add(valueId);
    return valueId;
  }
  const rooms = input.rooms.map((rawRoom, index) => {
    const room = record(rawRoom, "rooms[" + index + "]");
    const roomId = uniqueId(room.id, "rooms[" + index + "].id");
    const roomName = text(room.name, "rooms[" + index + "].name");
    const polygon = normalizePolygon(room.polygon, "rooms[" + index + "].polygon");
    return { id: roomId, name: roomName, polygon, areaM2: Math.abs(polygonArea(polygon)) };
  });
  let openingCount = 0;
  const walls = input.walls.map((rawWall, index) => {
    const wall = record(rawWall, "walls[" + index + "]");
    const wallId = uniqueId(wall.id, "walls[" + index + "].id");
    const start = point(wall.start, "walls[" + index + "].start");
    const end = point(wall.end, "walls[" + index + "].end");
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const lengthM = Math.hypot(dx, dz);
    if (lengthM < 0.1) throw new RangeError("wall '" + wallId + "' must be at least 0.1 metres long.");
    const wallHeightM = wall.heightM === undefined
      ? normalizedLevel.wallHeightM
      : number(wall.heightM, "wall heightM", 2, 8);
    const thicknessM = wall.thicknessM === undefined
      ? normalizedLevel.wallThicknessM
      : number(wall.thicknessM, "wall thicknessM", 0.05, 0.75);
    if (wallHeightM > normalizedLevel.wallHeightM + EPSILON) {
      throw new RangeError("wall '" + wallId + "' cannot be taller than level.wallHeightM.");
    }
    if (!Array.isArray(wall.openings) || wall.openings.length > 20) {
      throw new TypeError("wall '" + wallId + "' openings must be an array with at most 20 entries.");
    }
    const openings = wall.openings.map((rawOpening, openingIndex) => {
      const opening = record(rawOpening, "wall '" + wallId + "' opening");
      const openingId = uniqueId(
        opening.id ?? (wallId + "-opening-" + (openingIndex + 1)),
        "opening id",
      );
      const type = opening.type;
      if (type !== "door" && type !== "window") throw new TypeError("opening type must be 'door' or 'window'.");
      const offsetM = number(opening.offsetM, "opening offsetM", 0, lengthM);
      const widthM = number(opening.widthM, "opening widthM", 0.3, 4.5);
      const heightM = number(opening.heightM, "opening heightM", 0.4, wallHeightM);
      const sillHeightM = number(opening.sillHeightM, "opening sillHeightM", 0, wallHeightM);
      if (offsetM + widthM > lengthM + EPSILON) {
        throw new RangeError("opening '" + openingId + "' extends beyond its wall.");
      }
      if (sillHeightM + heightM > wallHeightM + EPSILON) {
        throw new RangeError("opening '" + openingId + "' extends above its wall.");
      }
      if (type === "door" && sillHeightM > 0.05) {
        throw new RangeError("door '" + openingId + "' must start at floor level (sillHeightM <= 0.05).");
      }
      return { id: openingId, type, offsetM, widthM, heightM, sillHeightM };
    }).sort((a, b) => a.offsetM - b.offsetM);
    for (let i = 1; i < openings.length; i += 1) {
      if (openings[i].offsetM < openings[i - 1].offsetM + openings[i - 1].widthM - EPSILON) {
        throw new RangeError("wall '" + wallId + "' contains overlapping openings.");
      }
    }
    openingCount += openings.length;
    return { id: wallId, start, end, dx, dz, lengthM, wallHeightM, thicknessM, openings };
  });
  if (openingCount > 2000) throw new RangeError("floor plan contains more than 2000 openings.");
  const evidence = input.source === undefined ? null : (() => {
    const source = record(input.source, "source");
    return {
      sourceId: identifier(source.sourceId, "source.sourceId"),
      sha256: (() => {
        if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sha256)) {
          throw new TypeError("source.sha256 must be a 64-character SHA-256 hash.");
        }
        return source.sha256.toLowerCase();
      })(),
    };
  })();
  return {
    schemaVersion: "1.0.0",
    id,
    buildingId,
    name,
    units: "m",
    origin: normalizedOrigin,
    level: normalizedLevel,
    rooms,
    walls,
    evidence,
  };
}

function normal(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const length = Math.hypot(...cross) || 1;
  return cross.map((value) => value / length);
}

function createGeometry() {
  const groups = new Map(MATERIALS.map((material) => [
    material.key, { positions: [], normals: [], indices: [] },
  ]));
  function triangle(material, a, b, c, expected) {
    let points = [a, b, c];
    let n = normal(...points);
    if (expected && n.reduce((sum, value, index) => sum + value * expected[index], 0) < 0) {
      points = [a, c, b];
      n = normal(...points);
    }
    const group = groups.get(material);
    const base = group.positions.length / 3;
    for (const p of points) {
      group.positions.push(...p);
      group.normals.push(...n);
    }
    group.indices.push(base, base + 1, base + 2);
  }
  function quad(material, a, b, c, d, expected) {
    triangle(material, a, b, c, expected);
    triangle(material, a, c, d, expected);
  }
  function box(material, cx, cy, cz, lengthM, heightM, depthM, yaw) {
    const x = lengthM / 2;
    const y = heightM / 2;
    const z = depthM / 2;
    const co = Math.cos(yaw);
    const si = Math.sin(yaw);
    const p = (px, py, pz) => [cx + px * co + pz * si, cy + py, cz - px * si + pz * co];
    quad(material, p(-x, y, -z), p(-x, y, z), p(x, y, z), p(x, y, -z), [0, 1, 0]);
    quad(material, p(-x, -y, -z), p(x, -y, -z), p(x, -y, z), p(-x, -y, z), [0, -1, 0]);
    quad(material, p(x, -y, -z), p(x, y, -z), p(x, y, z), p(x, -y, z), [1, 0, 0]);
    quad(material, p(-x, -y, -z), p(-x, -y, z), p(-x, y, z), p(-x, y, -z), [-1, 0, 0]);
    quad(material, p(-x, -y, z), p(x, -y, z), p(x, y, z), p(-x, y, z), [0, 0, 1]);
    quad(material, p(-x, -y, -z), p(-x, y, -z), p(x, y, -z), p(x, -y, -z), [0, 0, -1]);
  }
  return { groups, triangle, quad, box };
}

function addFloorSlab(geometry, room, y, thickness) {
  const triangles = triangulate(room.polygon, "room '" + room.id + "'");
  for (const tri of triangles) {
    geometry.triangle("floor", [tri[0].x, y, tri[0].z], [tri[1].x, y, tri[1].z], [tri[2].x, y, tri[2].z], [0, 1, 0]);
    geometry.triangle("floor", [tri[0].x, y - thickness, tri[0].z], [tri[1].x, y - thickness, tri[1].z], [tri[2].x, y - thickness, tri[2].z], [0, -1, 0]);
  }
  const outwardSign = polygonArea(room.polygon) >= 0 ? 1 : -1;
  for (let i = 0; i < room.polygon.length; i += 1) {
    const a = room.polygon[i];
    const b = room.polygon[(i + 1) % room.polygon.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    const out = outwardSign > 0 ? [dz / length, 0, -dx / length] : [-dz / length, 0, dx / length];
    geometry.quad("floor", [a.x, y, a.z], [b.x, y, b.z], [b.x, y - thickness, b.z], [a.x, y - thickness, a.z], out);
  }
}

function addWall(geometry, wall, levelElevationM) {
  const ux = wall.dx / wall.lengthM;
  const uz = wall.dz / wall.lengthM;
  const yaw = Math.atan2(-uz, ux);
  const basePoint = (offsetM) => ({
    x: wall.start.x + ux * offsetM,
    z: wall.start.z + uz * offsetM,
  });
  const sortedCuts = [...new Set([
    0,
    wall.lengthM,
    ...wall.openings.flatMap((opening) => [opening.offsetM, opening.offsetM + opening.widthM]),
  ])].sort((a, b) => a - b);
  for (let i = 0; i < sortedCuts.length - 1; i += 1) {
    const start = sortedCuts[i];
    const end = sortedCuts[i + 1];
    if (end - start < 1e-7) continue;
    const midpoint = (start + end) / 2;
    const opening = wall.openings.find((item) =>
      midpoint > item.offsetM - EPSILON && midpoint < item.offsetM + item.widthM + EPSILON);
    const center = basePoint(midpoint);
    const lengthM = end - start;
    const thicknessM = wall.thicknessM;
    const addVertical = (bottomM, topM) => {
      const heightM = topM - bottomM;
      if (heightM <= EPSILON) return;
      geometry.box("wall", center.x, levelElevationM + bottomM + heightM / 2,
        center.z, lengthM, heightM, thicknessM, yaw);
    };
    if (!opening) {
      addVertical(0, wall.wallHeightM);
      continue;
    }
    addVertical(0, opening.sillHeightM);
    addVertical(opening.sillHeightM + opening.heightM, wall.wallHeightM);
    const middle = basePoint(opening.offsetM + opening.widthM / 2);
    if (opening.type === "door") {
      const leafWidth = opening.widthM * 0.9;
      const leafHeight = Math.max(0.2, opening.heightM - 0.04);
      geometry.box("door", middle.x, levelElevationM + opening.sillHeightM + leafHeight / 2,
        middle.z, leafWidth, leafHeight, Math.min(0.06, thicknessM * 0.45), yaw);
      const frameWidth = Math.min(0.065, opening.widthM * 0.1);
      const frameDepth = Math.min(0.09, thicknessM * 0.6);
      geometry.box("frame", middle.x - ux * (opening.widthM / 2 - frameWidth / 2),
        levelElevationM + opening.heightM / 2, middle.z - uz * (opening.widthM / 2 - frameWidth / 2),
        frameWidth, opening.heightM, frameDepth, yaw);
      geometry.box("frame", middle.x + ux * (opening.widthM / 2 - frameWidth / 2),
        levelElevationM + opening.heightM / 2, middle.z + uz * (opening.widthM / 2 - frameWidth / 2),
        frameWidth, opening.heightM, frameDepth, yaw);
      geometry.box("frame", middle.x, levelElevationM + opening.heightM - frameWidth / 2, middle.z,
        opening.widthM, frameWidth, frameDepth, yaw);
    } else {
      const frameWidth = Math.min(0.06, opening.widthM * 0.1, opening.heightM * 0.1);
      const frameDepth = Math.min(0.08, thicknessM * 0.6);
      const glassWidth = Math.max(0.1, opening.widthM - frameWidth * 2);
      const glassHeight = Math.max(0.1, opening.heightM - frameWidth * 2);
      geometry.box("glass", middle.x, levelElevationM + opening.sillHeightM + opening.heightM / 2,
        middle.z, glassWidth, glassHeight, Math.min(0.04, thicknessM * 0.25), yaw);
      geometry.box("frame", middle.x, levelElevationM + opening.sillHeightM + frameWidth / 2,
        middle.z, opening.widthM, frameWidth, frameDepth, yaw);
      geometry.box("frame", middle.x, levelElevationM + opening.sillHeightM + opening.heightM - frameWidth / 2,
        middle.z, opening.widthM, frameWidth, frameDepth, yaw);
      geometry.box("frame", middle.x - ux * (opening.widthM / 2 - frameWidth / 2),
        levelElevationM + opening.sillHeightM + opening.heightM / 2,
        middle.z - uz * (opening.widthM / 2 - frameWidth / 2), frameWidth, opening.heightM, frameDepth, yaw);
      geometry.box("frame", middle.x + ux * (opening.widthM / 2 - frameWidth / 2),
        levelElevationM + opening.sillHeightM + opening.heightM / 2,
        middle.z + uz * (opening.widthM / 2 - frameWidth / 2), frameWidth, opening.heightM, frameDepth, yaw);
    }
  }
}

function rgba(hex) {
  const value = hex.slice(1);
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255).concat(1);
}

function encodeGlb(plan, geometry, summary) {
  const active = MATERIALS.filter((material) => geometry.groups.get(material.key).indices.length);
  const materialIndex = new Map(active.map((material, index) => [material.key, index]));
  const materials = active.map((material) => ({
    name: material.name,
    pbrMetallicRoughness: {
      baseColorFactor: rgba(material.color),
      metallicFactor: material.key === "frame" ? 0.2 : 0,
      roughnessFactor: material.roughness,
    },
    ...(material.key === "glass" ? { alphaMode: "BLEND", doubleSided: true } : {}),
  }));
  const chunks = [];
  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  let byteOffset = 0;
  function view(buffer, target) {
    const padding = (4 - byteOffset % 4) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      byteOffset += padding;
    }
    const entry = { buffer: 0, byteOffset, byteLength: buffer.length };
    if (target) entry.target = target;
    bufferViews.push(entry);
    chunks.push(buffer);
    byteOffset += buffer.length;
    return bufferViews.length - 1;
  }
  function pack(values, type) {
    const size = type === "uint16" ? 2 : 4;
    const buffer = Buffer.alloc(values.length * size);
    values.forEach((value, index) => {
      if (type === "float32") buffer.writeFloatLE(value, index * 4);
      else if (type === "uint16") buffer.writeUInt16LE(value, index * 2);
      else buffer.writeUInt32LE(value, index * 4);
    });
    return buffer;
  }
  function accessor(bufferView, componentType, count, type, extra = {}) {
    accessors.push({ bufferView, byteOffset: 0, componentType, count, type, ...extra });
    return accessors.length - 1;
  }
  for (const material of active) {
    const group = geometry.groups.get(material.key);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < group.positions.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], group.positions[index + axis]);
        max[axis] = Math.max(max[axis], group.positions[index + axis]);
      }
    }
    const positionsView = view(pack(group.positions, "float32"), 34962);
    const normalsView = view(pack(group.normals, "float32"), 34962);
    const isSmall = group.positions.length / 3 <= 65535;
    let minIndex = Infinity;
    let maxIndex = -Infinity;
    for (const index of group.indices) {
      minIndex = Math.min(minIndex, index);
      maxIndex = Math.max(maxIndex, index);
    }
    const indicesView = view(pack(group.indices, isSmall ? "uint16" : "uint32"), 34963);
    const positionAccessor = accessor(positionsView, 5126, group.positions.length / 3, "VEC3", { min, max });
    const normalAccessor = accessor(normalsView, 5126, group.normals.length / 3, "VEC3");
    const indexAccessor = accessor(indicesView, isSmall ? 5123 : 5125, group.indices.length, "SCALAR",
      { min: [minIndex], max: [maxIndex] });
    meshes.push({
      name: plan.id + "-" + material.key,
      primitives: [{
        attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
        indices: indexAccessor,
        material: materialIndex.get(material.key),
        mode: 4,
      }],
    });
    nodes.push({ name: plan.name + " / " + material.name, mesh: meshes.length - 1 });
  }
  const binary = Buffer.concat(chunks);
  const gltf = {
    asset: { version: "2.0", generator: "3D Geospatial Platform / measured-floor-plan-v1" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, index) => index) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.length }],
    extras: {
      floorPlan: {
        schemaVersion: plan.schemaVersion,
        id: plan.id,
        buildingId: plan.buildingId,
        name: plan.name,
        units: "metres",
        coordinateFrame: "local-plan-xz-metres",
        origin: plan.origin,
        level: plan.level,
        sourceEvidence: plan.evidence,
        rooms: plan.rooms.map(({ id, name, areaM2 }) => ({ id, name, areaM2 })),
        summary,
        mapReady: false,
        publicationEligible: false,
      },
    },
  };
  const jsonBytes = Buffer.from(JSON.stringify(gltf));
  const jsonPadding = (4 - jsonBytes.length % 4) % 4;
  const binPadding = (4 - binary.length % 4) % 4;
  const json = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
  const bin = binPadding ? Buffer.concat([binary, Buffer.alloc(binPadding)]) : binary;
  const totalLength = 12 + 8 + json.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, bin]);
}

export function generateFloorPlanGlb(raw) {
  const plan = normalizeFloorPlan(raw);
  const geometry = createGeometry();
  for (const room of plan.rooms) {
    addFloorSlab(geometry, room, plan.level.elevationM, plan.level.floorThicknessM);
  }
  for (const wall of plan.walls) addWall(geometry, wall, plan.level.elevationM);
  const triangleCount = [...geometry.groups.values()].reduce((sum, group) => sum + group.indices.length / 3, 0);
  const summary = {
    roomCount: plan.rooms.length,
    wallCount: plan.walls.length,
    openingCount: plan.walls.reduce((sum, wall) => sum + wall.openings.length, 0),
    floorPolygonAreaSumM2: Math.round(plan.rooms.reduce((sum, room) => sum + room.areaM2, 0) * 1000) / 1000,
    triangleCount,
    materialNames: MATERIALS.filter((material) => geometry.groups.get(material.key).indices.length).map((material) => material.name),
  };
  const glb = encodeGlb(plan, geometry, summary);
  const modelSha256 = createHash("sha256").update(glb).digest("hex");
  return {
    glb,
    plan,
    report: {
      schemaVersion: "1.0.0",
      engine: "measured-floor-plan-to-glb-v1",
      status: "candidate-requires-human-review",
      input: {
        floorPlanId: plan.id,
        buildingId: plan.buildingId,
        sourceEvidence: plan.evidence,
        sourceEvidenceVerified: false,
      },
      output: { format: "glb", byteSize: glb.byteLength, sha256: modelSha256 },
      placement: {
        longitude: plan.origin.longitude,
        latitude: plan.origin.latitude,
        heightM: plan.origin.heightM,
        headingDegrees: plan.origin.headingDegrees,
        coordinateFrame: "local-plan-xz-metres",
      },
      geometry: summary,
      warnings: [
        "This worker extrudes an explicit measured/vector trace; it does not extract walls, rooms, scale or openings automatically from an uploaded PDF or image.",
        "Verify all room polygons, wall centre-lines, openings, dimensions, north/heading and geospatial origin against the original plan or survey.",
        "A source SHA-256 is metadata unless the CLI is run with the original source file and confirms the hash.",
        "Furniture, stairs, ceilings, electrical, plumbing and other MEP systems are not generated by this shell builder.",
      ],
      mapReady: false,
      publicationEligible: false,
    },
  };
}
