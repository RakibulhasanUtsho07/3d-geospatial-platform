const GLB_MAGIC=0x46546c67,JSON_CHUNK=0x4e4f534a,BIN_CHUNK=0x004e4942;
const COMPONENT_BYTES={5121:1,5123:2,5125:4,5126:4};
const INDEX_READ={5121:"readUInt8",5123:"readUInt16LE",5125:"readUInt32LE"};
const TYPE_COMPONENTS={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16};

function finite(value){return Number.isFinite(value);}
function requireInt(value,label,min=0){
 if(!Number.isSafeInteger(value)||value<min)throw new TypeError(label+" must be a valid non-negative integer");
 return value;
}
function parseGlb(buffer){
 if(!Buffer.isBuffer(buffer)||buffer.length<20)throw new TypeError("GLB must be a Buffer containing a GLB 2.0 asset");
 if(buffer.readUInt32LE(0)!==GLB_MAGIC)throw new TypeError("invalid GLB magic");
 if(buffer.readUInt32LE(4)!==2)throw new TypeError("only GLB version 2 is supported");
 if(buffer.readUInt32LE(8)!==buffer.length)throw new TypeError("GLB declared total length does not match buffer length");
 let offset=12,gltf=null,binary=null;
 while(offset<buffer.length){
  if(offset+8>buffer.length)throw new TypeError("truncated GLB chunk header");
  const length=buffer.readUInt32LE(offset),type=buffer.readUInt32LE(offset+4);offset+=8;
  if(length%4!==0||offset+length>buffer.length)throw new TypeError("invalid or truncated GLB chunk length");
  const chunk=buffer.subarray(offset,offset+length);
  if(type===JSON_CHUNK){if(gltf)throw new TypeError("GLB contains multiple JSON chunks");if(offset!==20)throw new TypeError("GLB JSON chunk must be first");gltf=JSON.parse(chunk.toString("utf8").trim());}
  else if(type===BIN_CHUNK){if(binary)throw new TypeError("GLB contains multiple binary chunks");binary=chunk;}
  offset+=length;
 }
 if(!gltf||gltf.asset?.version!=="2.0")throw new TypeError("GLB has no valid glTF 2.0 JSON asset");
 if(!Array.isArray(gltf.meshes)||!gltf.meshes.length)throw new TypeError("GLB contains no meshes");
 const bufferDefs=gltf.buffers||[];
 if(bufferDefs.length>1)throw new TypeError("geometry QA supports one embedded GLB buffer");
 if(bufferDefs.some(def=>typeof def.uri==="string"))throw new TypeError("GLB references an external buffer instead of a self-contained binary chunk");
 if(bufferDefs.length&&(!binary||!Number.isSafeInteger(bufferDefs[0].byteLength)||bufferDefs[0].byteLength>binary.length))throw new TypeError("GLB binary chunk is missing or shorter than the declared buffer");
 return {gltf,binary,bufferLength:bufferDefs[0]?.byteLength??binary?.length??0};
}
function readAccessorBytes(accessor,views,binary,bufferLength,expectedType,label){
 if(!accessor||accessor.type!==expectedType)throw new TypeError(label+" accessor must use type "+expectedType);
 if(accessor.componentType!==5126)throw new TypeError(label+" accessor positions/normals must use float32 component type");
 if(accessor.sparse)throw new TypeError(label+" sparse accessors are not supported by this QA adapter");
 const view=views[accessor.bufferView];
 if(!view||view.buffer!==0)throw new TypeError(label+" accessor must reference the embedded GLB buffer");
 const count=requireInt(accessor.count,label+" count",1),accessorOffset=requireInt(accessor.byteOffset??0,label+" byteOffset");
 const viewOffset=requireInt(view.byteOffset??0,label+" bufferView byteOffset"),viewLength=requireInt(view.byteLength,label+" bufferView byteLength",1);
 const stride=view.byteStride??12;
 if(!Number.isSafeInteger(stride)||stride<12||stride>252||stride%4!==0)throw new TypeError(label+" bufferView has an invalid byteStride");
 const first=viewOffset+accessorOffset,required=first+(count-1)*stride+12;
 if(required>viewOffset+viewLength||required>bufferLength||required>binary.length)throw new TypeError(label+" accessor exceeds the binary buffer");
 return {count,first,stride};
}
function readPositions(accessor,views,binary,bufferLength,label,maxVertices){
 const data=readAccessorBytes(accessor,views,binary,bufferLength,"VEC3",label);
 if(data.count>maxVertices)throw new RangeError(label+" exceeds maximum geometry QA vertex count "+maxVertices);
 const positions=new Float32Array(data.count*3);
 for(let i=0;i<data.count;i++){
  const offset=data.first+i*data.stride;
  const x=binary.readFloatLE(offset),y=binary.readFloatLE(offset+4),z=binary.readFloatLE(offset+8);
  if(!finite(x)||!finite(y)||!finite(z))throw new TypeError(label+" contains a non-finite vertex coordinate at vertex "+i);
  positions[i*3]=x;positions[i*3+1]=y;positions[i*3+2]=z;
 }
 return positions;
}
function readIndices(accessor,views,binary,bufferLength,vertexCount,label){
 if(!accessor){
  if(vertexCount%3!==0)throw new TypeError(label+" non-indexed triangle vertex count is not divisible by 3");
  return {count:vertexCount,read:i=>i};
 }
 if(accessor.sparse)throw new TypeError(label+" sparse index accessors are not supported by this QA adapter");
 const bytes=COMPONENT_BYTES[accessor.componentType],method=INDEX_READ[accessor.componentType];
 if(!bytes||!method)throw new TypeError(label+" index accessor must use uint8, uint16 or uint32 components");
 if(accessor.type!=="SCALAR")throw new TypeError(label+" index accessor must be SCALAR");
 const view=views[accessor.bufferView];
 if(!view||view.buffer!==0)throw new TypeError(label+" indices must reference the embedded GLB buffer");
 const count=requireInt(accessor.count,label+" index count",1),viewOffset=requireInt(view.byteOffset??0,label+" index bufferView offset");
 const accessorOffset=requireInt(accessor.byteOffset??0,label+" index accessor offset"),viewLength=requireInt(view.byteLength,label+" index view length",1);
 const first=viewOffset+accessorOffset,end=first+count*bytes;
 if(end>viewOffset+viewLength||end>bufferLength||end>binary.length)throw new TypeError(label+" index accessor exceeds the binary buffer");
 if(count%3!==0)throw new TypeError(label+" triangle index count is not divisible by 3");
 return {count,read:i=>binary[method](first+i*bytes)};
}
function computeBounds(min,max){
 if(!min.every(finite)||!max.every(finite))throw new TypeError("model bounds are non-finite");
 const dimensions=min.map((value,index)=>max[index]-value);
 return {min,max,dimensions,units:"model-space-unverified"};
}

/** Structural/geometry QA for GLB 2.0 outputs. It checks mesh integrity, not architectural truth. */
export function analyzeGlbQuality(input,options={}){
 const {gltf,binary,bufferLength}=parseGlb(input),views=gltf.bufferViews||[],accessors=gltf.accessors||[];
 const maxVertices=options.maxVertices??5_000_000;
 if(!Number.isSafeInteger(maxVertices)||maxVertices<3||maxVertices>20_000_000)throw new RangeError("maxVertices must be between 3 and 20000000");
 let vertexCount=0,triangleCount=0,degenerateTriangleCount=0,primitiveCount=0,indexOutOfRangeCount=0;
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],warnings=[],meshDetails=[];
 for(let meshIndex=0;meshIndex<gltf.meshes.length;meshIndex++){
  const mesh=gltf.meshes[meshIndex];
  if(!Array.isArray(mesh.primitives)||!mesh.primitives.length)throw new TypeError("mesh "+meshIndex+" contains no primitives");
  for(let primitiveIndex=0;primitiveIndex<mesh.primitives.length;primitiveIndex++){
   const primitive=mesh.primitives[primitiveIndex],label="mesh "+meshIndex+" primitive "+primitiveIndex;
   if((primitive.mode??4)!==4){warnings.push(label+" is not a TRIANGLES primitive and was not counted");continue;}
   const positionIndex=primitive.attributes?.POSITION;
   if(!Number.isSafeInteger(positionIndex)||!accessors[positionIndex])throw new TypeError(label+" has no valid POSITION accessor");
   const positions=readPositions(accessors[positionIndex],views,binary,bufferLength,label+" positions",maxVertices);
   const count=positions.length/3;vertexCount+=count;primitiveCount++;
   for(let i=0;i<positions.length;i+=3){min[0]=Math.min(min[0],positions[i]);min[1]=Math.min(min[1],positions[i+1]);min[2]=Math.min(min[2],positions[i+2]);max[0]=Math.max(max[0],positions[i]);max[1]=Math.max(max[1],positions[i+1]);max[2]=Math.max(max[2],positions[i+2]);}
   const indexAccessor=primitive.indices===undefined?null:accessors[primitive.indices];
   if(primitive.indices!==undefined&&(!Number.isSafeInteger(primitive.indices)||!indexAccessor))throw new TypeError(label+" references a missing index accessor");
   const indices=readIndices(indexAccessor,views,binary,bufferLength,count,label);
   let degenerate=0;
   for(let i=0;i<indices.count;i+=3){
    const ia=indices.read(i),ib=indices.read(i+1),ic=indices.read(i+2);
    if(ia>=count||ib>=count||ic>=count){indexOutOfRangeCount++;continue;}
    const ax=positions[ia*3],ay=positions[ia*3+1],az=positions[ia*3+2];
    const ux=positions[ib*3]-ax,uy=positions[ib*3+1]-ay,uz=positions[ib*3+2]-az;
    const vx=positions[ic*3]-ax,vy=positions[ic*3+1]-ay,vz=positions[ic*3+2]-az;
    const cx=uy*vz-uz*vy,cy=uz*vx-ux*vz,cz=ux*vy-uy*vx,area=Math.hypot(cx,cy,cz)*0.5;
    if(!finite(area)||area<=1e-10)degenerate++;
   }
   if(indexOutOfRangeCount)throw new RangeError(label+" contains triangle indices outside its POSITION accessor");
   const triangles=indices.count/3;triangleCount+=triangles;degenerateTriangleCount+=degenerate;
   meshDetails.push({meshIndex,primitiveIndex,vertexCount:count,triangleCount:triangles,degenerateTriangleCount:degenerate,materialIndex:primitive.material??null});
  }
 }
 if(!primitiveCount||!triangleCount)throw new TypeError("GLB contains no triangle geometry supported by this QA adapter");
 const bounds=computeBounds(min,max),degenerateRatio=degenerateTriangleCount/triangleCount;
 if(triangleCount<12)warnings.push("very-small-triangle-count");
 if(degenerateTriangleCount)warnings.push("degenerate-triangles-present");
 const maxDegenerateRatio=options.maxDegenerateTriangleRatio??0.01;
 if(degenerateRatio>maxDegenerateRatio)warnings.push("degenerate-triangle-ratio-exceeds-threshold");
 const materials=gltf.materials||[],images=gltf.images||[],textures=gltf.textures||[];
 const externalUris=[];
 for(const [type,entries] of [["image",images],["buffer",gltf.buffers||[]]]){
  for(const entry of entries)if(typeof entry.uri==="string")externalUris.push({type,uri:entry.uri});
 }
 if(externalUris.length)warnings.push("external-resources-referenced");
 if(!images.length||!textures.length)warnings.push("no-texture-atlas-embedded-or-declared");
 if(!materials.length)warnings.push("no-materials-declared");
 const embeddedImages=images.filter(image=>Number.isSafeInteger(image.bufferView)&&typeof image.mimeType==="string").length;
 const status=warnings.length?"review-recommended":"basic-geometry-check-passed";
 return {
  schemaVersion:"1.0.0",engine:"glb-geometry-qa-v1",status,valid:true,format:"glb",
  counts:{meshCount:gltf.meshes.length,primitiveCount,vertexCount,triangleCount,degenerateTriangleCount,degenerateTriangleRatio:Number(degenerateRatio.toFixed(6)),materialCount:materials.length,textureCount:textures.length,imageCount:images.length,embeddedImageCount:embeddedImages},
  bounds,meshDetails,warnings,externalUris,
  limitations:["Geometry QA verifies GLB structure and numeric mesh integrity only; it does not verify architectural fidelity, real-world scale, up-axis, WGS84 georeference, mesh watertightness, or same-building identity.","Bounds are model-space values unless independently calibrated."],
 };
}