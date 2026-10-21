import { createHash } from "node:crypto";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function triangleKey(ids) {
  if (!Array.isArray(ids) || ids.length !== 3 ||
      ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== 3) {
    throw new TypeError("triangle and texture-face vertices must contain three distinct string IDs");
  }
  return [...ids].sort().join("\u0000");
}

function align4(value) {
  return (value + 3) & ~3;
}

function encodeFloat32(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function calculateNormal(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const length = Math.hypot(...cross);
  if (!finite(length) || length <= 1e-12) throw new TypeError("textured mesh contains a degenerate triangle");
  return cross.map((value) => value / length);
}

/**
 * Build a self-contained glTF 2.0 binary from an already-reviewed triangle mesh,
 * already-remapped per-corner UVs, and an actual PNG atlas byte buffer.
 * It deliberately does not infer geometry, project photographs, or generate UVs.
 */
export function buildTexturedGlb({ mesh, faces, atlasBytes, atlasWidth, atlasHeight, atlasSha256 }) {
  if (!mesh || !Array.isArray(mesh.vertices) || !Array.isArray(mesh.triangles)) {
    throw new TypeError("mesh must contain vertices and triangles");
  }
  if (!Array.isArray(faces) || faces.length === 0) {
    throw new TypeError("at least one reviewed/remapped texture face is required");
  }
  if (!Buffer.isBuffer(atlasBytes) || atlasBytes.length < 24) {
    throw new TypeError("atlasBytes must be a non-empty PNG buffer");
  }
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!atlasBytes.subarray(0, 8).equals(pngSignature) ||
      atlasBytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new TypeError("texture atlas must be a PNG with an IHDR chunk");
  }
  const actualWidth = atlasBytes.readUInt32BE(16);
  const actualHeight = atlasBytes.readUInt32BE(20);
  if (!Number.isSafeInteger(atlasWidth) || !Number.isSafeInteger(atlasHeight) ||
      atlasWidth < 1 || atlasHeight < 1 || actualWidth !== atlasWidth || actualHeight !== atlasHeight) {
    throw new TypeError("texture atlas byte dimensions do not match the supplied manifest dimensions");
  }
  const actualAtlasSha256 = sha256(atlasBytes);
  if (typeof atlasSha256 !== "string" || actualAtlasSha256 !== atlasSha256.toLowerCase()) {
    throw new TypeError("texture atlas SHA-256 does not match the verified atlas digest");
  }

  const verticesById = new Map();
  for (const vertex of mesh.vertices) {
    if (!vertex || typeof vertex.id !== "string" || verticesById.has(vertex.id) ||
        !Array.isArray(vertex.position) || vertex.position.length !== 3 ||
        vertex.position.some((value) => !finite(value))) {
      throw new TypeError("mesh vertices need unique IDs and finite 3D positions");
    }
    verticesById.set(vertex.id, vertex.position);
  }

  const facesByKey = new Map();
  for (const face of faces) {
    const key = triangleKey(face?.vertices);
    if (facesByKey.has(key)) throw new TypeError("duplicate texture face maps to the same triangle");
    if (!Array.isArray(face.uv) || face.uv.length !== 3 ||
        face.uv.some((uv) => !Array.isArray(uv) || uv.length !== 2 ||
          uv.some((value) => !finite(value) || value < -1e-5 || value > 1.00001))) {
      throw new TypeError("texture faces need three normalized finite UV pairs");
    }
    facesByKey.set(key, face);
  }

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const exportedFaceKeys = new Set();
  const omittedTriangleKeys = [];
  for (const triangle of mesh.triangles) {
    const ids = triangleKey(triangle?.vertices);
    const face = facesByKey.get(ids);
    if (!face) {
      omittedTriangleKeys.push(ids.split("\u0000"));
      continue;
    }
    const points = triangle.vertices.map((id) => verticesById.get(id));
    if (points.some((point) => !point)) throw new TypeError("mesh triangle references a missing vertex");
    const uvByVertex = new Map(face.vertices.map((id, index) => [id, face.uv[index]]));
    if (triangle.vertices.some((id) => !uvByVertex.has(id))) {
      throw new TypeError("texture face vertex mapping is incomplete for a mesh triangle");
    }
    const normal = calculateNormal(points[0], points[1], points[2]);
    for (let corner = 0; corner < 3; corner += 1) {
      positions.push(...points[corner]);
      normals.push(...normal);
      uvs.push(...uvByVertex.get(triangle.vertices[corner]));
      indices.push(indices.length);
    }
    exportedFaceKeys.add(ids);
  }
  if (indices.length === 0) throw new TypeError("no accepted mesh triangle has matching verified texture/UV evidence");
  if (indices.length > 0xffffffff) throw new RangeError("textured GLB exceeds the supported 32-bit index range");

  const vertexCount = positions.length / 3;
  const indexBytes = vertexCount <= 65536 ? 2 : 4;
  const encodedIndices = Buffer.alloc(indices.length * indexBytes);
  indices.forEach((index, offset) => {
    if (indexBytes === 2) encodedIndices.writeUInt16LE(index, offset * indexBytes);
    else encodedIndices.writeUInt32LE(index, offset * indexBytes);
  });

  const parts = [];
  const bufferViews = [];
  let binaryLength = 0;
  function appendView(bytes, target) {
    const padding = (4 - (binaryLength % 4)) % 4;
    if (padding) {
      parts.push(Buffer.alloc(padding));
      binaryLength += padding;
    }
    const view = { buffer: 0, byteOffset: binaryLength, byteLength: bytes.length };
    if (target !== undefined) view.target = target;
    const index = bufferViews.push(view) - 1;
    parts.push(bytes);
    binaryLength += bytes.length;
    return index;
  }

  const positionView = appendView(encodeFloat32(positions), 34962);
  const normalView = appendView(encodeFloat32(normals), 34962);
  const uvView = appendView(encodeFloat32(uvs), 34962);
  const indexView = appendView(encodedIndices, 34963);
  const imageView = appendView(atlasBytes);

  const minPosition = [Infinity, Infinity, Infinity];
  const maxPosition = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      minPosition[axis] = Math.min(minPosition[axis], positions[offset + axis]);
      maxPosition[axis] = Math.max(maxPosition[axis], positions[offset + axis]);
    }
  }
  const gltf = {
    asset: { version: "2.0", generator: "3d-geospatial-platform-textured-glb-export-v1" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Reviewed textured building candidate" }],
    meshes: [{
      name: "Reviewed textured mesh",
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
        indices: 3,
        material: 0,
        mode: 4,
      }],
    }],
    materials: [{
      name: "Verified atlas material",
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: { index: 0, texCoord: 0 },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      doubleSided: true,
    }],
    textures: [{ sampler: 0, source: 0 }],
    images: [{ bufferView: imageView, mimeType: "image/png", name: "verified-building-atlas" }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    buffers: [{ byteLength: binaryLength }],
    bufferViews,
    accessors: [
      { bufferView: positionView, componentType: 5126, count: vertexCount, type: "VEC3", min: minPosition, max: maxPosition },
      { bufferView: normalView, componentType: 5126, count: vertexCount, type: "VEC3" },
      { bufferView: uvView, componentType: 5126, count: vertexCount, type: "VEC2", min: [0, 0], max: [1, 1] },
      { bufferView: indexView, componentType: indexBytes === 2 ? 5123 : 5125, count: indices.length, type: "SCALAR", min: [0], max: [vertexCount - 1] },
    ],
    extras: {
      atlasSha256: actualAtlasSha256,
      atlasDimensions: { width: atlasWidth, height: atlasHeight },
      publicationEligible: false,
    },
  };

  const jsonBytes = Buffer.from(JSON.stringify(gltf), "utf8");
  const paddedJson = Buffer.concat([jsonBytes, Buffer.from(" ".repeat((4 - jsonBytes.length % 4) % 4))]);
  const binary = Buffer.concat([...parts, Buffer.alloc((4 - binaryLength % 4) % 4)]);
  const totalLength = 12 + 8 + paddedJson.length + 8 + binary.length;
  if (totalLength > 0xffffffff) throw new RangeError("GLB exceeds the glTF 2.0 32-bit container limit");
  const glb = Buffer.alloc(totalLength);
  glb.writeUInt32LE(GLB_MAGIC, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(totalLength, 8);
  glb.writeUInt32LE(paddedJson.length, 12);
  glb.writeUInt32LE(JSON_CHUNK, 16);
  paddedJson.copy(glb, 20);
  const binHeader = 20 + paddedJson.length;
  glb.writeUInt32LE(binary.length, binHeader);
  glb.writeUInt32LE(BIN_CHUNK, binHeader + 4);
  binary.copy(glb, binHeader + 8);

  return {
    buffer: glb,
    report: {
      schemaVersion: "1.0.0",
      status: omittedTriangleKeys.length ? "partial-textured-mesh" : "textured-mesh-exported",
      glbSha256: sha256(glb),
      atlasSha256: actualAtlasSha256,
      atlasDimensions: { width: atlasWidth, height: atlasHeight },
      meshTriangleCount: mesh.triangles.length,
      texturedTriangleCount: exportedFaceKeys.size,
      untexturedTriangleCount: omittedTriangleKeys.length,
      omittedTriangleKeys,
      exportedVertexCount: vertexCount,
      trianglePrimitiveCount: indices.length / 3,
      embeddedImageCount: 1,
      externalUrisUsed: false,
      publicationEligible: false,
    },
  };
}
