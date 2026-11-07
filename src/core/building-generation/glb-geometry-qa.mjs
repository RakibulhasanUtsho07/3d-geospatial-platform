import { analyzeTriangleTopology } from "./mesh-topology-qa.mjs";

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
function readBufferView(index,views,binary,bufferLength,label,{alignment=1,forbidTargetAndStride=false}={}){
 const viewIndex=requireInt(index,label+" bufferView index");
 const view=views[viewIndex];
 if(!view||view.buffer!==0)throw new TypeError(label+" bufferView must reference the embedded GLB buffer");
 if(forbidTargetAndStride&&(view.target!==undefined||view.byteStride!==undefined))throw new TypeError(label+" sparse bufferView must not define target or byteStride");
 if(!binary)throw new TypeError(label+" requires an embedded GLB BIN chunk");
 const byteOffset=requireInt(view.byteOffset??0,label+" bufferView byteOffset");
 const byteLength=requireInt(view.byteLength,label+" bufferView byteLength",1);
 if(byteOffset%alignment!==0)throw new TypeError(label+" bufferView byteOffset is not aligned to "+alignment+" bytes");
 if(byteOffset+byteLength>bufferLength||byteOffset+byteLength>binary.length)throw new TypeError(label+" bufferView exceeds the embedded binary buffer");
 return {view,byteOffset,byteLength};
}
function readSparseAccessor(accessor,views,binary,bufferLength,count,componentType,components,label,maxSparseEntries){
 if(accessor.sparse===undefined)return null;
 const sparse=accessor.sparse;
 if(!sparse||typeof sparse!=="object"||Array.isArray(sparse))throw new TypeError(label+" sparse metadata must be an object");
 const sparseCount=requireInt(sparse.count,label+" sparse count",1);
 if(sparseCount>count)throw new RangeError(label+" sparse count exceeds accessor count");
 if(sparseCount>maxSparseEntries)throw new RangeError(label+" sparse count exceeds maximum sparse entry count "+maxSparseEntries);
 const sparseIndices=sparse.indices,sparseValues=sparse.values;
 if(!sparseIndices||typeof sparseIndices!=="object"||Array.isArray(sparseIndices))throw new TypeError(label+" sparse indices must be an object");
 if(!sparseValues||typeof sparseValues!=="object"||Array.isArray(sparseValues))throw new TypeError(label+" sparse values must be an object");
 const sparseIndexBytes=COMPONENT_BYTES[sparseIndices.componentType],sparseIndexMethod=INDEX_READ[sparseIndices.componentType];
 if(!sparseIndexBytes||!sparseIndexMethod)throw new TypeError(label+" sparse indices componentType must be uint8, uint16 or uint32");
 const indexView=readBufferView(sparseIndices.bufferView,views,binary,bufferLength,label+" sparse indices",{alignment:sparseIndexBytes,forbidTargetAndStride:true});
 const indexByteOffset=requireInt(sparseIndices.byteOffset??0,label+" sparse indices byteOffset");
 if(indexByteOffset%sparseIndexBytes!==0)throw new TypeError(label+" sparse indices byteOffset is not aligned to "+sparseIndexBytes+" bytes");
 const indicesEnd=indexByteOffset+sparseCount*sparseIndexBytes;
 if(indicesEnd>indexView.byteLength)throw new TypeError(label+" sparse indices exceed their bufferView");
 const componentBytes=COMPONENT_BYTES[componentType];
 const valueView=readBufferView(sparseValues.bufferView,views,binary,bufferLength,label+" sparse values",{alignment:componentBytes,forbidTargetAndStride:true});
 const valueByteOffset=requireInt(sparseValues.byteOffset??0,label+" sparse values byteOffset");
 if(valueByteOffset%componentBytes!==0)throw new TypeError(label+" sparse values byteOffset is not aligned to "+componentBytes+" bytes");
 const valueElementBytes=componentBytes*components,valueLength=sparseCount*valueElementBytes,valueEnd=valueByteOffset+valueLength;
 if(!Number.isSafeInteger(valueEnd)||valueEnd>valueView.byteLength)throw new TypeError(label+" sparse values exceed their bufferView");
 const sparseIndexValues=new Uint32Array(sparseCount);
 let previous=-1;
 for(let i=0;i<sparseCount;i++){
  const value=binary[sparseIndexMethod](indexView.byteOffset+indexByteOffset+i*sparseIndexBytes);
  if(value>=count)throw new RangeError(label+" sparse index is outside its accessor count");
  if(value<=previous)throw new TypeError(label+" sparse indices must be strictly increasing");
  sparseIndexValues[i]=value;previous=value;
 }
 return {
  count:sparseCount,
  indices:sparseIndexValues,
  valueElementBytes,
  readValue:(entry,component=0)=>binary[
   componentType===5126?"readFloatLE":INDEX_READ[componentType]
  ](valueView.byteOffset+valueByteOffset+entry*valueElementBytes+component*componentBytes),
 };
}
function readAccessorBytes(accessor,views,binary,bufferLength,expectedType,label,maxSparseEntries){
 if(!accessor||accessor.type!==expectedType)throw new TypeError(label+" accessor must use type "+expectedType);
 if(accessor.componentType!==5126)throw new TypeError(label+" accessor positions/normals must use float32 component type");
 const count=requireInt(accessor.count,label+" count",1),accessorOffset=requireInt(accessor.byteOffset??0,label+" byteOffset");
 let first=null,stride=12;
 if(accessor.bufferView!==undefined){
  const data=readBufferView(accessor.bufferView,views,binary,bufferLength,label+" accessor",{alignment:4});
  const viewStride=data.view.byteStride===undefined?12:data.view.byteStride;
  if(!Number.isSafeInteger(viewStride)||viewStride<12||viewStride>252||viewStride%4!==0)throw new TypeError(label+" bufferView has an invalid byteStride");
  if(accessorOffset%4!==0)throw new TypeError(label+" accessor byteOffset is not aligned to 4 bytes");
  first=data.byteOffset+accessorOffset;stride=viewStride;
  const required=first+(count-1)*stride+12;
  if(required>data.byteOffset+data.byteLength||required>bufferLength||required>binary.length)throw new TypeError(label+" accessor exceeds the binary buffer");
 }else if(accessor.byteOffset!==undefined&&accessor.byteOffset!==0){
  throw new TypeError(label+" accessor byteOffset must be zero when bufferView is absent");
 }
 const sparse=readSparseAccessor(accessor,views,binary,bufferLength,count,accessor.componentType,3,label,maxSparseEntries);
 return {count,first,stride,sparse};
}
function validatePositionAccessorBounds(accessor,positions,label){
 const {min,max}=accessor;
 if(!Array.isArray(min)||min.length!==3||!min.every(finite))throw new TypeError(label+" accessor must define min as three finite numbers");
 if(!Array.isArray(max)||max.length!==3||!max.every(finite))throw new TypeError(label+" accessor must define max as three finite numbers");
 if(!min.every(value=>finite(Math.fround(value)))||!max.every(value=>finite(Math.fround(value))))throw new TypeError(label+" accessor bounds must be representable as float32");
 if(accessor.bufferView===undefined&&accessor.sparse===undefined)return;
 const actualMin=[Infinity,Infinity,Infinity],actualMax=[-Infinity,-Infinity,-Infinity];
 for(let vertex=0;vertex<positions.length/3;vertex++)for(let axis=0;axis<3;axis++){
  const value=positions[vertex*3+axis];
  actualMin[axis]=Math.min(actualMin[axis],value);
  actualMax[axis]=Math.max(actualMax[axis],value);
 }
 for(let axis=0;axis<3;axis++){
  if(Math.fround(min[axis])!==actualMin[axis])throw new TypeError(label+" accessor min does not match decoded POSITION values at component "+axis);
  if(Math.fround(max[axis])!==actualMax[axis])throw new TypeError(label+" accessor max does not match decoded POSITION values at component "+axis);
 }
}
function readPositions(accessor,views,binary,bufferLength,label,maxVertices,maxSparseEntries){
 const data=readAccessorBytes(accessor,views,binary,bufferLength,"VEC3",label,maxSparseEntries);
 if(data.count>maxVertices)throw new RangeError(label+" exceeds maximum geometry QA vertex count "+maxVertices);
 const positions=new Float32Array(data.count*3);
 if(data.first!==null){
  for(let i=0;i<data.count;i++){
   const offset=data.first+i*data.stride;
   positions[i*3]=binary.readFloatLE(offset);
   positions[i*3+1]=binary.readFloatLE(offset+4);
   positions[i*3+2]=binary.readFloatLE(offset+8);
  }
 }
 if(data.sparse){
  for(let entry=0;entry<data.sparse.count;entry++){
   const vertex=data.sparse.indices[entry],offset=vertex*3;
   for(let component=0;component<3;component++){
    positions[offset+component]=data.sparse.readValue(entry,component);
   }
  }
 }
 // Sparse replacements define the final accessor values. Validate only after
 // applying them so an invalid dense base value fully overridden by sparse
 // data cannot reject an otherwise valid effective accessor.
 for(let i=0;i<data.count;i++){
  const offset=i*3;
  if(!finite(positions[offset])||!finite(positions[offset+1])||!finite(positions[offset+2])){
   throw new TypeError(label+" contains a non-finite coordinate at vertex "+i);
  }
 }
 return positions;
}
function readIndices(accessor,views,binary,bufferLength,vertexCount,label,maxSparseEntries,maxIndices){
 if(!accessor){
  if(vertexCount%3!==0)throw new TypeError(label+" non-indexed triangle vertex count is not divisible by 3");
  if(vertexCount>maxIndices)throw new RangeError(label+" exceeds maximum geometry QA index count "+maxIndices);
  return {count:vertexCount,read:i=>i};
 }
 const bytes=COMPONENT_BYTES[accessor.componentType],method=INDEX_READ[accessor.componentType];
 if(!bytes||!method)throw new TypeError(label+" index accessor must use uint8, uint16 or uint32 components");
 if(accessor.type!=="SCALAR")throw new TypeError(label+" index accessor must be SCALAR");
 const count=requireInt(accessor.count,label+" index count",1),accessorOffset=requireInt(accessor.byteOffset??0,label+" index accessor offset");
 if(count>maxIndices)throw new RangeError(label+" exceeds maximum geometry QA index count "+maxIndices);
 let first=null;
 if(accessor.bufferView!==undefined){
  const data=readBufferView(accessor.bufferView,views,binary,bufferLength,label+" indices",{alignment:bytes});
  if(data.view.byteStride!==undefined)throw new TypeError(label+" index bufferView must not define byteStride");
  if(accessorOffset%bytes!==0)throw new TypeError(label+" index accessor byteOffset is not aligned to "+bytes+" bytes");
  first=data.byteOffset+accessorOffset;
  const end=first+count*bytes;
  if(end>data.byteOffset+data.byteLength||end>bufferLength||end>binary.length)throw new TypeError(label+" index accessor exceeds the binary buffer");
 }else if(accessor.byteOffset!==undefined&&accessor.byteOffset!==0){
  throw new TypeError(label+" index accessor byteOffset must be zero when bufferView is absent");
 }
 const sparse=readSparseAccessor(accessor,views,binary,bufferLength,count,accessor.componentType,1,label,maxSparseEntries);
 if(count%3!==0)throw new TypeError(label+" triangle index count is not divisible by 3");
 const baseRead=first===null?()=>0:i=>binary[method](first+i*bytes);
 return {count,read:i=>{
  if(sparse){
   let low=0,high=sparse.count-1;
   while(low<=high){
    const middle=(low+high)>>1,index=sparse.indices[middle];
    if(index===i)return sparse.readValue(middle);
    if(index<i)low=middle+1;else high=middle-1;
   }
  }
  return baseRead(i);
 }};
}const IDENTITY_MATRIX=Object.freeze([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
function boundedOption(value,fallback,min,max,label){
 const result=value??fallback;
 if(!Number.isSafeInteger(result)||result<min||result>max)throw new RangeError(label+" must be between "+min+" and "+max);
 return result;
}
function multiplyMatrices(parent,local,label){
 const result=new Float64Array(16);
 for(let column=0;column<4;column++)for(let row=0;row<4;row++){
  result[column*4+row]=parent[row]*local[column*4]+parent[4+row]*local[column*4+1]+parent[8+row]*local[column*4+2]+parent[12+row]*local[column*4+3];
  if(!finite(result[column*4+row]))throw new RangeError(label+" produces a non-finite composed node transform");
 }
 return result;
}
function readNodeVector(node,key,length,fallback,label){
 const value=node[key]===undefined?fallback:node[key];
 if(!Array.isArray(value)||value.length!==length||!value.every(finite))throw new TypeError(label+"."+key+" must contain exactly "+length+" finite numbers");
 return value;
}
function nodeLocalMatrix(node,nodeIndex){
 const label="node "+nodeIndex;
 if(!node||typeof node!=="object"||Array.isArray(node))throw new TypeError(label+" must be an object");
 const hasMatrix=node.matrix!==undefined;
 const hasTrs=node.translation!==undefined||node.rotation!==undefined||node.scale!==undefined;
 if(hasMatrix&&hasTrs)throw new TypeError(label+" must not define matrix and TRS transforms together");
 if(hasMatrix){
  if(!Array.isArray(node.matrix)||node.matrix.length!==16||!node.matrix.every(finite))throw new TypeError(label+".matrix must contain exactly 16 finite numbers");
  const matrix=Float64Array.from(node.matrix);
  if(Math.abs(matrix[3])>1e-8||Math.abs(matrix[7])>1e-8||Math.abs(matrix[11])>1e-8||Math.abs(matrix[15]-1)>1e-8)throw new TypeError(label+".matrix must be affine");
  return matrix;
 }
 const translation=readNodeVector(node,"translation",3,[0,0,0],label);
 const rotation=readNodeVector(node,"rotation",4,[0,0,0,1],label);
 const scale=readNodeVector(node,"scale",3,[1,1,1],label);
 const quaternionLength=Math.hypot(...rotation);
 if(!finite(quaternionLength)||quaternionLength<1e-8||Math.abs(quaternionLength-1)>1e-3)throw new TypeError(label+".rotation must be a normalized quaternion");
 const x=rotation[0]/quaternionLength,y=rotation[1]/quaternionLength,z=rotation[2]/quaternionLength,w=rotation[3]/quaternionLength;
 const xx=x*x,yy=y*y,zz=z*z,xy=x*y,xz=x*z,yz=y*z,wx=w*x,wy=w*y,wz=w*z;
 const matrix=[
  1-2*(yy+zz),2*(xy+wz),2*(xz-wy),0,
  2*(xy-wz),1-2*(xx+zz),2*(yz+wx),0,
  2*(xz+wy),2*(yz-wx),1-2*(xx+yy),0,
  translation[0],translation[1],translation[2],1
 ];
 for(let row=0;row<3;row++){
  matrix[row]*=scale[0];matrix[4+row]*=scale[1];matrix[8+row]*=scale[2];
 }
 if(!matrix.every(finite))throw new RangeError(label+" TRS transform is non-finite");
 return Float64Array.from(matrix);
}
function transformPoint(matrix,x,y,z,label){
 const result=[
  matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12],
  matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13],
  matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14]
 ];
 if(!result.every(finite))throw new RangeError(label+" produces non-finite scene-space coordinates");
 return result;
}
function resolveSceneMeshInstances(gltf,options={}){
 const meshes=gltf.meshes;
 const maxSceneNodes=boundedOption(options.maxSceneNodes,100000,1,250000,"maxSceneNodes");
 const maxSceneMeshInstances=boundedOption(options.maxSceneMeshInstances,10000,1,100000,"maxSceneMeshInstances");
 const localFallback=(reason,sceneIndex=null,nodeCount=0)=>({
  sceneIndex,nodeCount,meshInstanceCount:0,boundsTransformCount:meshes.length,
  instancesByMesh:new Map(),boundsSpace:"mesh-local-unverified",localFallback:true,
  uninstancedMeshDefinitionCount:0,warning:reason,
 });
 const nodes=gltf.nodes,scenes=gltf.scenes;
 if(nodes!==undefined&&!Array.isArray(nodes))throw new TypeError("glTF nodes must be an array when provided");
 if(scenes!==undefined&&!Array.isArray(scenes))throw new TypeError("glTF scenes must be an array when provided");
 if(scenes===undefined&&nodes===undefined)return localFallback("scene-graph-unavailable-mesh-local-bounds-fallback");
 if(scenes===undefined||nodes===undefined){
  if(Array.isArray(scenes)&&scenes.some(scene=>Array.isArray(scene?.nodes)&&scene.nodes.length))throw new TypeError("glTF scenes reference nodes but the nodes array is missing");
  return localFallback("scene-graph-unavailable-mesh-local-bounds-fallback");
 }
 if(scenes.length===0)throw new TypeError("glTF scenes array must contain at least one scene");
 const sceneIndex=gltf.scene===undefined?0:gltf.scene;
 if(!Number.isSafeInteger(sceneIndex)||sceneIndex<0||sceneIndex>=scenes.length)throw new RangeError("glTF default scene index is outside the scenes array");
 const selectedScene=scenes[sceneIndex];
 if(!selectedScene||typeof selectedScene!=="object"||Array.isArray(selectedScene))throw new TypeError("glTF selected scene must be an object");
 const roots=selectedScene.nodes===undefined?[]:selectedScene.nodes;
 if(!Array.isArray(roots))throw new TypeError("glTF selected scene nodes must be an array");
 if(nodes.length>maxSceneNodes)throw new RangeError("glTF node definition array exceeds maxSceneNodes "+maxSceneNodes);
 if(roots.length>maxSceneNodes)throw new RangeError("glTF selected scene exceeds maxSceneNodes "+maxSceneNodes);
 const state=new Uint8Array(nodes.length),instancesByMesh=new Map(),stack=[];
 for(let i=roots.length-1;i>=0;i--)stack.push({nodeIndex:roots[i],parentMatrix:Float64Array.from(IDENTITY_MATRIX),depth:0,exit:false});
 let nodeCount=0,meshInstanceCount=0,pendingNodeCount=roots.length;
 while(stack.length){
  const entry=stack.pop(),nodeIndex=entry.nodeIndex;
  if(entry.exit){state[nodeIndex]=2;continue;}
  pendingNodeCount--;
  if(!Number.isSafeInteger(nodeIndex)||nodeIndex<0||nodeIndex>=nodes.length)throw new RangeError("glTF scene references an invalid node index");
  if(state[nodeIndex]===1)throw new TypeError("glTF node hierarchy contains a cycle");
  if(state[nodeIndex]===2)throw new TypeError("glTF node is referenced more than once in the selected scene");
  if(entry.depth>1024)throw new RangeError("glTF scene node depth exceeds the supported limit");
  nodeCount++;
  if(nodeCount>maxSceneNodes)throw new RangeError("glTF selected scene exceeds maxSceneNodes "+maxSceneNodes);
  state[nodeIndex]=1;
  const node=nodes[nodeIndex];
  const worldMatrix=multiplyMatrices(entry.parentMatrix,nodeLocalMatrix(node,nodeIndex),"node "+nodeIndex);
  if(node.mesh!==undefined){
   if(!Number.isSafeInteger(node.mesh)||node.mesh<0||node.mesh>=meshes.length)throw new RangeError("node "+nodeIndex+" references an invalid mesh index");
   meshInstanceCount++;
   if(meshInstanceCount>maxSceneMeshInstances)throw new RangeError("glTF selected scene exceeds maxSceneMeshInstances "+maxSceneMeshInstances);
   const list=instancesByMesh.get(node.mesh)??[];
   list.push(worldMatrix);instancesByMesh.set(node.mesh,list);
  }
  const children=node.children===undefined?[]:node.children;
  if(!Array.isArray(children))throw new TypeError("node "+nodeIndex+" children must be an array");
  if(nodeCount+pendingNodeCount+children.length>maxSceneNodes)throw new RangeError("glTF selected scene exceeds maxSceneNodes "+maxSceneNodes);
  stack.push({nodeIndex,parentMatrix:worldMatrix,depth:entry.depth,exit:true});
  for(let i=children.length-1;i>=0;i--)stack.push({nodeIndex:children[i],parentMatrix:worldMatrix,depth:entry.depth+1,exit:false});
  pendingNodeCount+=children.length;
 }
 if(meshInstanceCount===0)return localFallback("selected-scene-has-no-mesh-instances-local-bounds-fallback",sceneIndex,nodeCount);
 const uninstancedMeshDefinitionCount=meshes.length-instancesByMesh.size;
 return {sceneIndex,nodeCount,meshInstanceCount,boundsTransformCount:meshInstanceCount,instancesByMesh,boundsSpace:"scene-space-unverified",localFallback:false,uninstancedMeshDefinitionCount,warning:uninstancedMeshDefinitionCount?"uninstanced-mesh-definitions-excluded-from-scene-bounds":null};
}
function computeBounds(min,max,units){
 if(!min.every(finite)||!max.every(finite))throw new TypeError("model bounds are non-finite");
 const dimensions=min.map((value,index)=>max[index]-value);
 return {min,max,dimensions,units};
}

/** Structural/geometry QA for GLB 2.0 outputs. It checks mesh integrity, not architectural truth. */
export function analyzeGlbQuality(input,options={}){
 const {gltf,binary,bufferLength}=parseGlb(input),views=gltf.bufferViews||[],accessors=gltf.accessors||[];
 const maxVertices=options.maxVertices??5_000_000;
 if(!Number.isSafeInteger(maxVertices)||maxVertices<3||maxVertices>20_000_000)throw new RangeError("maxVertices must be between 3 and 20000000");
 const maxSparseEntries=options.maxSparseEntries??1_000_000;
 if(!Number.isSafeInteger(maxSparseEntries)||maxSparseEntries<1||maxSparseEntries>5_000_000)throw new RangeError("maxSparseEntries must be between 1 and 5000000");
 const maxIndices=options.maxIndices??15_000_000;
 if(!Number.isSafeInteger(maxIndices)||maxIndices<3||maxIndices>60_000_000)throw new RangeError("maxIndices must be between 3 and 60000000");
 const scene=resolveSceneMeshInstances(gltf,options);
 const maxSceneBoundsVertexEvaluations=boundedOption(options.maxSceneBoundsVertexEvaluations,25_000_000,1,100_000_000,"maxSceneBoundsVertexEvaluations");
 let boundsVertexEvaluations=0,vertexCount=0,referencedVertexCount=0,unreferencedVertexCount=0,triangleCount=0,degenerateTriangleCount=0,primitiveCount=0,indexOutOfRangeCount=0;
 const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],warnings=[],meshDetails=[],topologyWarnings=new Set();
 if(scene.warning)warnings.push(scene.warning);
 if(scene.uninstancedMeshDefinitionCount)warnings.push("uninstanced-mesh-definitions-excluded-from-scene-bounds");
 if(gltf.animations?.length)warnings.push("animated-node-transforms-not-evaluated");
 const hasMorphTargets=gltf.meshes.some(mesh=>Array.isArray(mesh.primitives)&&(mesh.weights?.length||mesh.primitives.some(primitive=>primitive.targets?.length)));
 if(gltf.skins?.length||hasMorphTargets)warnings.push("skinning-or-morph-deformation-not-evaluated");
 for(let meshIndex=0;meshIndex<gltf.meshes.length;meshIndex++){
  const mesh=gltf.meshes[meshIndex];
  if(!Array.isArray(mesh.primitives)||!mesh.primitives.length)throw new TypeError("mesh "+meshIndex+" contains no primitives");
  for(let primitiveIndex=0;primitiveIndex<mesh.primitives.length;primitiveIndex++){
   const primitive=mesh.primitives[primitiveIndex],label="mesh "+meshIndex+" primitive "+primitiveIndex;
   const mode=primitive.mode===undefined?4:primitive.mode,positionIndex=primitive.attributes?.POSITION;
   if(!Number.isSafeInteger(mode)||mode<0||mode>6){
    throw new TypeError(label+" has an invalid glTF primitive mode; expected an integer from 0 to 6");
   }
   if(positionIndex===undefined){
    if(mode!==4){warnings.push(label+" has no POSITION accessor and was not counted");continue;}
    throw new TypeError(label+" has no valid POSITION accessor");
   }
   if(!Number.isSafeInteger(positionIndex)||!accessors[positionIndex])throw new TypeError(label+" has no valid POSITION accessor");
   // POSITION accessor bounds are required independently of primitive topology.
   // Validate source attributes before skipping topology modes this QA does not analyze.
   const positionAccessor=accessors[positionIndex];
   const positions=readPositions(positionAccessor,views,binary,bufferLength,label+" positions",maxVertices,maxSparseEntries);
   validatePositionAccessorBounds(positionAccessor,positions,label+" POSITION");
   if(mode!==4){warnings.push(label+" is not a TRIANGLES primitive and was not counted");continue;}
   const count=positions.length/3;vertexCount+=count;primitiveCount++;
   const indexAccessor=primitive.indices===undefined?null:accessors[primitive.indices];
   if(primitive.indices!==undefined&&(!Number.isSafeInteger(primitive.indices)||!indexAccessor))throw new TypeError(label+" references a missing index accessor");
   const indices=readIndices(indexAccessor,views,binary,bufferLength,count,label,maxSparseEntries,maxIndices);
   const referenced=new Uint8Array(count);
   let primitiveReferencedVertexCount=0,degenerate=0;
   for(let i=0;i<indices.count;i+=3){
    const ia=indices.read(i),ib=indices.read(i+1),ic=indices.read(i+2);
    if(ia>=count||ib>=count||ic>=count){indexOutOfRangeCount++;continue;}
    if(!referenced[ia]){referenced[ia]=1;primitiveReferencedVertexCount++;}
    if(!referenced[ib]){referenced[ib]=1;primitiveReferencedVertexCount++;}
    if(!referenced[ic]){referenced[ic]=1;primitiveReferencedVertexCount++;}
    const ax=positions[ia*3],ay=positions[ia*3+1],az=positions[ia*3+2];
    const ux=positions[ib*3]-ax,uy=positions[ib*3+1]-ay,uz=positions[ib*3+2]-az;
    const vx=positions[ic*3]-ax,vy=positions[ic*3+1]-ay,vz=positions[ic*3+2]-az;
    const cx=uy*vz-uz*vy,cy=uz*vx-ux*vz,cz=ux*vy-uy*vx,area=Math.hypot(cx,cy,cz)*0.5;
    if(!finite(area)||area<=1e-10)degenerate++;
   }
   if(indexOutOfRangeCount)throw new RangeError(label+" contains triangle indices outside its POSITION accessor");
   const primitiveUnreferencedVertexCount=count-primitiveReferencedVertexCount;
   referencedVertexCount+=primitiveReferencedVertexCount;
   unreferencedVertexCount+=primitiveUnreferencedVertexCount;
   const transforms=scene.localFallback?[IDENTITY_MATRIX]:(scene.instancesByMesh.get(meshIndex)??[]);
   const requiredEvaluations=primitiveReferencedVertexCount*transforms.length;
   if(!Number.isSafeInteger(requiredEvaluations)||boundsVertexEvaluations+requiredEvaluations>maxSceneBoundsVertexEvaluations)throw new RangeError("scene-space bounds exceed maxSceneBoundsVertexEvaluations "+maxSceneBoundsVertexEvaluations);
   boundsVertexEvaluations+=requiredEvaluations;
   for(const transform of transforms)for(let i=0;i<count;i++){
    if(!referenced[i])continue;
    const offset=i*3,point=transformPoint(transform,positions[offset],positions[offset+1],positions[offset+2],label);
    for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis],point[axis]);max[axis]=Math.max(max[axis],point[axis]);}
   }
   const triangles=indices.count/3;triangleCount+=triangles;degenerateTriangleCount+=degenerate;
   const topology=analyzeTriangleTopology(positions,indices,{
    maxTopologyVertices:options.maxTopologyVertices,
    weldToleranceRelative:options.weldToleranceRelative,
    maxLongEdgeRatio:options.maxLongEdgeRatio,
    maxTriangleEdgeRatio:options.maxTriangleEdgeRatio,
    maxLongEdgeTriangleRatio:options.maxLongEdgeTriangleRatio,
    maxSmallComponentTriangles:options.maxSmallComponentTriangles
   });
   for(const warning of topology.warnings)topologyWarnings.add(warning);
   meshDetails.push({meshIndex,primitiveIndex,vertexCount:count,referencedVertexCount:primitiveReferencedVertexCount,unreferencedVertexCount:primitiveUnreferencedVertexCount,sceneInstanceCount:scene.localFallback?0:transforms.length,boundsTransformCount:transforms.length,topologyCoordinateSpace:"mesh-local",triangleCount:triangles,degenerateTriangleCount:degenerate,materialIndex:primitive.material??null,topology});
  }
 }
 if(!primitiveCount||!triangleCount)throw new TypeError("GLB contains no triangle geometry supported by this QA adapter");
 const bounds=computeBounds(min,max,scene.boundsSpace),degenerateRatio=degenerateTriangleCount/triangleCount;
 if(triangleCount<12)warnings.push("very-small-triangle-count");
 if(degenerateTriangleCount)warnings.push("degenerate-triangles-present");
 if(unreferencedVertexCount)warnings.push("unreferenced-vertices-present");
 const maxDegenerateRatio=options.maxDegenerateTriangleRatio??0.01;
 if(degenerateRatio>maxDegenerateRatio)warnings.push("degenerate-triangle-ratio-exceeds-threshold");
 warnings.push(...topologyWarnings);
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
  schemaVersion:"1.0.0",engine:"glb-geometry-qa-v2",status,valid:true,format:"glb",
  counts:{meshCount:gltf.meshes.length,primitiveCount,meshInstanceCount:scene.meshInstanceCount,boundsTransformCount:scene.boundsTransformCount,sceneNodeCount:scene.nodeCount,boundsVertexEvaluations,vertexCount,referencedVertexCount,unreferencedVertexCount,triangleCount,degenerateTriangleCount,degenerateTriangleRatio:Number(degenerateRatio.toFixed(6)),materialCount:materials.length,textureCount:textures.length,imageCount:images.length,embeddedImageCount:embeddedImages},
  bounds,meshDetails,warnings,externalUris,scene:{index:scene.sceneIndex,nodeCount:scene.nodeCount,meshInstanceCount:scene.meshInstanceCount,boundsTransformCount:scene.boundsTransformCount,localFallback:scene.localFallback,boundsSpace:scene.boundsSpace,boundsVertexEvaluations,maxSceneBoundsVertexEvaluations},
  limitations:["Geometry QA verifies GLB structure and computes heuristic mesh-topology hints; it does not verify architectural fidelity, real-world scale, up-axis, WGS84 georeference, camera calibration, or same-building identity.","Boundary edges can be expected on intentionally open surfaces; disconnected components can also be legitimate separate architectural parts, so topology warnings require visual review.","Unreferenced POSITION entries remain subject to accessor-size and finite-coordinate validation, but do not affect model bounds, model diagonal or topology scale; they are counted and reported separately.","Topology analysis welds near-coincident positions using a scale-relative tolerance and may be skipped above the configured per-primitive vertex limit.","Aggregate bounds apply the selected glTF scene node transforms when available and remain un-georeferenced; topology metrics are mesh-local.", "Static QA does not evaluate animation, skinning or morph-target deformation."],
 };
}