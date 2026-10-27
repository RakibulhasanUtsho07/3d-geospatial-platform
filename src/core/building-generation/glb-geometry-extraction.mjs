const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const EPSILON = 1e-12;
const MAX_VERTICES = 2_000_000;
const MAX_TRIANGLES = 4_000_000;
const MAX_REVIEW_VERTICES = 25_000;
const MAX_REVIEW_TRIANGLES = 8_333;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(label + " must be an integer >= " + minimum + ".");
  return value;
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(label + " must be finite.");
  return value;
}
function clean(value) {
  const rounded = Number(value.toFixed(9));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Column-major affine matrix; the evaluation frame is metre-based. */
export function validateAffineMatrix4x4(raw, label = "modelToEvaluationFrameMatrix4x4") {
  if (!Array.isArray(raw) || raw.length !== 16) throw new TypeError(label + " must contain 16 column-major numbers.");
  const m = raw.map((value, i) => finite(value, label + "[" + i + "]"));
  if (Math.abs(m[3]) > EPSILON || Math.abs(m[7]) > EPSILON || Math.abs(m[11]) > EPSILON || Math.abs(m[15] - 1) > EPSILON) {
    throw new TypeError(label + " must be affine (last row 0,0,0,1).");
  }
  const determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) -
    m[4] * (m[1] * m[10] - m[9] * m[2]) +
    m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (Math.abs(determinant) <= EPSILON) throw new TypeError(label + " must be invertible.");
  return m;
}
function multiply4(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  }
  return out;
}
function nodeMatrix(node, label) {
  if (node.matrix !== undefined) return validateAffineMatrix4x4(node.matrix, label + ".matrix");
  const t = (node.translation ?? [0, 0, 0]).map((v, i) => finite(v, label + ".translation[" + i + "]"));
  const s = (node.scale ?? [1, 1, 1]).map((v, i) => finite(v, label + ".scale[" + i + "]"));
  const q = (node.rotation ?? [0, 0, 0, 1]).map((v, i) => finite(v, label + ".rotation[" + i + "]"));
  if (t.length !== 3 || s.length !== 3 || q.length !== 4) throw new TypeError(label + " has malformed TRS values.");
  if (s.some((v) => Math.abs(v) <= EPSILON)) throw new TypeError(label + " has a zero scale.");
  const norm = Math.hypot(...q);
  if (norm <= EPSILON) throw new TypeError(label + " has a zero quaternion.");
  const x = q[0] / norm, y = q[1] / norm, z = q[2] / norm, w = q[3] / norm;
  const xx = x*x, yy = y*y, zz = z*z, xy = x*y, xz = x*z, yz = y*z, wx = w*x, wy = w*y, wz = w*z;
  return [
    (1-2*(yy+zz))*s[0], (2*(xy+wz))*s[0], (2*(xz-wy))*s[0], 0,
    (2*(xy-wz))*s[1], (1-2*(xx+zz))*s[1], (2*(yz+wx))*s[1], 0,
    (2*(xz+wy))*s[2], (2*(yz-wx))*s[2], (1-2*(xx+yy))*s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function transformPoint(m, p, label) {
  const x = m[0]*p[0] + m[4]*p[1] + m[8]*p[2] + m[12];
  const y = m[1]*p[0] + m[5]*p[1] + m[9]*p[2] + m[13];
  const z = m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14];
  const w = m[3]*p[0] + m[7]*p[1] + m[11]*p[2] + m[15];
  if (!Number.isFinite(w) || Math.abs(w) <= EPSILON) throw new TypeError(label + " created an invalid homogeneous coordinate.");
  const result = [x/w, y/w, z/w].map(clean);
  if (result.some((v) => !Number.isFinite(v))) throw new TypeError(label + " produced a non-finite vertex.");
  return result;
}
function parseGlb(input) {
  if (!(Buffer.isBuffer(input) || input instanceof Uint8Array)) throw new TypeError("GLB input must be a Buffer or Uint8Array.");
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 20) throw new TypeError("GLB is too short.");
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw new TypeError("GLB magic is invalid.");
  if (bytes.readUInt32LE(4) !== 2) throw new TypeError("Only GLB 2.0 is supported.");
  if (bytes.readUInt32LE(8) !== bytes.length) throw new TypeError("GLB declared length does not match its byte length.");
  let offset = 12, jsonBytes = null, binBytes = null, first = true;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new TypeError("GLB has a truncated chunk header.");
    const size = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + size;
    if (size % 4 !== 0 || end > bytes.length) throw new TypeError("GLB chunk is unaligned or out of bounds.");
    if (first && type !== JSON_CHUNK) throw new TypeError("GLB must start with a JSON chunk.");
    first = false;
    if (type === JSON_CHUNK) {
      if (jsonBytes) throw new TypeError("GLB must contain exactly one JSON chunk.");
      jsonBytes = bytes.subarray(start, end);
    } else if (type === BIN_CHUNK) {
      if (binBytes) throw new TypeError("GLB must contain at most one BIN chunk.");
      binBytes = bytes.subarray(start, end);
    }
    offset = end;
  }
  if (offset !== bytes.length || !jsonBytes) throw new TypeError("GLB JSON chunk is missing.");
  let doc;
  try { doc = JSON.parse(jsonBytes.toString("utf8").replace(/[\u0000 ]+$/u, "").trim()); }
  catch { throw new TypeError("GLB JSON chunk is invalid."); }
  if (!isObject(doc) || doc.asset?.version !== "2.0") throw new TypeError("GLB JSON must declare asset.version 2.0.");
  if (doc.animations?.length) throw new TypeError("Animated GLBs must be exported as a static pose first.");
  if (!Array.isArray(doc.buffers) || doc.buffers.length !== 1 || !isObject(doc.buffers[0])) throw new TypeError("Only one embedded GLB buffer is supported.");
  if (doc.buffers[0].uri !== undefined) throw new TypeError("External/data-URI buffers are unsupported; geometry must be embedded.");
  if (!binBytes) throw new TypeError("GLB BIN chunk is missing.");
  const declaredBufferLength = integer(doc.buffers[0].byteLength, "buffers[0].byteLength", 1);
  if (declaredBufferLength > binBytes.length) throw new TypeError("GLB BIN chunk is shorter than the declared buffer.");
  return { doc, binBytes, declaredBufferLength };
}
function makeReader(parsed) {
  const { doc, binBytes, declaredBufferLength } = parsed;
  function viewFor(accessor, label) {
    if (accessor.sparse !== undefined) throw new TypeError(label + " uses sparse accessors, which are unsupported.");
    const view = doc.bufferViews?.[integer(accessor.bufferView, label + ".bufferView")];
    if (!isObject(view)) throw new TypeError(label + " references a missing bufferView.");
    if ((view.buffer ?? 0) !== 0) throw new TypeError(label + " references a non-embedded buffer.");
    if (view.extensions?.EXT_meshopt_compression) throw new TypeError(label + " uses meshopt compression, unsupported by this adapter.");
    const offset = integer(view.byteOffset ?? 0, label + " bufferView offset");
    const length = integer(view.byteLength, label + " bufferView length", 1);
    if (offset + length > declaredBufferLength || offset + length > binBytes.length) throw new TypeError(label + " bufferView exceeds BIN bounds.");
    return { view, offset, length };
  }
  function positions(index, label) {
    const accessor = doc.accessors?.[integer(index, label + " POSITION accessor")];
    if (!isObject(accessor) || accessor.type !== "VEC3" || accessor.componentType !== 5126 || accessor.normalized === true) {
      throw new TypeError(label + " POSITION must be a non-normalized FLOAT VEC3 accessor.");
    }
    const count = integer(accessor.count, label + " POSITION count", 1);
    if (count > MAX_VERTICES) throw new RangeError(label + " exceeds the source vertex limit.");
    const info = viewFor(accessor, label + " POSITION");
    const relative = integer(accessor.byteOffset ?? 0, label + " POSITION offset");
    const stride = integer(info.view.byteStride ?? 12, label + " POSITION stride", 12);
    if (relative % 4 || stride % 4 || stride > 252 || relative + (count-1)*stride + 12 > info.length) {
      throw new TypeError(label + " POSITION accessor is misaligned or out of bounds.");
    }
    const values = [];
    for (let i=0;i<count;i++) {
      const at = info.offset + relative + i*stride;
      const p = [binBytes.readFloatLE(at),binBytes.readFloatLE(at+4),binBytes.readFloatLE(at+8)];
      if (p.some((v)=>!Number.isFinite(v))) throw new TypeError(label + " POSITION contains non-finite values.");
      values.push(p);
    }
    return values;
  }
  function indices(index, vertexCount, label) {
    if (index === undefined) return Array.from({length:vertexCount},(_,i)=>i);
    const accessor = doc.accessors?.[integer(index,label+" indices accessor")];
    if (!isObject(accessor) || accessor.type!=="SCALAR" || ![5121,5123,5125].includes(accessor.componentType) || accessor.normalized===true) {
      throw new TypeError(label + " indices must be an unsigned byte/short/int SCALAR accessor.");
    }
    const count = integer(accessor.count,label+" index count",1);
    if (count > MAX_TRIANGLES*3) throw new RangeError(label+" exceeds index safety limit.");
    const info = viewFor(accessor,label+" indices");
    if (info.view.byteStride !== undefined) throw new TypeError(label+" index bufferView cannot have byteStride.");
    const width = accessor.componentType===5121 ? 1 : accessor.componentType===5123 ? 2 : 4;
    const relative = integer(accessor.byteOffset??0,label+" index offset");
    if (relative%width || relative+count*width>info.length) throw new TypeError(label+" index accessor is misaligned or out of bounds.");
    const result=[];
    for(let i=0;i<count;i++){
      const at=info.offset+relative+i*width;
      const value=width===1?binBytes.readUInt8(at):width===2?binBytes.readUInt16LE(at):binBytes.readUInt32LE(at);
      if(value>=vertexCount) throw new TypeError(label+" index references a missing vertex.");
      result.push(value);
    }
    return result;
  }
  return { positions, indices };
}
function triangulate(ids, mode, label) {
  if (mode === 4) {
    if (ids.length<3 || ids.length%3!==0) throw new TypeError(label+" TRIANGLES index count must be a multiple of three.");
    const result=[]; for(let i=0;i<ids.length;i+=3) result.push([ids[i],ids[i+1],ids[i+2]]);
    return result;
  }
  if (mode===5) {
    if(ids.length<3) throw new TypeError(label+" TRIANGLE_STRIP needs at least three indexes.");
    const result=[]; for(let i=2;i<ids.length;i++) result.push(i%2===0?[ids[i-2],ids[i-1],ids[i]]:[ids[i-1],ids[i-2],ids[i]]);
    return result;
  }
  if (mode===6) {
    if(ids.length<3) throw new TypeError(label+" TRIANGLE_FAN needs at least three indexes.");
    const result=[]; for(let i=2;i<ids.length;i++) result.push([ids[0],ids[i-1],ids[i]]);
    return result;
  }
  return null;
}
function assertTriangle(a,b,c,label) {
  const ab=[b[0]-a[0],b[1]-a[1],b[2]-a[2]], ac=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
  const cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
  if(Math.hypot(...cross)<=EPSILON) throw new TypeError(label+" contains a degenerate triangle.");
}
function hullXZ(vertices) {
  const unique=new Map();
  for(const p of vertices) unique.set(p[0]+","+p[2],{x:p[0],z:p[2]});
  const points=[...unique.values()].sort((a,b)=>a.x-b.x||a.z-b.z);
  if(points.length<3) throw new TypeError("Mesh has fewer than three distinct X/Z projected vertices.");
  const cross=(o,a,b)=>(a.x-o.x)*(b.z-o.z)-(a.z-o.z)*(b.x-o.x);
  const lower=[]; for(const p of points){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=EPSILON)lower.pop();lower.push(p);}
  const upper=[]; for(let i=points.length-1;i>=0;i--){const p=points[i];while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=EPSILON)upper.pop();upper.push(p);}
  lower.pop(); upper.pop(); const hull=[...lower,...upper];
  if(hull.length<3||hull.length>500) throw new RangeError("Projected convex hull must contain 3-500 vertices; complex outlines require a reviewed footprint.");
  let area2=0; for(let i=0;i<hull.length;i++){const a=hull[i],b=hull[(i+1)%hull.length];area2+=a.x*b.z-b.x*a.z;}
  if(Math.abs(area2)<=EPSILON)throw new TypeError("Mesh projected to X/Z has zero footprint area.");
  return hull.map(p=>({x:clean(p.x),z:clean(p.z)}));
}
function sampleSurface(vertices, triangles) {
  const total=triangles.length, count=Math.min(total,MAX_REVIEW_TRIANGLES), outVertices=[],outTriangles=[];
  for(let i=0;i<count;i++){
    const triangle=triangles[Math.floor(i*(total-1)/Math.max(1,count-1))];
    const next=triangle.map(id=>{outVertices.push(vertices[id]);return outVertices.length-1;});
    outTriangles.push(next);
  }
  if(outVertices.length>MAX_REVIEW_VERTICES || !outTriangles.length) throw new RangeError("Review mesh exceeds sample safety limits.");
  return {vertices:outVertices.map(p=>p.map(clean)),triangles:outTriangles,
    sampling:{method:"evenly-spaced-triangle-index-sampling-v1",totalVertexCount:vertices.length,totalTriangleCount:total,
      sampledVertexCount:outVertices.length,sampledTriangleCount:outTriangles.length,
      maxVertexCount:MAX_REVIEW_VERTICES,maxTriangleCount:MAX_REVIEW_TRIANGLES}};
}

/**
 * Reads actual GLB bytes. Scene-node transforms are applied before the explicit
 * source-to-evaluation affine transform. Output uses X/Z horizontal, Y vertical.
 */
export function extractGlbGeometry(input, options={}) {
  if(typeof options.coordinateFrameId!=="string"||!options.coordinateFrameId.trim())throw new TypeError("coordinateFrameId is required.");
  if(options.units!=="m")throw new TypeError("GLB geometry must be evaluated in metres.");
  const registration=validateAffineMatrix4x4(options.modelToEvaluationFrameMatrix4x4);
  const parsed=parseGlb(input), {doc}=parsed, reader=makeReader(parsed);
  if(!Array.isArray(doc.nodes)||!doc.nodes.length||!Array.isArray(doc.meshes)||!doc.meshes.length)throw new TypeError("GLB scene nodes and meshes are required.");
  for(const node of doc.nodes)if(node?.skin!==undefined||node?.weights!==undefined)throw new TypeError("Skinned/morph animated geometry is unsupported.");
  for(const mesh of doc.meshes)if(mesh?.weights!==undefined)throw new TypeError("Morph-target meshes are unsupported.");
  let roots;
  if(Array.isArray(doc.scenes)&&doc.scenes.length){
    const scene=doc.scenes[integer(doc.scene??0,"default scene index")];
    if(!isObject(scene)||!Array.isArray(scene.nodes))throw new TypeError("Default GLB scene has no node list.");
    roots=scene.nodes;
  }else{
    const children=new Set();for(const node of doc.nodes)for(const child of node.children??[])children.add(integer(child,"node child index"));
    roots=doc.nodes.map((_,i)=>i).filter(i=>!children.has(i));
  }
  if(!roots.length)throw new TypeError("GLB scene contains no root nodes.");
  const vertices=[],triangles=[],skippedNonTrianglePrimitives=[],active=new Set(),visited=new Set();
  function visit(nodeIndex,parent){
    nodeIndex=integer(nodeIndex,"scene node index");const node=doc.nodes[nodeIndex];
    if(!isObject(node))throw new TypeError("GLB scene references a missing node.");
    if(active.has(nodeIndex))throw new TypeError("GLB node graph contains a cycle.");
    if(visited.has(nodeIndex))throw new TypeError("GLB node has multiple parents or is reused by multiple scene roots.");
    visited.add(nodeIndex);active.add(nodeIndex);
    const world=multiply4(parent,nodeMatrix(node,"nodes["+nodeIndex+"]")), frame=multiply4(registration,world);
    if(node.mesh!==undefined){
      const meshIndex=integer(node.mesh,"node mesh index"),mesh=doc.meshes[meshIndex];
      if(!isObject(mesh)||!Array.isArray(mesh.primitives)||!mesh.primitives.length)throw new TypeError("GLB node references an empty or missing mesh.");
      for(let pi=0;pi<mesh.primitives.length;pi++){
        const primitive=mesh.primitives[pi],label="mesh["+meshIndex+"].primitive["+pi+"]";
        if(!isObject(primitive)||!isObject(primitive.attributes)||!Number.isSafeInteger(primitive.attributes.POSITION))throw new TypeError(label+" has no POSITION accessor.");
        if(primitive.targets?.length||primitive.extensions?.KHR_draco_mesh_compression)throw new TypeError(label+" uses morph targets or Draco compression, unsupported by this adapter.");
        const mode=primitive.mode??4;
        if(![4,5,6].includes(mode)){skippedNonTrianglePrimitives.push({nodeIndex,meshIndex,primitiveIndex:pi,mode});continue;}
        const positions=reader.positions(primitive.attributes.POSITION,label),ids=reader.indices(primitive.indices,positions.length,label);
        const localTriangles=triangulate(ids,mode,label);
        if(localTriangles.length>MAX_TRIANGLES)throw new RangeError(label+" exceeds triangle safety limit.");
        const needed=[...new Set(localTriangles.flat())].sort((a,b)=>a-b), remap=new Map();
        for(const index of needed){
          remap.set(index,vertices.length);vertices.push(transformPoint(frame,positions[index],label));
          if(vertices.length>MAX_VERTICES)throw new RangeError("GLB exceeds total source vertex safety limit.");
        }
        for(const face of localTriangles){
          const ids3=face.map(index=>remap.get(index));assertTriangle(vertices[ids3[0]],vertices[ids3[1]],vertices[ids3[2]],label);
          triangles.push(ids3);if(triangles.length>MAX_TRIANGLES)throw new RangeError("GLB exceeds total source triangle safety limit.");
        }
      }
    }
    for(const child of node.children??[])visit(child,world);
    active.delete(nodeIndex);
  }
  for(const root of roots)visit(root,IDENTITY);
  if(vertices.length<3||triangles.length<1)throw new TypeError("GLB contains no supported triangle geometry.");
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const p of vertices)for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis],p[axis]);max[axis]=Math.max(max[axis],p[axis]);}
  const dimensionsM={widthM:clean(max[0]-min[0]),heightM:clean(max[1]-min[1]),depthM:clean(max[2]-min[2])};
  if(Object.values(dimensionsM).some(v=>v<=EPSILON))throw new TypeError("Transformed GLB bounds must have positive width, height and depth.");
  const surface=sampleSurface(vertices,triangles);
  return {
    coordinateFrameId:options.coordinateFrameId,units:"m",footprint:hullXZ(vertices),dimensionsM,checkPoints:[],
    surfaceMesh:{vertices:surface.vertices,triangles:surface.triangles},
    extractionSummary:{
      glbVersion:"2.0",coordinateFrameId:options.coordinateFrameId,units:"m",
      axisConvention:"X/Z horizontal, Y vertical",
      transformConvention:"modelToEvaluationFrameMatrix4x4 * accumulated GLB scene-node transforms",
      modelToEvaluationFrameMatrix4x4:registration,
      sourceVertexCount:vertices.length,sourceTriangleCount:triangles.length,
      surfaceSampling:surface.sampling,skippedNonTrianglePrimitives,
      footprintMethod:"convex-hull of mesh triangle vertices projected to X/Z; provisional envelope, not a surveyed wall footprint",
      dimensionsMethod:"axis-aligned extents of transformed triangle-referenced vertices in the registered frame",
    },
  };
}
