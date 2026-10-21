import { createHash } from "node:crypto";
import { reviewUvSeams } from "./uv-seam-review.mjs";
import { reviewTextureImageContent } from "./texture-image-content-review.mjs";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPONENT_BYTES = { 5121: 1, 5123: 2, 5125: 4 };

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) throw new TypeError("input must be a GLB 2.0 Buffer");
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new TypeError("invalid GLB magic");
  if (buffer.readUInt32LE(4) !== 2) throw new TypeError("only GLB version 2 is supported");
  if (buffer.readUInt32LE(8) !== buffer.length) throw new TypeError("GLB length header does not match actual size");
  let offset = 12, gltf = null, binary = null;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new TypeError("truncated GLB chunk header");
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (length % 4 !== 0 || offset + length > buffer.length) throw new TypeError("invalid or truncated GLB chunk");
    const chunk = buffer.subarray(offset, offset + length);
    if (type === JSON_CHUNK) {
      if (gltf || offset !== 20) throw new TypeError("GLB must contain one JSON chunk first");
      gltf = JSON.parse(chunk.toString("utf8").trim());
    } else if (type === BIN_CHUNK) {
      if (binary) throw new TypeError("GLB contains multiple BIN chunks");
      binary = chunk;
    }
    offset += length;
  }
  if (gltf?.asset?.version !== "2.0") throw new TypeError("GLB JSON is not glTF 2.0");
  const buffers = gltf.buffers ?? [];
  const errors = [];
  if (buffers.length > 1) errors.push("multiple-buffer-definitions-unsupported");
  if (buffers.some((item) => typeof item.uri === "string")) errors.push("external-buffer-uri");
  if (buffers.length && (!binary || !Number.isSafeInteger(buffers[0].byteLength) || buffers[0].byteLength > binary.length)) {
    errors.push("missing-or-short-binary-buffer");
  }
  return { gltf, binary, bufferLength: buffers[0]?.byteLength ?? binary?.length ?? 0, initialErrors: errors };
}

function imageDimensions(bytes, mimeType) {
  if (mimeType === "image/png") {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: "png" };
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 7) return null;
        return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), format: "jpeg" };
      }
      offset += length;
    }
  }
  return null;
}

function getImageBytes(image, gltf, binary, bufferLength, index, errors, warnings) {
  const views = gltf.bufferViews ?? [];
  if (image?.bufferView !== undefined) {
    const view = views[image.bufferView];
    if (!view || view.buffer !== 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 1) {
      errors.push(`image-${index}-invalid-bufferView`);
      return null;
    }
    const start = view.byteOffset ?? 0;
    const end = start + view.byteLength;
    if (!binary || !Number.isSafeInteger(start) || start < 0 || end > bufferLength || end > binary.length) {
      errors.push(`image-${index}-bufferView-out-of-bounds`);
      return null;
    }
    if (typeof image.mimeType !== "string" || !["image/png","image/jpeg","image/webp","image/ktx2"].includes(image.mimeType)) {
      errors.push(`image-${index}-invalid-or-missing-mimeType`);
      return null;
    }
    if (typeof image.uri === "string") errors.push(`image-${index}-has-both-uri-and-bufferView`);
    return binary.subarray(start, end);
  }
  if (typeof image?.uri === "string") {
    if (image.uri.startsWith("data:")) {
      const match = image.uri.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (!match) { errors.push(`image-${index}-invalid-data-uri`); return null; }
      try {
        const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
        image.mimeType = image.mimeType ?? match[1];
        return bytes;
      } catch {
        errors.push(`image-${index}-invalid-data-uri-payload`);
        return null;
      }
    }
    warnings.push(`image-${index}-external-uri`);
    return null;
  }
  errors.push(`image-${index}-has-no-source`);
  return null;
}

function readUvAccessor(accessor, views, binary, bufferLength, label, errors) {
  if (!accessor || accessor.type !== "VEC2" || accessor.componentType !== 5126 || accessor.sparse) {
    errors.push(`${label}-invalid-uv-accessor`);
    return null;
  }
  const view = views[accessor.bufferView];
  if (!view || view.buffer !== 0) { errors.push(`${label}-uv-not-in-embedded-buffer`); return null; }
  const count = accessor.count;
  const viewOffset = view.byteOffset ?? 0;
  const accessorOffset = accessor.byteOffset ?? 0;
  const stride = view.byteStride ?? 8;
  const viewLength = view.byteLength;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(viewOffset) || viewOffset < 0 ||
    !Number.isSafeInteger(accessorOffset) || accessorOffset < 0 || !Number.isSafeInteger(viewLength) ||
    viewLength < 1 || !Number.isSafeInteger(stride) || stride < 8 || stride > 252 || stride % 4 !== 0) {
    errors.push(`${label}-invalid-uv-layout`);
    return null;
  }
  const first = viewOffset + accessorOffset;
  const end = first + (count - 1) * stride + 8;
  if (!binary || end > viewOffset + viewLength || end > bufferLength || end > binary.length) {
    errors.push(`${label}-uv-accessor-out-of-bounds`);
    return null;
  }
  const uvs = [];
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  let nonFiniteCount = 0, outOfRangeCount = 0;
  for (let i = 0; i < count; i++) {
    const offset = first + i * stride;
    const u = binary.readFloatLE(offset), v = binary.readFloatLE(offset + 4);
    uvs.push([u,v]);
    if (!finite(u) || !finite(v)) { nonFiniteCount++; continue; }
    minU = Math.min(minU,u); minV = Math.min(minV,v); maxU = Math.max(maxU,u); maxV = Math.max(maxV,v);
    if (u < -1e-5 || v < -1e-5 || u > 1.00001 || v > 1.00001) outOfRangeCount++;
  }
  if (nonFiniteCount) errors.push(`${label}-contains-non-finite-uvs`);
  if (outOfRangeCount) errors.push(`${label}-uv-outside-normalized-range`);
  return { count, bounds: nonFiniteCount ? null : { minU,minV,maxU,maxV }, nonFiniteCount, outOfRangeCount, values: uvs };
}

function readPositionAccessor(accessor, views, binary, bufferLength, label, errors) {
  if (!accessor || accessor.type !== "VEC3" || accessor.componentType !== 5126 || accessor.sparse) {
    errors.push(`${label}-invalid-position-accessor`);
    return null;
  }
  const view = views[accessor.bufferView];
  if (!view || view.buffer !== 0) { errors.push(`${label}-position-not-in-embedded-buffer`); return null; }
  const count = accessor.count;
  const viewOffset = view.byteOffset ?? 0, accessorOffset = accessor.byteOffset ?? 0, stride = view.byteStride ?? 12;
  const viewLength = view.byteLength;
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(viewOffset) || viewOffset < 0 ||
    !Number.isSafeInteger(accessorOffset) || accessorOffset < 0 || !Number.isSafeInteger(viewLength) ||
    viewLength < 1 || !Number.isSafeInteger(stride) || stride < 12 || stride > 252 || stride % 4 !== 0) {
    errors.push(`${label}-invalid-position-layout`);
    return null;
  }
  const first = viewOffset + accessorOffset, end = first + (count - 1) * stride + 12;
  if (!binary || end > viewOffset + viewLength || end > bufferLength || end > binary.length) {
    errors.push(`${label}-position-accessor-out-of-bounds`);
    return null;
  }
  const positions = [];
  for (let i = 0; i < count; i++) {
    const at = first + i * stride;
    const point = [binary.readFloatLE(at), binary.readFloatLE(at + 4), binary.readFloatLE(at + 8)];
    if (point.some((value) => !finite(value))) errors.push(`${label}-contains-non-finite-position`);
    positions.push(point);
  }
  return { count, values: positions };
}

function readIndexAccessor(accessor, views, binary, bufferLength, vertexCount, label, errors) {
  if (!accessor) return Array.from({length:vertexCount},(_,index)=>index);
  const bytes = COMPONENT_BYTES[accessor.componentType];
  const methods = { 5121:"readUInt8", 5123:"readUInt16LE", 5125:"readUInt32LE" };
  const view = views[accessor.bufferView];
  if (!bytes || accessor.type !== "SCALAR" || accessor.sparse || !view || view.buffer !== 0) {
    errors.push(`${label}-invalid-index-accessor`); return null;
  }
  const first = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const end = first + accessor.count * bytes;
  if (!Number.isSafeInteger(accessor.count) || accessor.count < 1 || accessor.count % 3 !== 0 ||
    !Number.isSafeInteger(view.byteLength) || end > (view.byteOffset ?? 0) + view.byteLength || end > bufferLength || end > binary.length) {
    errors.push(`${label}-index-accessor-out-of-bounds`); return null;
  }
  const indices = [];
  for (let i = 0; i < accessor.count; i++) {
    const value = binary[methods[accessor.componentType]](first + i * bytes);
    if (value >= vertexCount) errors.push(`${label}-index-out-of-range`);
    indices.push(value);
  }
  return indices;
}

const MATERIAL_TEXTURES = [
  ["pbrMetallicRoughness","baseColorTexture"],
  ["pbrMetallicRoughness","metallicRoughnessTexture"],
  ["normalTexture"],
  ["occlusionTexture"],
  ["emissiveTexture"],
];

function materialTextureRefs(material) {
  const refs = [];
  for (const path of MATERIAL_TEXTURES) {
    let node = material;
    for (const key of path) node = node?.[key];
    if (node !== undefined && node !== null) refs.push({ property:path.join("."), ...node });
  }
  return refs;
}

/**
 * Audits glTF texture sources, material bindings and normalized UV attributes.
 * This is structural QA only; it does not render pixels or certify visual seams.
 */
export function reviewGlbTextureBindings(input, options = {}) {
  const { gltf, binary, bufferLength, initialErrors } = parseGlb(input);
  const errors = [...initialErrors], warnings = [], images = [], usedImageIndices = new Set();
  const views = gltf.bufferViews ?? [], accessors = gltf.accessors ?? [], textures = gltf.textures ?? [], materials = gltf.materials ?? [];
  const sourceBytes = [];
  (gltf.images ?? []).forEach((image,index) => {
    const bytes = getImageBytes(image,gltf,binary,bufferLength,index,errors,warnings);
    sourceBytes.push(bytes);
    const mimeType = image?.mimeType ?? (typeof image?.uri === "string" ? image.uri.match(/^data:([^;,]+)/)?.[1] : null);
    const dimensions = bytes ? imageDimensions(bytes,mimeType) : null;
    const contentReview = bytes ? reviewTextureImageContent(bytes,mimeType, {
      minRecommendedDimension: options.minRecommendedTextureDimension ?? 512,
      maxPixels: options.maxTextureAnalysisPixels ?? 16_777_216,
    }) : null;
    if (contentReview) {
      for (const risk of contentReview.risks) {
        if (risk !== "pixel-content-not-analysed-for-this-image-format") warnings.push(`image-${index}-${risk}`);
      }
    }
    if (bytes && ["image/png","image/jpeg","image/jpg"].includes(mimeType) && !dimensions) errors.push(`image-${index}-content-does-not-match-mimeType-or-is-truncated`);
    if (dimensions && (dimensions.width < 1 || dimensions.height < 1)) errors.push(`image-${index}-invalid-dimensions`);
    images.push({ index, name:image?.name ?? null, mimeType:mimeType ?? null, embedded:Boolean(bytes), byteLength:bytes?.length ?? null,
      sha256:bytes ? sha256(bytes) : null, width:dimensions?.width ?? null, height:dimensions?.height ?? null,
      format:dimensions?.format ?? null, contentReview });
  });

  const validTextureImage = new Map();
  textures.forEach((texture,index) => {
    if (!Number.isSafeInteger(texture?.source) || !images[texture.source]) {
      errors.push(`texture-${index}-references-invalid-image`);
      return;
    }
    validTextureImage.set(index,texture.source);
    usedImageIndices.add(texture.source);
    if (texture.sampler !== undefined && (!Number.isSafeInteger(texture.sampler) || !Array.isArray(gltf.samplers) || !gltf.samplers[texture.sampler])) {
      errors.push(`texture-${index}-references-invalid-sampler`);
    }
  });

  const primitiveReports = [];
  let texturedPrimitiveCount = 0, untexturedPrimitiveCount = 0, uvAttributeCount = 0, uvVertexCount = 0;
  const reportedUvAccessors = new Map();
  const reportedPositionAccessors = new Map();
  (gltf.meshes ?? []).forEach((mesh,meshIndex) => {
    if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) {
      errors.push(`mesh-${meshIndex}-has-no-primitives`);
      return;
    }
    mesh.primitives.forEach((primitive,primitiveIndex) => {
      const key = `mesh-${meshIndex}-primitive-${primitiveIndex}`;
      if ((primitive.mode ?? 4) !== 4) {
        warnings.push(`${key}-not-triangles-texture-audit-limited`);
        return;
      }
      const positionIndex = primitive.attributes?.POSITION;
      const position = accessors[positionIndex];
      if (!position || position.type !== "VEC3" || !Number.isSafeInteger(position.count) || position.count < 1) {
        errors.push(`${key}-missing-or-invalid-position-accessor`);
      }
      const materialIndex = primitive.material;
      if (materialIndex !== undefined && (!Number.isSafeInteger(materialIndex) || !materials[materialIndex])) {
        errors.push(`${key}-invalid-material-index`);
      }
      const material = Number.isSafeInteger(materialIndex) ? materials[materialIndex] : null;
      const refs = material ? materialTextureRefs(material) : [];
      const report = { meshIndex, primitiveIndex, materialIndex:materialIndex ?? null, textureBindings:[], uvAttributes:[], uvSeamReviews:[] };
      const seamReviewByTexCoord = new Map();
      if (refs.length === 0) {
        untexturedPrimitiveCount++;
        warnings.push(`${key}-no-supported-material-textures`);
      } else {
        texturedPrimitiveCount++;
        refs.forEach((ref) => {
          const textureIndex = ref.index;
          if (!Number.isSafeInteger(textureIndex) || !textures[textureIndex]) {
            errors.push(`${key}-${ref.property}-references-invalid-texture`);
            report.textureBindings.push({ property:ref.property, textureIndex:textureIndex ?? null, valid:false });
            return;
          }
          const sourceIndex = validTextureImage.get(textureIndex);
          const texCoord = ref.texCoord ?? 0;
          if (!Number.isSafeInteger(texCoord) || texCoord < 0 || texCoord > 7) {
            errors.push(`${key}-${ref.property}-invalid-texCoord-set`);
            report.textureBindings.push({ property:ref.property, textureIndex, sourceImageIndex:sourceIndex ?? null, valid:false });
            return;
          }
          const accessorIndex = primitive.attributes?.[`TEXCOORD_${texCoord}`];
          const uvAccessor = accessors[accessorIndex];
          if (!uvAccessor) {
            errors.push(`${key}-missing-TEXCOORD_${texCoord}`);
            report.textureBindings.push({ property:ref.property, textureIndex, sourceImageIndex:sourceIndex ?? null, texCoord, valid:false });
            return;
          }
          let uv = reportedUvAccessors.get(accessorIndex);
          if (!uv) {
            uv = readUvAccessor(uvAccessor,views,binary,bufferLength,`${key}-TEXCOORD_${texCoord}`,errors);
            reportedUvAccessors.set(accessorIndex,uv);
            if (uv) { uvAttributeCount++; uvVertexCount += uv.count; }
          }
          if (uv && position?.count !== uv.count) errors.push(`${key}-TEXCOORD_${texCoord}-count-does-not-match-POSITION`);
          const indexAccessor = primitive.indices === undefined ? null : accessors[primitive.indices];
          if (primitive.indices !== undefined && !indexAccessor) errors.push(`${key}-invalid-index-accessor-reference`);
          const indices = !indexAccessor ? Array.from({length:position?.count ?? 0},(_,i)=>i) :
            readIndexAccessor(indexAccessor,views,binary,bufferLength,position?.count ?? 0,key,errors);
          let degenerateUvTriangles = 0;
          let uvSeamReview = null;
          if (uv && indices && !uv.nonFiniteCount && position?.count === uv.count) {
            for (let i=0;i+2<indices.length;i+=3) {
              const a=uv.values[indices[i]], b=uv.values[indices[i+1]], c=uv.values[indices[i+2]];
              if (!a||!b||!c || [ ...a,...b,...c ].some(n=>!finite(n))) continue;
              const area=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))*0.5;
              if (area <= 1e-12) degenerateUvTriangles++;
            }
            if (degenerateUvTriangles) warnings.push(`${key}-degenerate-uv-triangles`);
            if (!seamReviewByTexCoord.has(texCoord)) {
              let positionData = reportedPositionAccessors.get(positionIndex);
              if (!positionData) {
                positionData = readPositionAccessor(position,views,binary,bufferLength,`${key}-POSITION`,errors);
                reportedPositionAccessors.set(positionIndex,positionData);
              }
              if (positionData && positionData.count === uv.count) {
                try {
                  const review = reviewUvSeams({ positions:positionData.values, uvs:uv.values, indices }, options.uvSeamReview ?? {});
                  seamReviewByTexCoord.set(texCoord,review);
                  report.uvSeamReviews.push({ texCoord, ...review });
                  if (review.seamCandidateCount > 0) warnings.push(`${key}-uv-seam-review-candidates-present`);
                } catch (error) {
                  errors.push(`${key}-uv-seam-review-failed`);
                }
              }
            }
            uvSeamReview = seamReviewByTexCoord.get(texCoord) ?? null;
          }
          report.textureBindings.push({ property:ref.property, textureIndex, sourceImageIndex:sourceIndex ?? null, texCoord, valid:Boolean(uv && sourceIndex !== undefined), uvBounds:uv?.bounds ?? null, degenerateUvTriangles, uvSeamCandidateCount:uvSeamReview?.seamCandidateCount ?? null });
        });
      }
      report.uvAttributes = Object.keys(primitive.attributes ?? {}).filter(name=>/^TEXCOORD_\d+$/.test(name));
      primitiveReports.push(report);
    });
  });

  if (!(gltf.images ?? []).length) warnings.push("no-images-declared");
  if (!textures.length) warnings.push("no-textures-declared");
  if (!materials.length) warnings.push("no-materials-declared");
  if (untexturedPrimitiveCount > 0) warnings.push("one-or-more-primitives-untextured");
  if (usedImageIndices.size < images.length) warnings.push("one-or-more-images-unused-by-textures");
  if (warnings.some((warning)=>warning.endsWith("-external-uri"))) warnings.push("model-is-not-fully-self-contained");

  const expected = options.expectedAtlas;
  if (expected) {
    const expectedHash = typeof expected.sha256 === "string" ? expected.sha256.toLowerCase() : null;
    const matches = images.filter((image)=>image.sha256 && expectedHash && image.sha256 === expectedHash);
    if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) errors.push("expected-atlas-sha256-invalid");
    else if (matches.length === 0) errors.push("expected-atlas-not-embedded-in-glb");
    else {
      const matched = matches[0];
      if (Number.isSafeInteger(expected.width) && matched.width !== expected.width) errors.push("embedded-atlas-width-does-not-match-manifest");
      if (Number.isSafeInteger(expected.height) && matched.height !== expected.height) errors.push("embedded-atlas-height-does-not-match-manifest");
    }
  }

  return {
    schemaVersion:"1.0.0",
    engine:"glb-texture-binding-qa-v1",
    status:errors.length ? "failed" : warnings.length ? "review-recommended" : "texture-bindings-structurally-valid",
    valid:errors.length === 0,
    publicationEligible:false,
    counts:{ meshCount:gltf.meshes?.length ?? 0, materialCount:materials.length, textureCount:textures.length, imageCount:images.length,
      texturedPrimitiveCount, untexturedPrimitiveCount, uvAccessorCount:uvAttributeCount, uvVertexCount,
      uvSeamCandidateCount:primitiveReports.reduce((sum, item) => sum + item.uvSeamReviews.reduce((part, review) => part + review.seamCandidateCount, 0), 0),
      textureContentRiskCount:images.reduce((sum, image) => sum + (image.contentReview?.risks?.length ?? 0), 0) },
    images, primitiveReports, errors:[...new Set(errors)], warnings:[...new Set(warnings)],
    limitations:[
      "This audit validates glTF resource references and UV numeric ranges; it does not render the model or determine whether the photo belongs to the corresponding facade.",
      "Texture seams, wrong orientation, blur, lighting mismatch, perspective distortion and architectural fidelity require rendered visual review.",
      "UV-overlap analysis is intentionally not used to reject overlapping UVs because some models intentionally share texture regions.",
      "Publication eligibility remains false until geometry, scale, provenance and visual review gates pass."
    ]
  };
}
