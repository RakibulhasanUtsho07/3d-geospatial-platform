const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function pad4(buffer, fill = 0) {
  const extra = (4 - (buffer.length % 4)) % 4;
  return extra ? Buffer.concat([buffer, Buffer.alloc(extra, fill)]) : buffer;
}

function encodeGlb(gltf, binary) {
  gltf.buffers[0].byteLength = binary.length;
  const json = pad4(Buffer.from(JSON.stringify(gltf), "utf8"), 0x20);
  const paddedBinary = pad4(binary);
  const totalLength = 12 + 8 + json.length + 8 + paddedBinary.length;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(JSON_CHUNK, 16);
  json.copy(output, 20);
  const binaryHeader = 20 + json.length;
  output.writeUInt32LE(paddedBinary.length, binaryHeader);
  output.writeUInt32LE(BIN_CHUNK, binaryHeader + 4);
  paddedBinary.copy(output, binaryHeader + 8);
  return output;
}

export function buildControlledBuildingGlb(dimensions = { x: 10, y: 8, z: 6 }) {
  for (const axis of ["x", "y", "z"]) {
    if (typeof dimensions[axis] !== "number" || !Number.isFinite(dimensions[axis]) || dimensions[axis] <= 0) {
      throw new TypeError("baseline dimension " + axis + " must be positive and finite");
    }
  }
  const { x, y, z } = dimensions;
  const positions = [
    0,0,0,   x,0,0,   x,y,0,   0,y,0,
    0,0,z,   x,0,z,   x,y,z,   0,y,z,
  ];
  // Twelve triangles forming a closed six-face cuboid.
  const indices = [
    0,2,1, 0,3,2,
    4,5,6, 4,6,7,
    0,1,5, 0,5,4,
    1,2,6, 1,6,5,
    2,3,7, 2,7,6,
    3,0,4, 3,4,7,
  ];
  const positionBytes = Buffer.alloc(positions.length * 4);
  positions.forEach((value, index) => positionBytes.writeFloatLE(value, index * 4));
  const indexBytes = Buffer.alloc(indices.length * 2);
  indices.forEach((value, index) => indexBytes.writeUInt16LE(value, index * 2));
  const binary = Buffer.concat([positionBytes, indexBytes]);
  const gltf = {
    asset: { version: "2.0", generator: "BRF-04 controlled synthetic fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ name: "ControlledCuboid", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] }],
    materials: [{ name: "NeutralSyntheticMaterial", pbrMetallicRoughness: { baseColorFactor: [0.7,0.7,0.7,1], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 8, type: "VEC3", min: [0,0,0], max: [x,y,z] },
      { bufferView: 1, byteOffset: 0, componentType: 5123, count: indices.length, type: "SCALAR", min: [0], max: [7] },
    ],
  };
  return encodeGlb(gltf, binary);
}

function splitGlb(glb) {
  if (!Buffer.isBuffer(glb) || glb.length < 28 || glb.readUInt32LE(0) !== GLB_MAGIC || glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length) {
    throw new TypeError("input must be a valid GLB 2.0 buffer");
  }
  const jsonLength = glb.readUInt32LE(12);
  if (glb.readUInt32LE(16) !== JSON_CHUNK) throw new TypeError("GLB JSON chunk is missing");
  const jsonStart = 20;
  const binaryHeader = jsonStart + jsonLength;
  if (binaryHeader + 8 > glb.length || glb.readUInt32LE(binaryHeader + 4) !== BIN_CHUNK) throw new TypeError("GLB binary chunk is missing");
  const binaryLength = glb.readUInt32LE(binaryHeader);
  const binaryStart = binaryHeader + 8;
  if (binaryStart + binaryLength !== glb.length) throw new TypeError("GLB binary length is inconsistent");
  return {
    gltf: JSON.parse(glb.subarray(jsonStart, binaryHeader).toString("utf8").trim()),
    binary: Buffer.from(glb.subarray(binaryStart, binaryStart + binaryLength)),
  };
}

export function injectDimensionScaleDefect(glb, { axis = "y", factor = 1.2 } = {}) {
  const axisIndex = { x: 0, y: 1, z: 2 }[axis];
  if (axisIndex === undefined) throw new TypeError("axis must be x, y or z");
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0 || factor > 10) {
    throw new RangeError("scale factor must be finite and greater than zero, up to 10");
  }
  const { gltf, binary } = splitGlb(glb);
  const primitive = gltf.meshes?.[0]?.primitives?.[0];
  const positionAccessor = gltf.accessors?.[primitive?.attributes?.POSITION];
  const view = gltf.bufferViews?.[positionAccessor?.bufferView];
  if (!positionAccessor || !view || positionAccessor.componentType !== 5126 || positionAccessor.type !== "VEC3") {
    throw new TypeError("fixture needs an embedded float32 VEC3 POSITION accessor");
  }
  const stride = view.byteStride ?? 12;
  const first = (view.byteOffset ?? 0) + (positionAccessor.byteOffset ?? 0);
  for (let vertex = 0; vertex < positionAccessor.count; vertex += 1) {
    const offset = first + vertex * stride + axisIndex * 4;
    binary.writeFloatLE(binary.readFloatLE(offset) * factor, offset);
  }
  if (Array.isArray(positionAccessor.min)) positionAccessor.min[axisIndex] *= factor;
  if (Array.isArray(positionAccessor.max)) positionAccessor.max[axisIndex] *= factor;
  return encodeGlb(gltf, binary);
}

export function injectDegenerateTriangleDefect(glb, { triangleIndex = 0 } = {}) {
  if (!Number.isSafeInteger(triangleIndex) || triangleIndex < 0) throw new RangeError("triangleIndex must be a non-negative integer");
  const { gltf, binary } = splitGlb(glb);
  const primitive = gltf.meshes?.[0]?.primitives?.[0];
  const indexAccessor = gltf.accessors?.[primitive?.indices];
  const view = gltf.bufferViews?.[indexAccessor?.bufferView];
  if (!indexAccessor || !view || indexAccessor.componentType !== 5123 || indexAccessor.type !== "SCALAR") {
    throw new TypeError("fixture needs an embedded uint16 SCALAR index accessor");
  }
  const triangleOffset = triangleIndex * 3;
  if (triangleOffset + 2 >= indexAccessor.count) throw new RangeError("triangleIndex is outside the index accessor");
  const first = (view.byteOffset ?? 0) + (indexAccessor.byteOffset ?? 0) + triangleOffset * 2;
  binary.writeUInt16LE(binary.readUInt16LE(first), first + 2);
  return encodeGlb(gltf, binary);
}
