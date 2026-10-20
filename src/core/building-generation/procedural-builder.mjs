import { normalizeBuildingGenerationRequest } from "./input-policy.mjs";

const DEFAULT_FLOOR_TO_FLOOR_METERS = 3.2;

const PALETTE = Object.freeze({
  facade: [0.88, 0.85, 0.80, 1],
  trim: [0.97, 0.95, 0.90, 1],
  glass: [0.10, 0.20, 0.28, 1],
  roof: [0.36, 0.40, 0.42, 1],
  door: [0.30, 0.20, 0.14, 1],
});

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHexColour(value, fallback) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return [...fallback];
  return [
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255,
    1,
  ];
}


function signedArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function orient2d(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  return p[0] >= Math.min(a[0], b[0]) - 1e-9 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-9;
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orient2d(a, b, c);
  const o2 = orient2d(a, b, d);
  const o3 = orient2d(c, d, a);
  const o4 = orient2d(c, d, b);
  if ((o1 > 1e-9 && o2 < -1e-9 || o1 < -1e-9 && o2 > 1e-9) &&
      (o3 > 1e-9 && o4 < -1e-9 || o3 < -1e-9 && o4 > 1e-9)) return true;
  if (Math.abs(o1) <= 1e-9 && onSegment(a, b, c)) return true;
  if (Math.abs(o2) <= 1e-9 && onSegment(a, b, d)) return true;
  if (Math.abs(o3) <= 1e-9 && onSegment(c, d, a)) return true;
  if (Math.abs(o4) <= 1e-9 && onSegment(c, d, b)) return true;
  return false;
}

function normalizePolygon(footprint) {
  let points;
  const isRectangularInput = !Array.isArray(footprint.polygonXYMeters);
  if (Array.isArray(footprint.polygonXYMeters)) {
    points = footprint.polygonXYMeters.map(([x, y]) => [x, y]);
  } else if (Number.isFinite(footprint.widthMeters) && Number.isFinite(footprint.depthMeters)) {
    const halfWidth = footprint.widthMeters / 2;
    const halfDepth = footprint.depthMeters / 2;
    points = [
      [-halfWidth, -halfDepth],
      [halfWidth, -halfDepth],
      [halfWidth, halfDepth],
      [-halfWidth, halfDepth],
    ];
  } else {
    throw new TypeError("Parametric GLB generation requires footprint width/depth or polygonXYMeters.");
  }

  if (points.length > 3) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) points.pop();
  }
  if (points.length < 3) throw new RangeError("A footprint needs at least three distinct vertices.");
  const unique = new Set(points.map((point) => point[0] + "," + point[1]));
  if (unique.size !== points.length) throw new RangeError("Footprint repeats a vertex; clean the polygon before generation.");
  if (Math.abs(signedArea(points)) < 0.01) throw new RangeError("Footprint area is too small or degenerate.");

  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const iNext = (i + 1) % points.length;
      const jNext = (j + 1) % points.length;
      if (i === j || iNext === j || jNext === i) continue;
      if (segmentsIntersect(points[i], points[iNext], points[j], points[jNext])) {
        throw new RangeError("Footprint polygon self-intersects; fix the outline before generation.");
      }
    }
  }
  if (signedArea(points) < 0) points.reverse();

  const bounds = points.reduce((acc, point) => ({
    minX: Math.min(acc.minX, point[0]),
    minZ: Math.min(acc.minZ, point[1]),
    maxX: Math.max(acc.maxX, point[0]),
    maxZ: Math.max(acc.maxZ, point[1]),
  }), { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity });
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const centered = points.map(([x, z]) => [x - centerX, z - centerZ]);
  return {
    points: centered,
    widthMeters: bounds.maxX - bounds.minX,
    depthMeters: bounds.maxZ - bounds.minZ,
    areaSquareMeters: Math.abs(signedArea(points)),
    isRectangularInput,
  };
}

function pointInTriangle(p, a, b, c, orientationSign) {
  const ab = orient2d(a, b, p) * orientationSign;
  const bc = orient2d(b, c, p) * orientationSign;
  const ca = orient2d(c, a, p) * orientationSign;
  return ab >= -1e-9 && bc >= -1e-9 && ca >= -1e-9;
}

function triangulatePolygon(points) {
  const orientationSign = signedArea(points) >= 0 ? 1 : -1;
  const remaining = points.map((_, index) => index);
  const triangles = [];
  let guard = points.length * points.length;

  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const prev = remaining[(i + remaining.length - 1) % remaining.length];
      const current = remaining[i];
      const next = remaining[(i + 1) % remaining.length];
      const a = points[prev];
      const b = points[current];
      const c = points[next];
      if (orient2d(a, b, c) * orientationSign <= 1e-9) continue;
      let containsPoint = false;
      for (const other of remaining) {
        if (other === prev || other === current || other === next) continue;
        if (pointInTriangle(points[other], a, b, c, orientationSign)) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;
      triangles.push([prev, current, next]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new RangeError("Could not triangulate footprint; check for self-intersections or collinear vertices.");
  }
  if (remaining.length === 3) triangles.push([...remaining]);
  return triangles;
}

function makeMaterial(name, baseColorFactor, metallicFactor = 0, roughnessFactor = 0.82) {
  return {
    name,
    pbrMetallicRoughness: { baseColorFactor, metallicFactor, roughnessFactor },
    doubleSided: true,
  };
}

function align4(buffer) {
  const padding = (4 - (buffer.length % 4)) % 4;
  if (!padding) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(padding)]);
}

function alignJson4(buffer) {
  const padding = (4 - (buffer.length % 4)) % 4;
  if (!padding) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(padding, 0x20)]);
}

/**
 * Generate a deterministic LOD/prototype building shell. This is deliberately
 * a dimension-controlled fallback, not a photo reconstruction or a structural BIM.
 */
export function generateParametricBuildingGlb(requestValue) {
  requestValue = normalizeBuildingGenerationRequest(requestValue);
  if (!isRecord(requestValue) || !isRecord(requestValue.building)) {
    throw new TypeError("A normalized building generation request is required.");
  }
  const building = requestValue.building;
  const dimensions = isRecord(building.dimensions) ? building.dimensions : {};
  if (!building.footprint) throw new TypeError("A footprint is required for procedural geometry.");
  const footprint = normalizePolygon(building.footprint);
  const suppliedHeight = dimensions.totalHeightMeters;
  const suppliedFloors = dimensions.aboveGroundFloors;
  const suppliedFloorHeight = dimensions.floorToFloorHeightMeters;
  if (suppliedHeight === undefined && (suppliedFloors === undefined || suppliedFloorHeight === undefined)) {
    throw new TypeError("Supply totalHeightMeters or aboveGroundFloors plus floorToFloorHeightMeters.");
  }
  const totalHeight = suppliedHeight ?? suppliedFloors * suppliedFloorHeight;
  if (!Number.isFinite(totalHeight) || totalHeight < 2 || totalHeight > 1000) {
    throw new RangeError("Derived total height is outside the supported range.");
  }
  const warnings = [];
  const floorCount = suppliedFloors ?? Math.max(1, Math.min(200, Math.round(totalHeight / DEFAULT_FLOOR_TO_FLOOR_METERS)));
  if (suppliedFloors === undefined) {
    warnings.push("Floor count is estimated from total height using a 3.2 m default floor-to-floor height.");
  }
  if (suppliedHeight !== undefined && suppliedFloors !== undefined && suppliedFloorHeight !== undefined) {
    const difference = Math.abs(suppliedHeight - suppliedFloors * suppliedFloorHeight);
    if (difference > Math.max(1, suppliedHeight * 0.1)) {
      warnings.push("Total height differs from floor count × floor-to-floor height; totalHeightMeters is treated as authoritative and floor spacing is redistributed.");
    }
  }

  const colors = Array.isArray(building.facadeColours) ? building.facadeColours : [];
  const facadeColor = readHexColour(colors.find((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)), PALETTE.facade);
  const trimColor = readHexColour(colors.find((color, index) => index > 0 && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)), PALETTE.trim);
  const materials = [
    makeMaterial("Facade plaster", facadeColor),
    makeMaterial("Floor bands and window frames", trimColor),
    makeMaterial("Window glass", PALETTE.glass, 0.05, 0.3),
    makeMaterial("Roof", PALETTE.roof),
    makeMaterial("Entrance door", PALETTE.door),
    makeMaterial("Balcony concrete", [0.72, 0.70, 0.66, 1]),
    makeMaterial("Balcony railing metal", [0.22, 0.25, 0.27, 1], 0.45, 0.55),
    makeMaterial("Facade columns", facadeColor),
  ];
  const meshes = materials.map(() => ({ positions: [], normals: [], indices: [] }));

  function addTriangle(materialIndex, a, b, c, normalHint = null) {
    let p1 = b;
    let p2 = c;
    const u = [p1[0] - a[0], p1[1] - a[1], p1[2] - a[2]];
    const v = [p2[0] - a[0], p2[1] - a[1], p2[2] - a[2]];
    let normal = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    if (length < 1e-9) return;
    normal = normal.map((component) => component / length);
    if (normalHint && normal[0] * normalHint[0] + normal[1] * normalHint[1] + normal[2] * normalHint[2] < 0) {
      p1 = c;
      p2 = b;
      const newU = [p1[0] - a[0], p1[1] - a[1], p1[2] - a[2]];
      const newV = [p2[0] - a[0], p2[1] - a[1], p2[2] - a[2]];
      normal = [
        newU[1] * newV[2] - newU[2] * newV[1],
        newU[2] * newV[0] - newU[0] * newV[2],
        newU[0] * newV[1] - newU[1] * newV[0],
      ];
      const swappedLength = Math.hypot(normal[0], normal[1], normal[2]);
      normal = normal.map((component) => component / swappedLength);
    }
    const mesh = meshes[materialIndex];
    const base = mesh.positions.length / 3;
    for (const point of [a, p1, p2]) {
      mesh.positions.push(point[0], point[1], point[2]);
      mesh.normals.push(normal[0], normal[1], normal[2]);
    }
    mesh.indices.push(base, base + 1, base + 2);
  }
  function addQuad(materialIndex, a, b, c, d, normalHint = null) {
    addTriangle(materialIndex, a, b, c, normalHint);
    addTriangle(materialIndex, a, c, d, normalHint);
  }
  function to3(point, y, offsetX = 0, offsetZ = 0) {
    return [point[0] + offsetX, y, point[1] + offsetZ];
  }

  function addOrientedBox(centerX, centerZ, tangentX, tangentZ, normalX, normalZ, width, depth, bottomY, topY, materialIndex) {
    const halfWidth = width / 2;
    const halfDepth = depth / 2;
    const point = (along, outward, y) => [
      centerX + tangentX * along + normalX * outward,
      y,
      centerZ + tangentZ * along + normalZ * outward,
    ];
    const bl = point(-halfWidth, -halfDepth, bottomY);
    const br = point(halfWidth, -halfDepth, bottomY);
    const fr = point(halfWidth, halfDepth, bottomY);
    const fl = point(-halfWidth, halfDepth, bottomY);
    const BL = point(-halfWidth, -halfDepth, topY);
    const BR = point(halfWidth, -halfDepth, topY);
    const FR = point(halfWidth, halfDepth, topY);
    const FL = point(-halfWidth, halfDepth, topY);
    addQuad(materialIndex, BL, BR, FR, FL, [0, 1, 0]);
    addQuad(materialIndex, bl, fl, fr, br, [0, -1, 0]);
    addQuad(materialIndex, bl, br, BR, BL, [-normalX, 0, -normalZ]);
    addQuad(materialIndex, fr, fl, FL, FR, [normalX, 0, normalZ]);
    addQuad(materialIndex, fl, bl, BL, FL, [-tangentX, 0, -tangentZ]);
    addQuad(materialIndex, br, fr, FR, BR, [tangentX, 0, tangentZ]);
  }

  const points = footprint.points;
  const roofDescription = typeof building.roofType === "string" ? building.roofType.toLowerCase() : "flat";
  let roofMode = /\bhip\b/.test(roofDescription) ? "hip" : /\bgable\b|\bpitched\b/.test(roofDescription) ? "gable" : "flat";
  if (roofMode !== "flat" && !footprint.isRectangularInput) {
    warnings.push("Gable/hip roofs currently require a measured rectangular width/depth footprint; a flat roof was generated for this polygon footprint.");
    roofMode = "flat";
  }
  const roofRise = roofMode === "flat" ? 0 : Math.min(2.5, Math.max(0.5, totalHeight * 0.15));
  const parapetHeight = roofMode === "flat" && /parapet/i.test(roofDescription)
    ? Math.min(1.2, totalHeight * 0.08)
    : 0;
  const mainHeight = totalHeight - parapetHeight - roofRise;
  const floorHeight = mainHeight / floorCount;
  const architecturalFeatures = building.architecturalFeatures ?? {};
  const windowStyle = architecturalFeatures.windowStyle ?? "rectangular";
  const entranceStyle = architecturalFeatures.entranceStyle ?? "single-door";

  // Outer shell walls and repeated horizontal floor bands.
  for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex += 1) {
    const a = points[edgeIndex];
    const b = points[(edgeIndex + 1) % points.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.05) throw new RangeError("Footprint has a near-zero-length edge.");
    const tangentX = dx / length;
    const tangentZ = dz / length;
    const outwardX = dz / length;
    const outwardZ = -dx / length;
    const normal = [outwardX, 0, outwardZ];

    addQuad(0, to3(a, 0), to3(b, 0), to3(b, mainHeight), to3(a, mainHeight), normal);
    if (parapetHeight > 0) {
      addQuad(0, to3(a, mainHeight), to3(b, mainHeight), to3(b, totalHeight), to3(a, totalHeight), normal);
    }

    // Visual bands indicate storey rhythm. The base wall remains a continuous shell in this first geometry tier.
    for (let floor = 1; floor < floorCount; floor += 1) {
      const y = floor * floorHeight;
      const band = 0.09;
      const offset = 0.025;
      const p0 = [a[0] + outwardX * offset, y - band / 2, a[1] + outwardZ * offset];
      const p1 = [b[0] + outwardX * offset, y - band / 2, b[1] + outwardZ * offset];
      const p2 = [b[0] + outwardX * offset, y + band / 2, b[1] + outwardZ * offset];
      const p3 = [a[0] + outwardX * offset, y + band / 2, a[1] + outwardZ * offset];
      addQuad(1, p0, p1, p2, p3, normal);
    }

    // Surface windows with trim; the wall remains continuous behind them in this prototype tier.
    if (length >= 2.2 && floorHeight >= 2.5) {
      const bays = Math.max(1, Math.min(30, Math.floor((length - 0.6) / 2.6)));
      const windowWidth = Math.min(1.2, (length - 0.35) / bays * 0.52);
      const windowHeight = Math.min(1.45, floorHeight * 0.55);
      for (let floor = 0; floor < floorCount; floor += 1) {
        const sill = floor * floorHeight + floorHeight * 0.24;
        const bottom = Math.min(sill, floor * floorHeight + floorHeight - windowHeight - 0.22);
        const top = Math.min(bottom + windowHeight, (floor + 1) * floorHeight - 0.18);
        if (top - bottom < 0.5) continue;
        for (let bay = 0; bay < bays; bay += 1) {
          const t = (bay + 1) / (bays + 1);
          const cx = a[0] + dx * t;
          const cz = a[1] + dz * t;
          const halfWidth = windowWidth / 2;
          const halfHeight = (top - bottom) / 2;
          const centerY = (top + bottom) / 2;
          const offset = 0.045;
          const centerX = cx + outwardX * offset;
          const centerZ = cz + outwardZ * offset;
          const lowerLeft = [centerX - tangentX * halfWidth, centerY - halfHeight, centerZ - tangentZ * halfWidth];
          const lowerRight = [centerX + tangentX * halfWidth, centerY - halfHeight, centerZ + tangentZ * halfWidth];
          const upperRight = [centerX + tangentX * halfWidth, centerY + halfHeight, centerZ + tangentZ * halfWidth];
          const upperLeft = [centerX - tangentX * halfWidth, centerY + halfHeight, centerZ - tangentZ * halfWidth];
          addQuad(2, lowerLeft, lowerRight, upperRight, upperLeft, normal);
          const frame = 0.065;
          // Top and bottom trim.
          addQuad(1,
            [lowerLeft[0], bottom, lowerLeft[2]],
            [lowerRight[0], bottom, lowerRight[2]],
            [lowerRight[0], bottom + frame, lowerRight[2]],
            [lowerLeft[0], bottom + frame, lowerLeft[2]], normal);
          addQuad(1,
            [upperLeft[0], top - frame, upperLeft[2]],
            [upperRight[0], top - frame, upperRight[2]],
            [upperRight[0], top, upperRight[2]],
            [upperLeft[0], top, upperLeft[2]], normal);
          // Side trim.
          const sideBottomLeft = [centerX - tangentX * halfWidth, bottom, centerZ - tangentZ * halfWidth];
          const sideBottomRight = [centerX + tangentX * halfWidth, bottom, centerZ + tangentZ * halfWidth];
          const sideTopLeft = [centerX - tangentX * halfWidth, top, centerZ - tangentZ * halfWidth];
          const sideTopRight = [centerX + tangentX * halfWidth, top, centerZ + tangentZ * halfWidth];
          addQuad(1, sideBottomLeft, lowerLeft, upperLeft, sideTopLeft, normal);
          addQuad(1, lowerRight, sideBottomRight, sideTopRight, upperRight, normal);
        }
      }
    }
  }

  // Choose the facade edge whose outward normal most closely matches the requested azimuth.
  const frontAzimuth = (building.frontAzimuthDegrees ?? 180) * Math.PI / 180;
  const targetX = Math.sin(frontAzimuth);
  const targetZ = Math.cos(frontAzimuth);
  let frontEdge = null;
  let frontScore = -Infinity;
  for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex += 1) {
    const a = points[edgeIndex];
    const b = points[(edgeIndex + 1) % points.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    const nx = dz / length;
    const nz = -dx / length;
    const score = nx * targetX + nz * targetZ;
    if (score > frontScore) {
      frontScore = score;
      frontEdge = { a, b, length, dx, dz, nx, nz, tx: dx / length, tz: dz / length };
    }
  }
  if (frontEdge && frontEdge.length >= 2.4 && mainHeight >= 2.3) {
    const doorWidth = Math.min(1.15, frontEdge.length * 0.25);
    const doorHeight = Math.min(2.15, floorHeight * 0.9, mainHeight * 0.75);
    const t = 0.5;
    const cx = frontEdge.a[0] + frontEdge.dx * t + frontEdge.nx * 0.07;
    const cz = frontEdge.a[1] + frontEdge.dz * t + frontEdge.nz * 0.07;
    const half = doorWidth / 2;
    const bl = [cx - frontEdge.tx * half, 0.04, cz - frontEdge.tz * half];
    const br = [cx + frontEdge.tx * half, 0.04, cz + frontEdge.tz * half];
    const tr = [br[0], doorHeight, br[2]];
    const tl = [bl[0], doorHeight, bl[2]];
    const normal = [frontEdge.nx, 0, frontEdge.nz];
    addQuad(4, bl, br, tr, tl, normal);
    const frame = 0.08;
    const leftInner = [bl[0] + frontEdge.tx * frame + frontEdge.nx * 0.01, 0.04, bl[2] + frontEdge.tz * frame + frontEdge.nz * 0.01];
    const rightInner = [br[0] - frontEdge.tx * frame + frontEdge.nx * 0.01, 0.04, br[2] - frontEdge.tz * frame + frontEdge.nz * 0.01];
    const leftTop = [leftInner[0], doorHeight, leftInner[2]];
    const rightTop = [rightInner[0], doorHeight, rightInner[2]];
    addQuad(1, bl, leftInner, leftTop, tl, normal);
    addQuad(1, rightInner, br, tr, rightTop, normal);
  }

  // Triangulated flat roof surface.
  for (const triangle of triangulatePolygon(points)) {
    let [a, b, c] = triangle.map((index) => points[index]);
    const normalHint = [0, 1, 0];
    const p0 = to3(a, totalHeight);
    const p1 = to3(b, totalHeight);
    const p2 = to3(c, totalHeight);
    addTriangle(3, p0, p1, p2, normalHint);
  }

  const binChunks = [];
  const bufferViews = [];
  const accessors = [];
  const primitives = [];
  let byteOffset = 0;

  function appendTypedArray(typedArray, target, componentType, type, count, min, max) {
    const data = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const alignedData = align4(data);
    const viewIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: alignedData.length,
      ...(target === undefined ? {} : { target }),
    });
    binChunks.push(alignedData);
    byteOffset += alignedData.length;
    const accessorIndex = accessors.length;
    accessors.push({
      bufferView: viewIndex,
      byteOffset: 0,
      componentType,
      count,
      type,
      ...(min ? { min } : {}),
      ...(max ? { max } : {}),
    });
    return accessorIndex;
  }

  for (let materialIndex = 0; materialIndex < meshes.length; materialIndex += 1) {
    const mesh = meshes[materialIndex];
    if (mesh.indices.length === 0) continue;
    const positionMin = [Infinity, Infinity, Infinity];
    const positionMax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        positionMin[axis] = Math.min(positionMin[axis], mesh.positions[i + axis]);
        positionMax[axis] = Math.max(positionMax[axis], mesh.positions[i + axis]);
      }
    }
    const position = appendTypedArray(new Float32Array(mesh.positions), 34962, 5126, "VEC3", mesh.positions.length / 3, positionMin, positionMax);
    const normal = appendTypedArray(new Float32Array(mesh.normals), 34962, 5126, "VEC3", mesh.normals.length / 3);
    const indices = appendTypedArray(new Uint32Array(mesh.indices), 34963, 5125, "SCALAR", mesh.indices.length);
    primitives.push({
      attributes: { POSITION: position, NORMAL: normal },
      indices,
      material: materialIndex,
      mode: 4,
    });
  }

  const binary = Buffer.concat(binChunks);
  const gltf = {
    asset: { version: "2.0", generator: "3D Geospatial Platform · Parametric Building Engine" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: (building.name ?? building.buildingType) + " · procedural base", mesh: 0 }],
    meshes: [{ name: "Parametric Building", primitives }],
    materials,
    buffers: [{ byteLength: binary.length }],
    bufferViews,
    accessors,
    extras: {
      buildingType: building.buildingType,
      qualityTier: "parametric-base",
      units: "metres",
      floors: floorCount,
      totalHeightMeters: totalHeight,
      footprintWidthMeters: footprint.widthMeters,
      footprintDepthMeters: footprint.depthMeters,
      footprintAreaSquareMeters: footprint.areaSquareMeters,
      generationNotes: warnings,
      disclaimer: "Procedural visual shell only; facade panels do not create interior openings and this is not construction-ready BIM.",
    },
  };

  const jsonChunk = alignJson4(Buffer.from(JSON.stringify(gltf), "utf8"));
  const binChunk = align4(binary);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = Buffer.alloc(totalLength);
  glb.write("glTF", 0, 4, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  glb.writeUInt32LE(jsonChunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(glb, 20);
  const binHeaderOffset = 20 + jsonChunk.length;
  glb.writeUInt32LE(binChunk.length, binHeaderOffset);
  glb.writeUInt32LE(0x004e4942, binHeaderOffset + 4);
  binChunk.copy(glb, binHeaderOffset + 8);

  return {
    glb,
    metadata: {
      name: building.name ?? building.buildingType,
      buildingType: building.buildingType,
      floorCount,
      totalHeightMeters: totalHeight,
      footprintWidthMeters: footprint.widthMeters,
      footprintDepthMeters: footprint.depthMeters,
      footprintAreaSquareMeters: footprint.areaSquareMeters,
      materialCount: materials.length,
      primitiveCount: primitives.length,
      warnings,
    },
  };
}

export const PROCEDURAL_BUILDING_DEFAULTS = Object.freeze({
  floorToFloorHeightMeters: DEFAULT_FLOOR_TO_FLOOR_METERS,
  facadeColour: "#e0d9cc",
  roofType: "flat",
  windowMaterial: "dark blue glass",
});
