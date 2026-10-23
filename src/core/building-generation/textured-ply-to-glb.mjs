import { readFile, stat } from "node:fs/promises";

const TYPE_INFO = {
  char: [1, "readInt8"], int8: [1, "readInt8"], uchar: [1, "readUInt8"], uint8: [1, "readUInt8"],
  short: [2, "readInt16LE"], int16: [2, "readInt16LE"], ushort: [2, "readUInt16LE"], uint16: [2, "readUInt16LE"],
  int: [4, "readInt32LE"], int32: [4, "readInt32LE"], uint: [4, "readUInt32LE"], uint32: [4, "readUInt32LE"],
  float: [4, "readFloatLE"], float32: [4, "readFloatLE"], double: [8, "readDoubleLE"], float64: [8, "readDoubleLE"],
};
function parseHeader(buffer) {
  const marker = buffer.indexOf(Buffer.from("end_header"));
  if (marker < 0 || marker > 1024 * 1024) throw new TypeError("PLY header is missing or too large");
  const headerText = buffer.toString("ascii", 0, marker);
  const lines = headerText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== "ply") throw new TypeError("not a PLY file");
  const formatLine = lines.find(line => line.startsWith("format "))?.split(/\s+/);
  if (!formatLine || !["ascii", "binary_little_endian"].includes(formatLine[1]) || formatLine[2] !== "1.0") throw new TypeError("PLY must use ASCII or binary_little_endian format version 1.0");
  const elements = []; let current = null;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts[0] === "element") {
      const count = Number(parts[2]);
      if (!Number.isSafeInteger(count) || count < 0 || count > 20_000_000) throw new RangeError("invalid PLY element count");
      current = { name: parts[1], count, properties: [] }; elements.push(current);
    } else if (parts[0] === "property" && current) {
      if (parts[1] === "list") {
        if (parts.length !== 5 || !TYPE_INFO[parts[2]] || !TYPE_INFO[parts[3]]) throw new TypeError("unsupported PLY list property");
        current.properties.push({ list: true, countType: parts[2], itemType: parts[3], name: parts[4] });
      } else {
        if (parts.length !== 3 || !TYPE_INFO[parts[1]]) throw new TypeError("unsupported PLY scalar property");
        current.properties.push({ list: false, type: parts[1], name: parts[2] });
      }
    }
  }
  let bodyOffset = marker + Buffer.byteLength("end_header", "ascii");
  if (buffer[bodyOffset] === 13) bodyOffset++;
  if (buffer[bodyOffset] === 10) bodyOffset++;
  return { format: formatLine[1], elements, bodyOffset };
}
function parsePlyBuffer(buffer, maxBytes = 500 * 1024 * 1024) {
  if (!Buffer.isBuffer(buffer) || buffer.length > maxBytes) throw new RangeError("PLY must be a buffer within the mesh-size limit");
  const header = parseHeader(buffer), vertices = [], faces = [];
  let offset = header.bodyOffset, tokenIndex = 0;
  const tokens = header.format === "ascii" ? buffer.toString("utf8", header.bodyOffset).trim().split(/\s+/) : null;
  const readScalar = type => {
    if (header.format === "ascii") {
      if (tokenIndex >= tokens.length) throw new TypeError("truncated ASCII PLY data");
      const value = Number(tokens[tokenIndex++]);
      if (!Number.isFinite(value)) throw new TypeError("non-finite number in PLY data");
      return value;
    }
    const [size, method] = TYPE_INFO[type];
    if (offset + size > buffer.length) throw new TypeError("truncated binary PLY data");
    const value = buffer[method](offset); offset += size;
    if (!Number.isFinite(value)) throw new TypeError("non-finite number in PLY data");
    return value;
  };
  for (const element of header.elements) {
    for (let row = 0; row < element.count; row++) {
      const values = {};
      for (const property of element.properties) {
        if (property.list) {
          const count = readScalar(property.countType);
          if (!Number.isInteger(count) || count < 0 || count > 100_000) throw new RangeError("invalid PLY list length");
          const list = [];
          for (let i = 0; i < count; i++) list.push(readScalar(property.itemType));
          if (element.name === "face" && ["vertex_indices", "vertex_index", "vertex_ids"].includes(property.name)) values.indices = list;
          else if (element.name === "face" && ["texcoord", "texcoords", "texture_coordinates"].includes(property.name)) values.texcoord = list;
        } else {
          const value = readScalar(property.type);
          if (element.name === "vertex" && ["x", "y", "z", "nx", "ny", "nz", "u", "v"].includes(property.name)) values[property.name] = value;
        }
      }
      if (element.name === "vertex") vertices.push(values);
      if (element.name === "face") faces.push(values);
    }
  }
  if (vertices.length < 3 || faces.length < 1) throw new RangeError("textured PLY must contain vertices and faces");
  if (vertices.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z))) throw new TypeError("PLY vertex positions are incomplete");
  return { vertices, faces };
}
function unitNormal(a, b, c) {
  const u=[b[0]-a[0],b[1]-a[1],b[2]-a[2]],v=[c[0]-a[0],c[1]-a[1],c[2]-a[2]];
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],len=Math.hypot(...n)||1;
  return n.map(x=>x/len);
}
function transformAxis(p, upAxis) {
  if (upAxis === "Y") return [p[0], p[1], p[2]];
  if (upAxis === "Z") return [p[0], p[2], -p[1]];
  return [-p[1], p[0], p[2]];
}
function normalize(v) { const len=Math.hypot(...v)||1; return v.map(x=>x/len); }
function writeBuffer(values, type) {
  const size=type==="uint16"?2:4,buffer=Buffer.alloc(values.length*size);
  values.forEach((value,i)=>{if(type==="float32")buffer.writeFloatLE(value,i*4);else if(type==="uint16")buffer.writeUInt16LE(value,i*2);else buffer.writeUInt32LE(value,i*4);});
  return buffer;
}
function makeGlb(positions,normals,uvs,texturePng,metresPerModelUnit,upAxis,scaleCalibrated) {
  const bmin=[Infinity,Infinity,Infinity],bmax=[-Infinity,-Infinity,-Infinity],transformed=[];
  for(let i=0;i<positions.length;i+=3){
    const p=transformAxis([positions[i],positions[i+1],positions[i+2]],upAxis).map(v=>v*metresPerModelUnit);
    for(let a=0;a<3;a++){bmin[a]=Math.min(bmin[a],p[a]);bmax[a]=Math.max(bmax[a],p[a]);}
    transformed.push(p);
  }
  const centerX=(bmin[0]+bmax[0])/2,centerZ=(bmin[2]+bmax[2])/2,groundY=bmin[1];
  const outputPositions=transformed.flatMap(p=>[p[0]-centerX,p[1]-groundY,p[2]-centerZ]),outputNormals=[];
  for(let i=0;i<normals.length;i+=3)outputNormals.push(...normalize(transformAxis([normals[i],normals[i+1],normals[i+2]],upAxis)));
  const uvsOut=uvs,indices=Array.from({length:outputPositions.length/3},(_,i)=>i),useShort=indices.length<=65535;
  const chunks=[],views=[],accessors=[];let offset=0;
  function addView(data,target){const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}const view={buffer:0,byteOffset:offset,byteLength:data.length};if(target)view.target=target;views.push(view);chunks.push(data);offset+=data.length;return views.length-1;}
  function addAccessor(bufferView,componentType,count,type,extra={}){accessors.push({bufferView,byteOffset:0,componentType,count,type,...extra});return accessors.length-1;}
  const pmin=[Infinity,Infinity,Infinity],pmax=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<outputPositions.length;i+=3)for(let a=0;a<3;a++){pmin[a]=Math.min(pmin[a],outputPositions[i+a]);pmax[a]=Math.max(pmax[a],outputPositions[i+a]);}
  const positionAccessor=addAccessor(addView(writeBuffer(outputPositions,"float32"),34962),5126,outputPositions.length/3,"VEC3",{min:pmin,max:pmax});
  const normalAccessor=addAccessor(addView(writeBuffer(outputNormals,"float32"),34962),5126,outputNormals.length/3,"VEC3");
  const uvAccessor=uvsOut.length?addAccessor(addView(writeBuffer(uvsOut,"float32"),34962),5126,uvsOut.length/2,"VEC2"):null;
  const indexAccessor=addAccessor(addView(writeBuffer(indices,useShort?"uint16":"uint32"),34963),useShort?5123:5125,indices.length,"SCALAR",{min:[0],max:[Math.max(0,indices.length-1)]});
  const hasTexture=Buffer.isBuffer(texturePng)&&texturePng.length>0;
  const imageView=hasTexture?addView(texturePng,undefined):null;
  const payloadLength=offset,binaryRaw=Buffer.concat(chunks),pad=(4-binaryRaw.length%4)%4,binary=pad?Buffer.concat([binaryRaw,Buffer.alloc(pad)]):binaryRaw;
  const attributes={POSITION:positionAccessor,NORMAL:normalAccessor};if(uvAccessor!==null)attributes.TEXCOORD_0=uvAccessor;
  const material=hasTexture?{name:"COLMAP Texture Atlas",pbrMetallicRoughness:{baseColorFactor:[1,1,1,1],baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:0.9},doubleSided:true}:{name:"Untextured Review Material",pbrMetallicRoughness:{baseColorFactor:[0.76,0.66,0.55,1],metallicFactor:0,roughnessFactor:0.95},doubleSided:true};
  const gltf={asset:{version:"2.0",generator:"Dhaka Building Generation Engine / COLMAP mesh adapter",extras:{scaleCalibrated,metresPerModelUnit,sourceUpAxis:upAxis,textured:hasTexture}},scene:0,scenes:[{nodes:[0]}],nodes:[{name:"Photogrammetry Building Mesh",mesh:0}],meshes:[{name:hasTexture?"Textured Reconstruction":"Untextured Review Mesh",primitives:[{attributes,indices:indexAccessor,material:0,mode:4}]}],materials:[material],accessors,bufferViews:views,buffers:[{byteLength:payloadLength}]};
  if(hasTexture){gltf.textures=[{sampler:0,source:0}];gltf.samplers=[{magFilter:9729,minFilter:9987,wrapS:10497,wrapT:10497}];gltf.images=[{bufferView:imageView,mimeType:"image/png",name:"COLMAP Texture Atlas"}];}
  const jsonRaw=Buffer.from(JSON.stringify(gltf)),jsonPad=(4-jsonRaw.length%4)%4,json=Buffer.concat([jsonRaw,Buffer.alloc(jsonPad,0x20)]);
  const total=12+8+json.length+8+binary.length,header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(total,8);
  const jh=Buffer.alloc(8);jh.writeUInt32LE(json.length,0);jh.writeUInt32LE(0x4e4f534a,4);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(binary.length,0);bh.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jh,json,bh,binary]);
}

/** Convert COLMAP's textured mesh.ply + texture.png into a self-contained GLB. */
export async function convertTexturedPlyToGlb(options) {
  if(!options||typeof options!=="object")throw new TypeError("options are required");
  const metresPerModelUnit=options.metresPerModelUnit??1,upAxis=options.upAxis??"Z";
  if(typeof metresPerModelUnit!=="number"||!Number.isFinite(metresPerModelUnit)||metresPerModelUnit<=0||metresPerModelUnit>1000)throw new RangeError("metresPerModelUnit must be between 0 and 1000");
  if(!["X","Y","Z"].includes(upAxis))throw new TypeError("upAxis must be X, Y or Z");
  const plyStat=await stat(options.plyPath),textureStat=await stat(options.texturePath);
  if(plyStat.size<=0||plyStat.size>500*1024*1024)throw new RangeError("textured mesh must be non-empty and at most 500 MB");
  if(textureStat.size<=8||textureStat.size>100*1024*1024)throw new RangeError("texture must be non-empty and at most 100 MB");
  const [ply,texture]=await Promise.all([readFile(options.plyPath),readFile(options.texturePath)]);
  if(texture.subarray(0,8).compare(Buffer.from([137,80,78,71,13,10,26,10]))!==0)throw new TypeError("COLMAP texture must be a PNG image");
  const {vertices,faces}=parsePlyBuffer(ply),positions=[],normals=[],uvs=[];let triangleCount=0;
  const pFor=i=>{if(!Number.isInteger(i)||i<0||i>=vertices.length)throw new RangeError("PLY face references an invalid vertex index");const v=vertices[i];return [v.x,v.y,v.z];};
  for(const face of faces){
    const ids=face.indices;if(!ids||ids.length<3)throw new TypeError("each PLY face must contain at least three vertex indices");
    let faceUvs=face.texcoord;
    if(!faceUvs&&ids.every(i=>Number.isFinite(vertices[i]?.u)&&Number.isFinite(vertices[i]?.v)))faceUvs=ids.flatMap(i=>[vertices[i].u,vertices[i].v]);
    if(!faceUvs||faceUvs.length!==ids.length*2)throw new TypeError("PLY is missing per-face UV coordinates; use a COLMAP mesh_texturer output");
    for(let k=1;k<ids.length-1;k++){
      const corners=[0,k,k+1],pts=corners.map(ci=>pFor(ids[ci])),faceNormal=unitNormal(...pts);
      for(let corner=0;corner<3;corner++){
        const vertex=vertices[ids[corners[corner]]],n=[vertex.nx,vertex.ny,vertex.nz].every(Number.isFinite)?normalize([vertex.nx,vertex.ny,vertex.nz]):faceNormal;
        positions.push(...pts[corner]);normals.push(...n);
        const u=faceUvs[corners[corner]*2],v=faceUvs[corners[corner]*2+1];if(!Number.isFinite(u)||!Number.isFinite(v))throw new TypeError("PLY contains invalid UV coordinates");
        uvs.push(u,1-v);
      }
      triangleCount++;
    }
  }
  if(!triangleCount)throw new RangeError("PLY has no triangulatable surface faces");
  const glb=makeGlb(positions,normals,uvs,texture,metresPerModelUnit,upAxis,options.scaleCalibrated===true);
  return {glb,geometry:{vertices:positions.length/3,triangles:triangleCount,materials:1,textureBytes:texture.length},bounds:{sourceUpAxis:upAxis,metresPerModelUnit,scaleCalibrated:options.scaleCalibrated===true}};
}

/** Convert a mesh PLY to a neutral-material GLB when texturing is unavailable. */
export async function convertPlyToUntexturedGlb(options) {
  if(!options||typeof options!=="object")throw new TypeError("options are required");
  const metresPerModelUnit=options.metresPerModelUnit??1,upAxis=options.upAxis??"Z";
  if(typeof metresPerModelUnit!=="number"||!Number.isFinite(metresPerModelUnit)||metresPerModelUnit<=0||metresPerModelUnit>1000)throw new RangeError("metresPerModelUnit must be between 0 and 1000");
  if(!["X","Y","Z"].includes(upAxis))throw new TypeError("upAxis must be X, Y or Z");
  const plyStat=await stat(options.plyPath);
  if(plyStat.size<=0||plyStat.size>500*1024*1024)throw new RangeError("mesh must be non-empty and at most 500 MB");
  const ply=await readFile(options.plyPath),{vertices,faces}=parsePlyBuffer(ply),positions=[],normals=[];
  const pFor=i=>{if(!Number.isInteger(i)||i<0||i>=vertices.length)throw new RangeError("PLY face references an invalid vertex index");const v=vertices[i];return [v.x,v.y,v.z];};
  let triangleCount=0;
  for(const face of faces){
    const ids=face.indices;if(!ids||ids.length<3)throw new TypeError("each PLY face must contain at least three vertex indices");
    for(let k=1;k<ids.length-1;k++){
      const corners=[0,k,k+1],pts=corners.map(ci=>pFor(ids[ci])),faceNormal=unitNormal(...pts);
      for(let corner=0;corner<3;corner++){
        const vertex=vertices[ids[corners[corner]]],n=[vertex.nx,vertex.ny,vertex.nz].every(Number.isFinite)?normalize([vertex.nx,vertex.ny,vertex.nz]):faceNormal;
        positions.push(...pts[corner]);normals.push(...n);
      }
      triangleCount++;
    }
  }
  if(!triangleCount)throw new RangeError("PLY has no triangulatable surface faces");
  const glb=makeGlb(positions,normals,[],null,metresPerModelUnit,upAxis,options.scaleCalibrated===true);
  return {glb,geometry:{vertices:positions.length/3,triangles:triangleCount,materials:1,textureBytes:0,textured:false},bounds:{sourceUpAxis:upAxis,metresPerModelUnit,scaleCalibrated:options.scaleCalibrated===true}};
}
