const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const DEFAULT_ALLOWED_HOSTS = Object.freeze(["cdn.tripo3d.ai"]);
const COMPONENT_BYTES = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
const TYPE_COMPONENTS = new Map([["SCALAR", 1], ["VEC2", 2], ["VEC3", 3], ["VEC4", 4], ["MAT2", 4], ["MAT3", 9], ["MAT4", 16]]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(name + " is outside the supported range.");
  return value;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("GLB data must be a Buffer or Uint8Array.");
}

function getComponentCount(type) {
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

  let jsonText = jsonBuffer.toString("utf8").replace(/ +$/, "");
  let gltf;
  try { gltf = JSON.parse(jsonText); } catch { throw new TypeError("GLB JSON chunk is invalid."); }
  if (!isRecord(gltf) || !isRecord(gltf.asset) || gltf.asset.version !== "2.0") {
    throw new TypeError("GLB must contain asset.version 2.0.");
  }
  return { gltf, binaryBuffer, fileBytes: buffer.length };
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
  for (const view of views) {
    if (!isRecord(view) || (view.buffer ?? 0) !== 0) throw new TypeError("GLB bufferView references an unsupported buffer.");
    safeInteger(view.byteLength, "bufferView byteLength", 1, declaredLength);
    const byteOffset = view.byteOffset ?? 0;
    safeInteger(byteOffset, "bufferView byteOffset", 0, declaredLength);
    if (byteOffset + view.byteLength > declaredLength) throw new TypeError("GLB bufferView exceeds the embedded buffer.");
    if (view.byteStride !== undefined) {
      safeInteger(view.byteStride, "bufferView byteStride", 4, 252);
      if (view.byteStride % 4 !== 0) throw new TypeError("GLB bufferView byteStride must be four-byte aligned.");
    }
  }
  const images = Array.isArray(gltf.images) ? gltf.images : [];
  for (const image of images) {
    if (!isRecord(image)) throw new TypeError("GLB image definition is invalid.");
    if (typeof image.uri === "string" && !image.uri.startsWith("data:")) {
      throw new TypeError("External image URIs are not accepted; embed textures in the GLB.");
    }
    if (image.bufferView !== undefined) safeInteger(image.bufferView, "image bufferView", 0, Math.max(0, views.length - 1));
  }
  return { buffers, views, declaredLength };
}

function validateAccessors(gltf, binaryBuffer, bufferViews, { maxVertices }) {
  const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
  const positions = [];
  for (let index = 0; index < accessors.length; index += 1) {
    const accessor = accessors[index];
    if (!isRecord(accessor)) throw new TypeError("GLB accessor " + index + " is invalid.");
    safeInteger(accessor.count, "accessor count", 1, maxVertices * 16);
    const componentBytes = COMPONENT_BYTES.get(accessor.componentType);
    if (!componentBytes) throw new TypeError("GLB accessor has an unsupported component type.");
    const componentCount = getComponentCount(accessor.type);
    const elementBytes = componentBytes * componentCount;
    const byteOffset = accessor.byteOffset ?? 0;
    safeInteger(byteOffset, "accessor byteOffset", 0, Number.MAX_SAFE_INTEGER);
    if (accessor.bufferView !== undefined) {
      const viewIndex = safeInteger(accessor.bufferView, "accessor bufferView", 0, Math.max(0, bufferViews.length - 1));
      const view = bufferViews[viewIndex];
      const stride = view.byteStride ?? elementBytes;
      if (stride < elementBytes) throw new TypeError("GLB accessor stride is smaller than its element size.");
      const neededBytes = byteOffset + (accessor.count - 1) * stride + elementBytes;
      if (neededBytes > view.byteLength) throw new TypeError("GLB accessor exceeds its bufferView.");
    } else if (!isRecord(accessor.sparse)) {
      throw new TypeError("GLB accessor must use a bufferView or sparse storage.");
    }
    if (accessor.type === "VEC3" && accessor.componentType === 5126 && accessor.bufferView !== undefined) {
      const view = bufferViews[accessor.bufferView];
      const stride = view.byteStride ?? 12;
      const start = view.byteOffset + byteOffset;
      for (let item = 0; item < accessor.count; item += 1) {
        const point = [0, 1, 2].map((axis) => binaryBuffer.readFloatLE(start + item * stride + axis * 4));
        if (!point.every(Number.isFinite)) throw new TypeError("GLB POSITION accessor contains non-finite coordinates.");
        positions.push(...point);
      }
      if (positions.length > maxVertices * 3) throw new RangeError("GLB exceeds the configured vertex limit.");
    }
  }
  return positions;
}

function validateMeshes(gltf, accessors, binaryBuffer, bufferViews, { maxVertices }) {
  const meshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  const materials = Array.isArray(gltf.materials) ? gltf.materials : [];
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  let primitiveCount = 0;
  let triangleCount = 0;
  let vertexCount = 0;
  for (const mesh of meshes) {
    if (!isRecord(mesh) || !Array.isArray(mesh.primitives)) throw new TypeError("GLB mesh primitives are invalid.");
    for (const primitive of mesh.primitives) {
      primitiveCount += 1;
      if (!isRecord(primitive) || !isRecord(primitive.attributes) || !Number.isInteger(primitive.attributes.POSITION)) {
        throw new TypeError("GLB triangle primitive is missing a POSITION accessor.");
      }
      const positionIndex = safeInteger(primitive.attributes.POSITION, "POSITION accessor", 0, Math.max(0, accessors.length - 1));
      const positionAccessor = accessors[positionIndex];
      if (positionAccessor.type !== "VEC3" || positionAccessor.componentType !== 5126) {
        throw new TypeError("GLB POSITION accessors must be FLOAT VEC3.");
      }
      if (positionAccessor.count > maxVertices) throw new RangeError("GLB exceeds the configured vertex limit.");
      vertexCount += positionAccessor.count;
      const mode = primitive.mode === undefined ? 4 : primitive.mode;
      if (mode === 4) {
        let indexCount = positionAccessor.count;
        if (primitive.indices !== undefined) {
          const indexAccessorIndex = safeInteger(primitive.indices, "indices accessor", 0, Math.max(0, accessors.length - 1));
          const indexAccessor = accessors[indexAccessorIndex];
          if (indexAccessor.type !== "SCALAR" || ![5121, 5123, 5125].includes(indexAccessor.componentType)) {
            throw new TypeError("GLB primitive indices must use an unsigned scalar accessor.");
          }
          indexCount = indexAccessor.count;
          const view = bufferViews[indexAccessor.bufferView];
          const bytesPerIndex = COMPONENT_BYTES.get(indexAccessor.componentType);
          const start = view.byteOffset + (indexAccessor.byteOffset ?? 0);
          for (let i = 0; i < indexCount; i += 1) {
            const position = start + i * bytesPerIndex;
            const value = indexAccessor.componentType === 5121 ? binaryBuffer.readUInt8(position)
              : indexAccessor.componentType === 5123 ? binaryBuffer.readUInt16LE(position) : binaryBuffer.readUInt32LE(position);
            if (value >= positionAccessor.count) throw new TypeError("GLB primitive index exceeds its POSITION accessor.");
          }
        }
        if (indexCount % 3 !== 0) throw new TypeError("GLB triangle primitive index count must be divisible by three.");
        triangleCount += indexCount / 3;
      }
      if (primitive.material !== undefined) safeInteger(primitive.material, "primitive material", 0, Math.max(0, materials.length - 1));
    }
  }
  if (meshes.length === 0 || primitiveCount === 0 || triangleCount === 0 || vertexCount === 0) {
    throw new TypeError("GLB must contain at least one non-empty triangle mesh.");
  }
  if (vertexCount > maxVertices) throw new RangeError("GLB exceeds the configured total vertex limit.");
  return { meshes, materials, nodes, primitiveCount, triangleCount, vertexCount };
}

/** Validate a self-contained glTF 2.0 binary asset before it enters the private asset store. */
export function inspectGeneratedGlb(value, { maxBytes = 100 * 1024 * 1024, maxJsonChunkBytes = 16 * 1024 * 1024, maxVertices = 5_000_000 } = {}) {
  safeInteger(maxBytes, "maxBytes", 1024, 2 * 1024 * 1024 * 1024);
  safeInteger(maxJsonChunkBytes, "maxJsonChunkBytes", 1024, maxBytes);
  safeInteger(maxVertices, "maxVertices", 3, 20_000_000);
  const buffer = toBuffer(value);
  const parsed = parseGlb(buffer, { maxBytes, maxJsonChunkBytes });
  const storage = validateSelfContainedBuffers(parsed.gltf, parsed.binaryBuffer);
  const positions = validateAccessors(parsed.gltf, parsed.binaryBuffer, storage.views, { maxVertices });
  const meshes = validateMeshes(parsed.gltf, parsed.gltf.accessors ?? [], parsed.binaryBuffer, storage.views, { maxVertices });
  const bounds = positions.length === 0 ? null : {
    min: [0, 1, 2].map((axis) => Math.min(...positions.filter((_, index) => index % 3 === axis))),
    max: [0, 1, 2].map((axis) => Math.max(...positions.filter((_, index) => index % 3 === axis))),
  };
  return {
    valid: true,
    contentType: "model/gltf-binary",
    bytes: buffer.length,
    jsonChunkBytes: parsed.gltf ? undefined : undefined,
    meshCount: meshes.meshes.length,
    primitiveCount: meshes.primitiveCount,
    triangleCount: meshes.triangleCount,
    vertexCount: meshes.vertexCount,
    nodeCount: meshes.nodes.length,
    materialCount: meshes.materials.length,
    bounds,
    warnings: bounds && Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis])) > 10000
      ? ["The raw mesh spans more than 10 km; confirm that model units and scale are correct before publishing."]
      : [],
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
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new TypeError("Generated model URL must be HTTPS without embedded credentials.");
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
  const response = await fetchImpl(url.toString(), { method: "GET", redirect: "manual", signal: requestSignal, headers: { Accept: "model/gltf-binary, application/octet-stream" } });
  if (response.status >= 300 && response.status < 400) throw new Error("Redirected model downloads are blocked; the provider URL must be direct.");
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
