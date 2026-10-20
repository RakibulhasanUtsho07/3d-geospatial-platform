const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const DEFAULT_ALLOWED_HOSTS = Object.freeze(["cdn.tripo3d.ai"]);
const COMPONENT_BYTES = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const TYPE_COMPONENTS = new Map([["SCALAR", 1], ["VEC2", 2], ["VEC3", 3], ["VEC4", 4], ["MAT2", 4], ["MAT3", 9], ["MAT4", 16]]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(name + " is outside the supported range.");
  }
  return value;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("GLB data must be a Buffer or Uint8Array.");
}

function componentCountForType(type) {
  const result = TYPE_COMPONENTS.get(type);
  if (!result) throw new TypeError("Unsupported glTF accessor type: " + String(type));
  return result;
}

function parseGlb(buffer, { maxBytes, maxJsonChunkBytes }) {
  if (buffer.length > maxBytes) throw new RangeError("GLB exceeds the configured size limit.");
  if (buffer.length < 20) throw new TypeError("GLB is too short to contain a header and JSON chunk.");
  if (buffer.toString("ascii", 0, 4) !== "glTF") throw new TypeError("GLB magic is invalid.");
  if (buffer.readUInt32LE(4) !== 2) throw new TypeError("Only binary glTF version 2 is supported.");
  if (buffer.readUInt32LE(8) !== buffer.length) throw new TypeError("GLB declared total length does not match the downloaded bytes.");

  let offset = 12;
  let chunkIndex = 0;
  let jsonBuffer = null;
  let binaryBuffer = null;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new TypeError("GLB chunk header is truncated.");
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    if (chunkLength % 4 !== 0) throw new TypeError("GLB chunk length must be four-byte aligned.");
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > buffer.length || end < start) throw new TypeError("GLB chunk extends beyond the file.");
    if (chunkIndex === 0 && chunkType !== GLB_JSON_CHUNK) throw new TypeError("The first GLB chunk must be JSON.");
    if (chunkType === GLB_JSON_CHUNK) {
      if (jsonBuffer !== null || chunkIndex !== 0) throw new TypeError("GLB must contain one JSON chunk first.");
      if (chunkLength > maxJsonChunkBytes) throw new RangeError("GLB JSON chunk exceeds the configured size limit.");
      jsonBuffer = buffer.subarray(start, end);
    } else if (chunkType === GLB_BIN_CHUNK) {
      if (binaryBuffer !== null) throw new TypeError("GLB must not contain more than one BIN chunk.");
      binaryBuffer = buffer.subarray(start, end);
    }
    offset = end;
    chunkIndex += 1;
  }
  if (offset !== buffer.length || jsonBuffer === null) throw new TypeError("GLB chunk table is incomplete.");

  let gltf;
  try {
    gltf = JSON.parse(jsonBuffer.toString("utf8").replace(/ +$/, ""));
  } catch {
    throw new TypeError("GLB JSON chunk is invalid.");
  }
  if (!isRecord(gltf) || !isRecord(gltf.asset) || gltf.asset.version !== "2.0") {
    throw new TypeError("GLB must contain asset.version 2.0.");
  }
  return { gltf, binaryBuffer, fileBytes: buffer.length, jsonChunkBytes: jsonBuffer.length };
}

function validateSelfContainedBuffers(gltf, binaryBuffer) {
  const buffers = Array.isArray(gltf.buffers) ? gltf.buffers : [];
  const views = Array.isArray(gltf.bufferViews) ? gltf.bufferViews : [];
  if (views.length > 0 && buffers.length === 0) throw new TypeError("GLB bufferViews require an embedded buffer.");
  if (buffers.length > 1) throw new TypeError("Generated building GLBs must be self-contained in a single buffer.");
  const declaredLength = buffers[0]?.byteLength ?? 0;
  if (buffers[0]?.uri !== undefined) throw new TypeError("External buffer URIs are not accepted for published GLB assets.");
  if (!Number.isInteger(declaredLength) || declaredLength < 0) throw new TypeError("GLB buffer byteLength is invalid.");
  if (declaredLength > 0 && !binaryBuffer) throw new TypeError("GLB declares buffer data but has no BIN chunk.");
  if (binaryBuffer && (binaryBuffer.length < declaredLength || binaryBuffer.length - declaredLength > 3)) {
    throw new TypeError("GLB BIN chunk length does not match the embedded buffer.");
  }
  if (views.length > 0 && (!binaryBuffer || declaredLength === 0)) {
    throw new TypeError("GLB geometry requires a non-empty embedded BIN chunk.");
  }

  for (const view of views) {
    if (!isRecord(view) || (view.buffer ?? 0) !== 0) throw new TypeError("GLB bufferView references an unsupported buffer.");
    safeInteger(view.byteLength, "bufferView byteLength", 1, Math.max(1, declaredLength));
    const byteOffset = view.byteOffset ?? 0;
    safeInteger(byteOffset, "bufferView byteOffset", 0, declaredLength);
    if (byteOffset + view.byteLength > declaredLength) throw new TypeError("GLB bufferView exceeds the embedded buffer.");
    if (view.byteStride !== undefined) {
      safeInteger(view.byteStride, "bufferView byteStride", 4, 252);
      if (view.byteStride % 4 !== 0) throw new TypeError("GLB bufferView byteStride must be four-byte aligned.");
    }
  }

  for (const image of Array.isArray(gltf.images) ? gltf.images : []) {
    if (!isRecord(image)) throw new TypeError("GLB image definition is invalid.");
    if (typeof image.uri === "string" && !image.uri.startsWith("data:")) {
      throw new TypeError("External image URIs are not accepted; embed textures in the GLB.");
    }
    if (image.bufferView !== undefined) {
      safeInteger(image.bufferView, "image bufferView", 0, views.length - 1);
    }
  }
  return { buffers, views, declaredLength };
}

function collectPositionAccessorIds(gltf) {
  if (!Array.isArray(gltf.meshes) || gltf.meshes.length === 0) {
    throw new TypeError("GLB must contain at least one mesh.");
  }
  const positionIds = new Set();
  for (const mesh of gltf.meshes) {
    if (!isRecord(mesh) || !Array.isArray(mesh.primitives)) throw new TypeError("GLB mesh primitives are invalid.");
    for (const primitive of mesh.primitives) {
      if (!isRecord(primitive) || !isRecord(primitive.attributes) || !Number.isInteger(primitive.attributes.POSITION)) {
        throw new TypeError("GLB triangle primitive is missing a POSITION accessor.");
      }
      positionIds.add(primitive.attributes.POSITION);
    }
  }
  return positionIds;
}

function validateAccessors(gltf, binaryBuffer, bufferViews, positionIds, { maxVertices }) {
  const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
  if (accessors.length === 0) throw new TypeError("GLB must contain accessors for mesh geometry.");
  if (!binaryBuffer) throw new TypeError("GLB mesh accessors require an embedded BIN chunk.");

  let positionCount = 0;
  const positionBoundsByAccessor = new Map();

  for (let index = 0; index < accessors.length; index += 1) {
    const accessor = accessors[index];
    if (!isRecord(accessor)) throw new TypeError("GLB accessor " + index + " is invalid.");
    safeInteger(accessor.count, "accessor count", 1, maxVertices * 16);
    const componentBytes = COMPONENT_BYTES.get(accessor.componentType);
    if (!componentBytes) throw new TypeError("GLB accessor has an unsupported component type.");
    const components = componentCountForType(accessor.type);
    const elementBytes = componentBytes * components;
    const byteOffset = accessor.byteOffset ?? 0;
    safeInteger(byteOffset, "accessor byteOffset", 0, Number.MAX_SAFE_INTEGER);
    if (accessor.sparse !== undefined) {
      throw new TypeError("Sparse accessors are not accepted for generated building assets yet.");
    }
    if (!Number.isInteger(accessor.bufferView)) throw new TypeError("GLB accessor must reference a bufferView.");
    const viewIndex = safeInteger(accessor.bufferView, "accessor bufferView", 0, bufferViews.length - 1);
    const view = bufferViews[viewIndex];
    const stride = view.byteStride ?? elementBytes;
    if (stride < elementBytes) throw new TypeError("GLB accessor stride is smaller than its element size.");
    const absoluteStart = (view.byteOffset ?? 0) + byteOffset;
    if (absoluteStart % componentBytes !== 0) throw new TypeError("GLB accessor data is not aligned for its component type.");
    const neededBytes = byteOffset + (accessor.count - 1) * stride + elementBytes;
    if (!Number.isSafeInteger(neededBytes) || neededBytes > view.byteLength) {
      throw new TypeError("GLB accessor exceeds its bufferView.");
    }

    if (positionIds.has(index)) {
      if (accessor.type !== "VEC3" || accessor.componentType !== 5126) {
        throw new TypeError("GLB POSITION accessors must be FLOAT VEC3.");
      }
      positionCount += accessor.count;
      if (positionCount > maxVertices) throw new RangeError("GLB exceeds the configured total vertex limit.");
      const minimum = [Infinity, Infinity, Infinity];
      const maximum = [-Infinity, -Infinity, -Infinity];
      const start = (view.byteOffset ?? 0) + byteOffset;
      for (let item = 0; item < accessor.count; item += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const value = binaryBuffer.readFloatLE(start + item * stride + axis * 4);
          if (!Number.isFinite(value)) throw new TypeError("GLB POSITION accessor contains non-finite coordinates.");
          if (value < minimum[axis]) minimum[axis] = value;
          if (value > maximum[axis]) maximum[axis] = value;
        }
      }
      positionBoundsByAccessor.set(index, { min: minimum, max: maximum });
    }
  }

  return { accessors, positionCount, positionBoundsByAccessor };
}

const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

function multiplyMatrices(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

function nodeLocalMatrix(node) {
  const hasMatrix = node.matrix !== undefined;
  const hasTrs = node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined;
  if (hasMatrix && hasTrs) throw new TypeError("GLB nodes must not define matrix and TRS transforms together.");
  if (hasMatrix) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || !node.matrix.every(Number.isFinite)) {
      throw new TypeError("GLB node matrix must contain 16 finite values.");
    }
    return [...node.matrix];
  }

  const translation = node.translation ?? [0, 0, 0];
  const scale = node.scale ?? [1, 1, 1];
  const rotation = node.rotation ?? [0, 0, 0, 1];
  if (!Array.isArray(translation) || translation.length !== 3 || !translation.every(Number.isFinite)) {
    throw new TypeError("GLB node translation must contain 3 finite values.");
  }
  if (!Array.isArray(scale) || scale.length !== 3 || !scale.every(Number.isFinite)) {
    throw new TypeError("GLB node scale must contain 3 finite values.");
  }
  if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every(Number.isFinite)) {
    throw new TypeError("GLB node rotation must contain 4 finite quaternion values.");
  }

  let [x, y, z, w] = rotation;
  const quaternionLength = Math.hypot(x, y, z, w);
  if (quaternionLength < 1e-12) throw new TypeError("GLB node rotation quaternion is degenerate.");
  x /= quaternionLength;
  y /= quaternionLength;
  z /= quaternionLength;
  w /= quaternionLength;

  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = scale[0];
  const sy = scale[1];
  const sz = scale[2];

  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

function transformPoint(matrix, point) {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const output = [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
  if (Math.abs(w) > 1e-12 && Math.abs(w - 1) > 1e-12) {
    return output.map((value) => value / w);
  }
  return output;
}

function inferRootNodes(nodes) {
  const childIds = new Set();
  for (const node of nodes) {
    for (const child of node.children ?? []) childIds.add(child);
  }
  const roots = nodes.map((_, index) => index).filter((index) => !childIds.has(index));
  if (nodes.length > 0 && roots.length === 0) throw new TypeError("GLB node graph has no root node or contains a cycle.");
  return roots;
}

function computeSceneBounds(gltf, positionBoundsByAccessor) {
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  if (nodes.length === 0) throw new TypeError("GLB must contain at least one node.");

  let scenes = Array.isArray(gltf.scenes) ? gltf.scenes : [];
  if (scenes.length === 0) scenes = [{ nodes: inferRootNodes(nodes) }];
  const sceneIndex = gltf.scene ?? 0;
  safeInteger(sceneIndex, "default scene", 0, scenes.length - 1);
  const activeScene = scenes[sceneIndex];
  if (!isRecord(activeScene) || !Array.isArray(activeScene.nodes)) throw new TypeError("GLB default scene is invalid.");

  const boundsMin = [Infinity, Infinity, Infinity];
  const boundsMax = [-Infinity, -Infinity, -Infinity];
  const onPath = new Set();
  let visitedMeshPrimitives = 0;

  function addTransformedBounds(localBounds, worldMatrix) {
    for (let mask = 0; mask < 8; mask += 1) {
      const corner = [0, 1, 2].map((axis) =>
        (mask & (1 << axis)) ? localBounds.max[axis] : localBounds.min[axis]
      );
      const point = transformPoint(worldMatrix, corner);
      if (!point.every(Number.isFinite)) throw new TypeError("GLB node transforms produce non-finite coordinates.");
      for (let axis = 0; axis < 3; axis += 1) {
        boundsMin[axis] = Math.min(boundsMin[axis], point[axis]);
        boundsMax[axis] = Math.max(boundsMax[axis], point[axis]);
      }
    }
  }

  function visit(nodeIndex, parentMatrix, depth) {
    if (depth > 256) throw new RangeError("GLB node hierarchy is too deep.");
    safeInteger(nodeIndex, "scene node", 0, nodes.length - 1);
    if (onPath.has(nodeIndex)) throw new TypeError("GLB node hierarchy contains a cycle.");
    const node = nodes[nodeIndex];
    if (!isRecord(node)) throw new TypeError("GLB node definition is invalid.");
    onPath.add(nodeIndex);
    const worldMatrix = multiplyMatrices(parentMatrix, nodeLocalMatrix(node));

    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (!mesh) throw new TypeError("GLB node references a missing mesh.");
      for (const primitive of mesh.primitives) {
        const positionAccessorIndex = primitive.attributes.POSITION;
        const positionBounds = positionBoundsByAccessor.get(positionAccessorIndex);
        if (!positionBounds) throw new TypeError("GLB scene references a POSITION accessor without validated bounds.");
        addTransformedBounds(positionBounds, worldMatrix);
        visitedMeshPrimitives += 1;
      }
    }
    for (const childIndex of node.children ?? []) visit(childIndex, worldMatrix, depth + 1);
    onPath.delete(nodeIndex);
  }

  for (const rootIndex of activeScene.nodes) visit(rootIndex, IDENTITY_MATRIX, 0);
  if (visitedMeshPrimitives === 0) throw new TypeError("GLB active scene contains no renderable mesh geometry.");
  return { min: boundsMin, max: boundsMax };
}

function validateMeshes(gltf, accessors, binaryBuffer, bufferViews, { maxVertices }) {
  const meshes = gltf.meshes;
  const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  let primitiveCount = 0;
  let triangleCount = 0;
  let vertexCount = 0;

  for (const mesh of meshes) {
    for (const primitive of mesh.primitives) {
      primitiveCount += 1;
      const positionIndex = safeInteger(primitive.attributes.POSITION, "POSITION accessor", 0, accessors.length - 1);
      const positionAccessor = accessors[positionIndex];
      vertexCount += positionAccessor.count;
      if (vertexCount > maxVertices) throw new RangeError("GLB exceeds the configured total vertex limit.");

      const mode = primitive.mode === undefined ? 4 : primitive.mode;
      if (mode !== 4) throw new TypeError("Generated building meshes must use TRIANGLES primitives.");
      let indexCount = positionAccessor.count;
      if (primitive.indices !== undefined) {
        const indexAccessorIndex = safeInteger(primitive.indices, "indices accessor", 0, accessors.length - 1);
        const indexAccessor = accessors[indexAccessorIndex];
        if (indexAccessor.type !== "SCALAR" || ![5121, 5123, 5125].includes(indexAccessor.componentType)) {
          throw new TypeError("GLB primitive indices must use an unsigned scalar accessor.");
        }
        indexCount = indexAccessor.count;
        const view = bufferViews[indexAccessor.bufferView];
        const bytesPerIndex = COMPONENT_BYTES.get(indexAccessor.componentType);
        const start = (view.byteOffset ?? 0) + (indexAccessor.byteOffset ?? 0);
        for (let index = 0; index < indexCount; index += 1) {
          const position = start + index * bytesPerIndex;
          const value = indexAccessor.componentType === 5121 ? binaryBuffer.readUInt8(position)
            : indexAccessor.componentType === 5123 ? binaryBuffer.readUInt16LE(position)
              : binaryBuffer.readUInt32LE(position);
          if (value >= positionAccessor.count) throw new TypeError("GLB primitive index exceeds its POSITION accessor.");
        }
      }
      if (indexCount < 3 || indexCount % 3 !== 0) {
        throw new TypeError("GLB triangle primitive index count must be divisible by three.");
      }
      triangleCount += indexCount / 3;
      if (primitive.material !== undefined) {
        safeInteger(primitive.material, "primitive material", 0, materials.length - 1);
      }
    }
  }

  if (primitiveCount === 0 || triangleCount === 0 || vertexCount === 0) {
    throw new TypeError("GLB must contain at least one non-empty triangle mesh.");
  }
  for (const material of materials) {
    if (!isRecord(material)) throw new TypeError("GLB material definition is invalid.");
  }
  for (const node of nodes) {
    if (!isRecord(node)) throw new TypeError("GLB node definition is invalid.");
    if (node.mesh !== undefined) safeInteger(node.mesh, "node mesh", 0, meshes.length - 1);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new TypeError("GLB node children must be an array.");
      for (const child of node.children) safeInteger(child, "node child", 0, Math.max(0, nodes.length - 1));
    }
  }
  for (const scene of Array.isArray(gltf.scenes) ? gltf.scenes : []) {
    if (!isRecord(scene) || !Array.isArray(scene.nodes)) throw new TypeError("GLB scene definition is invalid.");
    for (const nodeIndex of scene.nodes) safeInteger(nodeIndex, "scene node", 0, Math.max(0, nodes.length - 1));
  }
  return { meshes, materials, nodes, primitiveCount, triangleCount, vertexCount };
}

/** Validate a self-contained glTF 2.0 binary asset before it enters private storage. */
export function inspectGeneratedGlb(value, options = {}) {
  const maxBytes = options.maxBytes ?? (100 * 1024 * 1024);
  const maxJsonChunkBytes = options.maxJsonChunkBytes ?? Math.min(16 * 1024 * 1024, maxBytes);
  const maxVertices = options.maxVertices ?? 5_000_000;
  safeInteger(maxBytes, "maxBytes", 1024, 2 * 1024 * 1024 * 1024);
  safeInteger(maxJsonChunkBytes, "maxJsonChunkBytes", 1024, maxBytes);
  safeInteger(maxVertices, "maxVertices", 3, 20_000_000);
  const buffer = toBuffer(value);
  const parsed = parseGlb(buffer, { maxBytes, maxJsonChunkBytes });
  const storage = validateSelfContainedBuffers(parsed.gltf, parsed.binaryBuffer);
  const positionIds = collectPositionAccessorIds(parsed.gltf);
  const accessorInfo = validateAccessors(parsed.gltf, parsed.binaryBuffer, storage.views, positionIds, { maxVertices });
  const meshes = validateMeshes(parsed.gltf, accessorInfo.accessors, parsed.binaryBuffer, storage.views, { maxVertices });
  const bounds = computeSceneBounds(parsed.gltf, accessorInfo.positionBoundsByAccessor);

  return {
    valid: true,
    contentType: "model/gltf-binary",
    bytes: buffer.length,
    jsonChunkBytes: parsed.jsonChunkBytes,
    meshCount: meshes.meshes.length,
    primitiveCount: meshes.primitiveCount,
    triangleCount: meshes.triangleCount,
    vertexCount: meshes.vertexCount,
    nodeCount: meshes.nodes.length,
    materialCount: meshes.materials.length,
    bounds,
    warnings: Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis])) > 10000
      ? ["The raw mesh spans more than 10 km; confirm that model units and scale are correct before publishing."]
      : [],
  };
}

function packGlb(gltf, binaryBuffer) {
  const jsonRaw = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPadding = (4 - (jsonRaw.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonRaw, Buffer.alloc(jsonPadding, 0x20)]);
  const hasBinary = binaryBuffer !== null && binaryBuffer.length > 0;
  const binPadding = hasBinary ? (4 - (binaryBuffer.length % 4)) % 4 : 0;
  const binChunk = hasBinary ? Buffer.concat([binaryBuffer, Buffer.alloc(binPadding)]) : Buffer.alloc(0);
  const totalLength = 12 + 8 + jsonChunk.length + (hasBinary ? 8 + binChunk.length : 0);
  const output = Buffer.alloc(totalLength);
  output.write("glTF", 0, 4, "ascii");
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(jsonChunk.length, 12);
  output.writeUInt32LE(GLB_JSON_CHUNK, 16);
  jsonChunk.copy(output, 20);
  if (hasBinary) {
    const binHeaderOffset = 20 + jsonChunk.length;
    output.writeUInt32LE(binChunk.length, binHeaderOffset);
    output.writeUInt32LE(GLB_BIN_CHUNK, binHeaderOffset + 4);
    binChunk.copy(output, binHeaderOffset + 8);
  }
  return output;
}

/**
 * Adds a root transform so a candidate has an explicit local-metre size and sits on y=0.
 * uniform-fit preserves proportions and fits inside the requested envelope.
 * fit-dimensions hits each requested dimension exactly but may distort architectural proportions.
 */
export function alignGeneratedGlbToDimensions(value, {
  footprintWidthMeters,
  footprintDepthMeters,
  totalHeightMeters,
  mode = "uniform-fit",
  maxBytes = 100 * 1024 * 1024,
} = {}) {
  const target = [
    footprintWidthMeters,
    totalHeightMeters,
    footprintDepthMeters,
  ];
  for (let axis = 0; axis < target.length; axis += 1) {
    if (typeof target[axis] !== "number" || !Number.isFinite(target[axis]) || target[axis] < 0.5 || target[axis] > 1000) {
      throw new RangeError("Alignment target dimensions must each be between 0.5 and 1000 metres.");
    }
  }
  if (mode !== "uniform-fit" && mode !== "fit-dimensions") {
    throw new TypeError("Alignment mode must be uniform-fit or fit-dimensions.");
  }

  const originalBuffer = toBuffer(value);
  const originalValidation = inspectGeneratedGlb(originalBuffer, { maxBytes });
  const rawSize = originalValidation.bounds.max.map((max, axis) => max - originalValidation.bounds.min[axis]);
  if (rawSize.some((size) => !Number.isFinite(size) || size < 1e-4)) {
    throw new RangeError("Cannot align a degenerate model whose scene bounds have zero size on an axis.");
  }

  const ratios = target.map((size, axis) => size / rawSize[axis]);
  let scale;
  if (mode === "uniform-fit") {
    const uniform = Math.min(...ratios);
    scale = [uniform, uniform, uniform];
  } else {
    scale = ratios;
  }
  const translation = [
    -((originalValidation.bounds.min[0] + originalValidation.bounds.max[0]) / 2) * scale[0],
    -originalValidation.bounds.min[1] * scale[1],
    -((originalValidation.bounds.min[2] + originalValidation.bounds.max[2]) / 2) * scale[2],
  ];

  const parsed = parseGlb(originalBuffer, { maxBytes, maxJsonChunkBytes: Math.min(16 * 1024 * 1024, maxBytes) });
  const gltf = parsed.gltf;
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  let scenes = Array.isArray(gltf.scenes) ? gltf.scenes : [];
  if (scenes.length === 0) scenes = [{ nodes: inferRootNodes(nodes) }];
  if (!Array.isArray(gltf.scenes) || gltf.scenes.length === 0) gltf.scenes = scenes;
  const defaultScene = gltf.scene ?? 0;
  safeInteger(defaultScene, "default scene", 0, gltf.scenes.length - 1);

  for (const scene of gltf.scenes) {
    if (!isRecord(scene) || !Array.isArray(scene.nodes)) throw new TypeError("GLB scene definition is invalid.");
    const originalRoots = [...scene.nodes];
    const wrapperIndex = gltf.nodes.length;
    gltf.nodes.push({
      name: "Building Generation · Metric Alignment",
      children: originalRoots,
      translation,
      scale,
      extras: {
        buildingGenerationAlignment: {
          mode,
          units: "metres",
          targetDimensions: { width: target[0], height: target[1], depth: target[2] },
          sourceBounds: originalValidation.bounds,
          uniformScale: mode === "uniform-fit" ? scale[0] : null,
          scale,
          translation,
          nonUniformDistortionPossible: mode === "fit-dimensions",
        },
      },
    });
    scene.nodes = [wrapperIndex];
  }
  gltf.scene = defaultScene;
  const alignedGlb = packGlb(gltf, parsed.binaryBuffer);
  const validation = inspectGeneratedGlb(alignedGlb, { maxBytes: Math.max(maxBytes, alignedGlb.length) });
  const finalSize = validation.bounds.max.map((max, axis) => max - validation.bounds.min[axis]);
  const warnings = [...validation.warnings];
  if (mode === "fit-dimensions") {
    warnings.push("Non-uniform scaling was applied to match dimensions; inspect facade and roof proportions before approval.");
  } else if (finalSize.some((size, axis) => Math.abs(size - target[axis]) > Math.max(0.1, target[axis] * 0.02))) {
    warnings.push("Uniform-fit preserves proportions, so one or more final dimensions remain below the requested envelope.");
  }
  return {
    glb: alignedGlb,
    validation,
    alignment: {
      mode,
      targetDimensions: { width: target[0], height: target[1], depth: target[2] },
      sourceDimensions: { width: rawSize[0], height: rawSize[1], depth: rawSize[2] },
      finalDimensions: { width: finalSize[0], height: finalSize[1], depth: finalSize[2] },
      scale,
      translation,
      warnings,
    },
  };
}

async function readBoundedResponse(response, maxBytes) {
  const lengthHeader = response.headers?.get?.("content-length");
  if (lengthHeader !== null && lengthHeader !== undefined && lengthHeader.trim()) {
    const length = Number(lengthHeader);
    if (Number.isFinite(length) && length > maxBytes) throw new RangeError("Generated GLB exceeds the configured download size limit.");
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new RangeError("Generated GLB exceeds the configured download size limit.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, size);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new RangeError("Generated GLB exceeds the configured download size limit.");
  return data;
}

/** Download only from an explicitly allowlisted HTTPS model host; redirects are disabled to avoid URL re-targeting. */
export async function downloadGeneratedGlb(value, {
  fetchImpl = fetch,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  maxBytes = 100 * 1024 * 1024,
  timeoutMs = 60_000,
  signal,
} = {}) {
  if (typeof value !== "string" || value.length > 4096) throw new TypeError("Generated model URL is invalid.");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("Generated model URL must be absolute HTTPS."); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new TypeError("Generated model URL must be HTTPS without embedded credentials.");
  }
  if (url.port && url.port !== "443") throw new TypeError("Generated model URL uses an unsupported port.");
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0 || !allowedHosts.every((host) => typeof host === "string" && host.trim())) {
    throw new TypeError("An explicit model-host allowlist is required.");
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((host) => {
    const normalized = host.toLowerCase().replace(/^\./, "");
    return hostname === normalized || hostname.endsWith("." + normalized);
  });
  if (!allowed) throw new TypeError("Generated model URL host is not allowlisted.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  safeInteger(maxBytes, "maxBytes", 1024, 2 * 1024 * 1024 * 1024);
  safeInteger(timeoutMs, "timeoutMs", 1000, 600_000);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchImpl(url.toString(), {
    method: "GET",
    redirect: "manual",
    signal: requestSignal,
    headers: { Accept: "model/gltf-binary, application/octet-stream" },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Redirected model downloads are blocked; the provider URL must be direct.");
  }
  if (!response.ok) throw new Error("Generated model download failed with HTTP " + response.status + ".");
  const glb = await readBoundedResponse(response, maxBytes);
  const validation = inspectGeneratedGlb(glb, { maxBytes });
  return { glb, validation };
}

export const GLB_VALIDATION_DEFAULTS = Object.freeze({
  maxBytes: 100 * 1024 * 1024,
  maxJsonChunkBytes: 16 * 1024 * 1024,
  maxVertices: 5_000_000,
  timeoutMs: 60_000,
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
});
