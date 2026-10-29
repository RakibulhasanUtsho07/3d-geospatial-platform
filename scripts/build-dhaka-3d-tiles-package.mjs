#!/usr/bin/env node

import { createHash } from "node:crypto";
import earcut from "earcut";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateTilesetManifest } from "../src/core/geospatial/tileset-manifest-validation.mjs";
import { verifyTilesetPackage } from "../src/core/geospatial/tileset-package-integrity.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const DEFAULT_SOURCE = path.join(projectRoot, "data/overture/dhaka-buildings-3d-pilot.geojson");
const DEFAULT_OUTPUT = path.join(projectRoot, "data/overture/dhaka-3d-tiles-multibuilding-pilot");
const DEFAULT_BOUNDS = Object.freeze({ west: 90.4, south: 23.77, east: 90.42, north: 23.79 });
const SOURCE_DESCRIPTION = "Overture Maps Buildings theme — Dhaka 3D pilot extract";
const ATTRIBUTION = "© OpenStreetMap contributors, Overture Maps Foundation";
const WGS84_A = 6_378_137;
const WGS84_E2 = 6.6943799901413165e-3;
const METERS_PER_LONGITUDE_DEGREE = 111_319.490793;
const METERS_PER_LATITUDE_DEGREE = 111_132.92;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_FEATURES = 128;
const MIN_FEATURE_SPAN_METERS = 1;
const MAX_FEATURE_SPAN_METERS = 160;
const BOUNDS_PADDING_METERS = 1;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function within(directory, target) {
  const relative = path.relative(path.resolve(directory), path.resolve(target));
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function featureIdentity(feature) {
  if (feature.id !== undefined && feature.id !== null &&
      (typeof feature.id === "string" || typeof feature.id === "number")) {
    return String(feature.id);
  }
  const properties = isRecord(feature.properties) ? feature.properties : {};
  for (const key of ["id", "feature_id", "featureId", "building_id", "buildingId", "overture_id"]) {
    const value = properties[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return sha256(JSON.stringify(feature));
}

function geometryBounds(geometry) {
  if (!isRecord(geometry)) return null;
  const bounds = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };

  function visit(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      const [longitude, latitude] = value;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
          longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return;
      bounds.west = Math.min(bounds.west, longitude);
      bounds.south = Math.min(bounds.south, latitude);
      bounds.east = Math.max(bounds.east, longitude);
      bounds.north = Math.max(bounds.north, latitude);
      return;
    }
    for (const child of value) visit(child);
  }

  visit(geometry.coordinates);
  return Object.values(bounds).every(Number.isFinite) ? bounds : null;
}

function normalizeRing(rawRing, label = "Footprint") {
  if (!Array.isArray(rawRing)) throw new Error(label + " ring must be an array.");
  const ring = [];
  for (const coordinate of rawRing) {
    if (!Array.isArray(coordinate) || coordinate.length < 2 ||
        !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]) ||
        coordinate[0] < -180 || coordinate[0] > 180 || coordinate[1] < -90 || coordinate[1] > 90) {
      throw new Error(label + " ring contains an invalid WGS84 coordinate.");
    }
    const point = [coordinate[0], coordinate[1]];
    const previous = ring.at(-1);
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) ring.push(point);
  }
  if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
  if (ring.length < 3) throw new Error(label + " ring must contain at least three distinct vertices.");
  return ring;
}

function getPolygons(geometry) {
  if (!isRecord(geometry)) throw new Error("Feature geometry is missing.");
  let polygons;
  if (geometry.type === "Polygon") polygons = [geometry.coordinates];
  else if (geometry.type === "MultiPolygon") polygons = geometry.coordinates;
  else throw new Error("Only Polygon and MultiPolygon footprints are supported.");
  if (!Array.isArray(polygons) || polygons.length === 0) throw new Error("Polygon geometry has no components.");
  return polygons.map((polygon, polygonIndex) => {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      throw new Error("Polygon component " + polygonIndex + " has no exterior ring.");
    }
    return polygon.map((rawRing, ringIndex) =>
      normalizeRing(rawRing, ringIndex === 0 ? "Polygon exterior" : "Interior hole"));
  });
}

function projectRing(ring, anchorLongitude, anchorLatitude, desiredWinding = 1) {
  const cosine = Math.cos(anchorLatitude * Math.PI / 180);
  const points = ring.map(([longitude, latitude]) => ({
    longitude,
    latitude,
    x: (longitude - anchorLongitude) * METERS_PER_LONGITUDE_DEGREE * cosine,
    north: (latitude - anchorLatitude) * METERS_PER_LATITUDE_DEGREE,
  }));

  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index + points.length - 1) % points.length];
      const current = points[index];
      const next = points[(index + 1) % points.length];
      const cross = (current.x - previous.x) * (next.north - current.north) -
        (current.north - previous.north) * (next.x - current.x);
      if (Math.abs(cross) < 1e-8) {
        points.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  if (points.length < 3) throw new Error("Footprint became degenerate after local projection.");
  const signedArea = points.reduce((sum, current, index) => {
    const next = points[(index + 1) % points.length];
    return sum + current.x * next.north - next.x * current.north;
  }, 0) / 2;
  if (!Number.isFinite(signedArea) || Math.abs(signedArea) < 1e-6) {
    throw new Error("Footprint projected area is degenerate.");
  }
  if ((signedArea > 0 && desiredWinding < 0) || (signedArea < 0 && desiredWinding > 0)) points.reverse();
  return points;
}

function cross2(a, b, c) {
  return (b.x - a.x) * (c.north - a.north) - (b.north - a.north) * (c.x - a.x);
}

function signedRingArea(points) {
  return points.reduce((sum, current, index) => {
    const next = points[(index + 1) % points.length];
    return sum + current.x * next.north - next.x * current.north;
  }, 0) / 2;
}
function pointOnSegment(point, start, end) {
  const epsilon = 1e-8;
  return Math.abs(cross2(start, end, point)) <= epsilon &&
    point.x >= Math.min(start.x, end.x)-epsilon && point.x <= Math.max(start.x, end.x)+epsilon &&
    point.north >= Math.min(start.north, end.north)-epsilon && point.north <= Math.max(start.north, end.north)+epsilon;
}
// Returns 1 for inside, -1 for outside, and 0 for a boundary point.
function pointInRing(point, ring) {
  let inside = false;
  for (let index=0, previousIndex=ring.length-1; index<ring.length; previousIndex=index++) {
    const current=ring[index], previous=ring[previousIndex];
    if(pointOnSegment(point,previous,current))return 0;
    if((current.north>point.north)!==(previous.north>point.north)){
      const crossingX=(previous.x-current.x)*(point.north-current.north)/(previous.north-current.north)+current.x;
      if(point.x<crossingX)inside=!inside;
    }
  }
  return inside?1:-1;
}
function segmentsIntersect(a,b,c,d) {
  const epsilon=1e-8;
  const abC=cross2(a,b,c),abD=cross2(a,b,d),cdA=cross2(c,d,a),cdB=cross2(c,d,b);
  if(Math.abs(abC)<=epsilon&&pointOnSegment(c,a,b))return true;
  if(Math.abs(abD)<=epsilon&&pointOnSegment(d,a,b))return true;
  if(Math.abs(cdA)<=epsilon&&pointOnSegment(a,c,d))return true;
  if(Math.abs(cdB)<=epsilon&&pointOnSegment(b,c,d))return true;
  return ((abC>epsilon&&abD< -epsilon)||(abC< -epsilon&&abD>epsilon))&&
    ((cdA>epsilon&&cdB< -epsilon)||(cdA< -epsilon&&cdB>epsilon));
}
function assertHoleTopology(rings) {
  if(!Array.isArray(rings)||rings.length===0)throw new Error("Polygon has no rings.");
  const exterior=rings[0];
  for(let holeIndex=1;holeIndex<rings.length;holeIndex++){
    const hole=rings[holeIndex];
    if(hole.some(point=>pointInRing(point,exterior)!==1)){
      throw new Error("Hole ring must be strictly inside its exterior ring and must not touch the exterior boundary.");
    }
    for(let i=0;i<hole.length;i++)for(let j=0;j<exterior.length;j++){
      if(segmentsIntersect(hole[i],hole[(i+1)%hole.length],exterior[j],exterior[(j+1)%exterior.length])){
        throw new Error("Hole ring intersects its exterior boundary.");
      }
    }
    for(let otherIndex=1;otherIndex<holeIndex;otherIndex++){
      const other=rings[otherIndex];
      if(pointInRing(hole[0],other)!==-1||pointInRing(other[0],hole)!==-1){
        throw new Error("Interior hole rings must not overlap or nest.");
      }
      for(let i=0;i<hole.length;i++)for(let j=0;j<other.length;j++){
        if(segmentsIntersect(hole[i],hole[(i+1)%hole.length],other[j],other[(j+1)%other.length])){
          throw new Error("Interior hole rings must not intersect.");
        }
      }
    }
  }
}
function triangulatePolygon(rings) {
  assertHoleTopology(rings);
  const points=rings.flat(),flatCoordinates=[],holeIndices=[];
  let vertexOffset=0;
  for(let ringIndex=0;ringIndex<rings.length;ringIndex++){
    const ring=rings[ringIndex];
    if(ringIndex>0)holeIndices.push(vertexOffset);
    for(const point of ring)flatCoordinates.push(point.x,point.north);
    vertexOffset+=ring.length;
  }
  const indices=earcut(flatCoordinates,holeIndices,2);
  if((!Array.isArray(indices)&&!(indices instanceof Uint32Array))||indices.length<3||indices.length%3!==0){
    throw new Error("Hole-aware triangulation returned an incomplete triangle index buffer.");
  }
  const expectedArea=Math.abs(signedRingArea(rings[0]))-
    rings.slice(1).reduce((sum,ring)=>sum+Math.abs(signedRingArea(ring)),0);
  if(!Number.isFinite(expectedArea)||expectedArea<=1e-6)throw new Error("Polygon exterior minus interior holes has no positive area.");
  let actualArea=0;
  for(let i=0;i<indices.length;i+=3){
    const a=points[indices[i]],b=points[indices[i+1]],c=points[indices[i+2]];
    if(!a||!b||!c)throw new Error("Hole-aware triangulation referenced a missing vertex.");
    const area=Math.abs(cross2(a,b,c))/2;
    if(!Number.isFinite(area)||area<=1e-10)throw new Error("Hole-aware triangulation emitted a degenerate roof triangle.");
    actualArea+=area;
  }
  if(Math.abs(actualArea-expectedArea)>Math.max(1e-4,expectedArea*1e-6)){
    throw new Error("Hole-aware triangulation area does not match exterior-minus-holes area.");
  }
  return {points,indices};
}

function wgs84ToEcef(longitude, latitude, height = 0) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const normal = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return [
    (normal + height) * cosLat * Math.cos(lon),
    (normal + height) * cosLat * Math.sin(lon),
    (normal * (1 - WGS84_E2) + height) * sinLat,
  ];
}

function localEnuToEcefTransform(longitude, latitude) {
  const lon = longitude * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const [x, y, z] = wgs84ToEcef(longitude, latitude, 0);
  return [
    -sinLon, cosLon, 0, 0,
    cosLat * cosLon, cosLat * sinLon, sinLat, 0,
    sinLat * cosLon, sinLat * sinLon, -cosLat, 0,
    x, y, z, 1,
  ];
}

function createGlb(polygons, longitude, latitude, heightMeters, featureId, featureSha256) {
  const positions=[],normals=[],indices=[];
  function addTriangle(first,second,third,desiredNormalY=null) {
    let a=first,b=second,c=third;
    let ax=b[0]-a[0],ay=b[1]-a[1],az=b[2]-a[2];
    let bx=c[0]-a[0],by=c[1]-a[1],bz=c[2]-a[2];
    let nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;
    if(desiredNormalY!==null&&ny*desiredNormalY<0){
      [b,c]=[c,b];
      ax=b[0]-a[0];ay=b[1]-a[1];az=b[2]-a[2];
      bx=c[0]-a[0];by=c[1]-a[1];bz=c[2]-a[2];
      nx=ay*bz-az*by;ny=az*bx-ax*bz;nz=ax*by-ay*bx;
    }
    const length=Math.hypot(nx,ny,nz);
    if(!Number.isFinite(length)||length<1e-10)throw new Error("Degenerate triangle generated from footprint.");
    const normal=[nx/length,ny/length,nz/length],offset=positions.length/3;
    for(const point of [a,b,c]){positions.push(...point);normals.push(...normal);}
    indices.push(offset,offset+1,offset+2);
  }
  for(const rawPolygon of polygons){
    const projectedRings=rawPolygon.map((rawRing,ringIndex)=>projectRing(rawRing,longitude,latitude,ringIndex===0?1:-1));
    const {points,indices:roofIndices}=triangulatePolygon(projectedRings);
    const bottom=points.map(p=>[p.x,0,-p.north]),top=points.map(p=>[p.x,heightMeters,-p.north]);
    for(let i=0;i<roofIndices.length;i+=3){
      const a=roofIndices[i],b=roofIndices[i+1],c=roofIndices[i+2];
      addTriangle(top[a],top[b],top[c],1);addTriangle(bottom[c],bottom[b],bottom[a],-1);
    }
    let ringOffset=0;
    for(const ring of projectedRings){
      for(let i=0;i<ring.length;i++){
        const current=ringOffset+i,next=ringOffset+(i+1)%ring.length;
        addTriangle(bottom[current],bottom[next],top[next]);
        addTriangle(bottom[current],top[next],top[current]);
      }
      ringOffset+=ring.length;
    }
  }
  const positionBytes=Buffer.alloc(positions.length*4),normalBytes=Buffer.alloc(normals.length*4),indexBytes=Buffer.alloc(indices.length*4);
  positions.forEach((value,index)=>positionBytes.writeFloatLE(value,index*4));
  normals.forEach((value,index)=>normalBytes.writeFloatLE(value,index*4));
  indices.forEach((value,index)=>indexBytes.writeUInt32LE(value,index*4));
  const binary=Buffer.concat([positionBytes,normalBytes,indexBytes]);
  const minimum=[Infinity,Infinity,Infinity],maximum=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<positions.length;i+=3)for(let axis=0;axis<3;axis++){
    minimum[axis]=Math.min(minimum[axis],positions[i+axis]);maximum[axis]=Math.max(maximum[axis],positions[i+axis]);
  }
  const gltf={
    asset:{version:"2.0",generator:"3d-geospatial-platform P3.6 footprint tile pilot"},
    scene:0,scenes:[{nodes:[0]}],nodes:[{name:`Footprint extrusion ${featureId}`,mesh:0}],
    meshes:[{name:"Extruded source footprint; synthetic height",primitives:[{attributes:{POSITION:0,NORMAL:1},indices:2,material:0}]}],
    materials:[{name:"Neutral validation material",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[0.42,0.62,0.78,1],metallicFactor:0,roughnessFactor:0.9}}],
    buffers:[{byteLength:binary.length}],
    bufferViews:[
      {buffer:0,byteOffset:0,byteLength:positionBytes.length,target:34962},
      {buffer:0,byteOffset:positionBytes.length,byteLength:normalBytes.length,target:34962},
      {buffer:0,byteOffset:positionBytes.length+normalBytes.length,byteLength:indexBytes.length,target:34963}
    ],
    accessors:[
      {bufferView:0,componentType:5126,count:positions.length/3,type:"VEC3",min:minimum,max:maximum},
      {bufferView:1,componentType:5126,count:normals.length/3,type:"VEC3"},
      {bufferView:2,componentType:5125,count:indices.length,type:"SCALAR",min:[0],max:[positions.length/3-1]}
    ],
    extras:{sourceFeatureId:featureId,sourceFeatureSha256:featureSha256,heightStatus:"synthetic-test-height",
      syntheticHeightMeters:heightMeters,interiorRingCount:polygons.reduce((sum,polygon)=>sum+polygon.length-1,0)}
  };
  const jsonBytes=Buffer.from(JSON.stringify(gltf),"utf8");
  const paddedJson=Buffer.concat([jsonBytes,Buffer.alloc((4-jsonBytes.length%4)%4,0x20)]);
  const paddedBinary=Buffer.concat([binary,Buffer.alloc((4-binary.length%4)%4)]);
  const totalLength=12+8+paddedJson.length+8+paddedBinary.length;
  const header=Buffer.alloc(12);header.write("glTF",0,"ascii");header.writeUInt32LE(2,4);header.writeUInt32LE(totalLength,8);
  const jsonHeader=Buffer.alloc(8);jsonHeader.writeUInt32LE(paddedJson.length,0);jsonHeader.writeUInt32LE(0x4e4f534a,4);
  const binaryHeader=Buffer.alloc(8);binaryHeader.writeUInt32LE(paddedBinary.length,0);binaryHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,jsonHeader,paddedJson,binaryHeader,paddedBinary]);
}

function padBounds(bounds, latitude, paddingMeters = BOUNDS_PADDING_METERS) {
  const longitudeScale = METERS_PER_LONGITUDE_DEGREE * Math.max(0.01, Math.cos(latitude * Math.PI / 180));
  const latitudeDelta = paddingMeters / METERS_PER_LATITUDE_DEGREE;
  const longitudeDelta = paddingMeters / longitudeScale;
  return {
    west: Math.max(-180, bounds.west - longitudeDelta),
    south: Math.max(-90, bounds.south - latitudeDelta),
    east: Math.min(180, bounds.east + longitudeDelta),
    north: Math.min(90, bounds.north + latitudeDelta),
  };
}

function boundsToRegion(bounds, minHeight = -0.25, maxHeight = 8.25) {
  return [
    bounds.west * Math.PI / 180,
    bounds.south * Math.PI / 180,
    bounds.east * Math.PI / 180,
    bounds.north * Math.PI / 180,
    minHeight,
    maxHeight,
  ];
}

function parseArgs(argv) {
  const args = {
    source: DEFAULT_SOURCE,
    output: DEFAULT_OUTPUT,
    maxFeatures: 32,
    heightMeters: 8,
    bounds: { ...DEFAULT_BOUNDS },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    if (flag === "--source") args.source = path.resolve(value);
    else if (flag === "--output") args.output = path.resolve(value);
    else if (flag === "--max-features") args.maxFeatures = Number(value);
    else if (flag === "--height-meters") args.heightMeters = Number(value);
    else if (flag === "--bbox") {
      const parts = value.split(",").map(Number);
      if (parts.length !== 4 || !parts.every(Number.isFinite)) throw new Error("--bbox must be west,south,east,north.");
      args.bounds = { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
    } else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  return args;
}

export async function buildDhaka3DTilesPackage({
  sourcePath = DEFAULT_SOURCE,
  outputPath = DEFAULT_OUTPUT,
  maxFeatures = 32,
  syntheticHeightMeters = 8,
  bounds = DEFAULT_BOUNDS,
} = {}) {
  const normalizedSource = path.resolve(sourcePath);
  const normalizedOutput = path.resolve(outputPath);
  const safeSource = within(projectRoot, normalizedSource) || within(os.tmpdir(), normalizedSource);
  const safeOutput = within(path.join(projectRoot, "data", "overture"), normalizedOutput) ||
    within(path.join(projectRoot, "public", "experimental"), normalizedOutput) ||
    within(os.tmpdir(), normalizedOutput);
  if (!safeSource) throw new Error("Refusing to read a source outside the repository or OS temporary directory.");
  if (!safeOutput) throw new Error("Refusing to write the package outside data/overture, public/experimental or the OS temporary directory.");
  if (!Number.isInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > MAX_FEATURES) {
    throw new Error(`maxFeatures must be an integer from 1 to ${MAX_FEATURES}.`);
  }
  if (!Number.isFinite(syntheticHeightMeters) || syntheticHeightMeters <= 0 || syntheticHeightMeters > 250) {
    throw new Error("syntheticHeightMeters must be finite and in the range (0, 250].");
  }
  if (!isRecord(bounds) || ![bounds.west, bounds.south, bounds.east, bounds.north].every(Number.isFinite) ||
      bounds.west < -180 || bounds.east > 180 || bounds.south < -90 || bounds.north > 90 ||
      bounds.west >= bounds.east || bounds.south >= bounds.north) {
    throw new Error("bounds must be a valid WGS84 west/south/east/north extent.");
  }

  const sourceInfo = await stat(normalizedSource);
  if (!sourceInfo.isFile() || sourceInfo.size > MAX_INPUT_BYTES) {
    throw new Error(`Source GeoJSON must be a regular file no larger than ${MAX_INPUT_BYTES} bytes.`);
  }
  const sourceBytes = await readFile(normalizedSource);
  const sourceText = sourceBytes.toString("utf8");
  let source;
  try {
    source = JSON.parse(sourceText);
  } catch (error) {
    throw new Error(`Source GeoJSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(source) || source.type !== "FeatureCollection" || !Array.isArray(source.features)) {
    throw new Error("The source must be a GeoJSON FeatureCollection.");
  }

  const excludedCounts = {
    invalidFeature: 0,
    unsupportedGeometry: 0,
    invalidHoleGeometry: 0,
    invalidFootprint: 0,
    outsideBounds: 0,
    footprintSizeOutOfRange: 0,
    duplicateIdentity: 0,
    triangulationFailed: 0,
    featureLimit: 0,
  };
  const seen = new Set();
  const candidates = [];

  for (const feature of source.features) {
    if (!isRecord(feature) || feature.type !== "Feature" || !isRecord(feature.geometry)) {
      excludedCounts.invalidFeature += 1;
      continue;
    }
    let polygons;
    try {
      polygons = getPolygons(feature.geometry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/interior hole/i.test(message)) excludedCounts.invalidHoleGeometry += 1;
      else if (message.includes("Only Polygon")) excludedCounts.unsupportedGeometry += 1;
      else excludedCounts.invalidFootprint += 1;
      continue;
    }
    const featureBounds = geometryBounds(feature.geometry);
    if (!featureBounds) {
      excludedCounts.invalidFootprint += 1;
      continue;
    }
    const longitude = (featureBounds.west + featureBounds.east) / 2;
    const latitude = (featureBounds.south + featureBounds.north) / 2;
    if (longitude < bounds.west || longitude > bounds.east || latitude < bounds.south || latitude > bounds.north) {
      excludedCounts.outsideBounds += 1;
      continue;
    }
    const widthMeters = (featureBounds.east - featureBounds.west) *
      METERS_PER_LONGITUDE_DEGREE * Math.cos(latitude * Math.PI / 180);
    const depthMeters = (featureBounds.north - featureBounds.south) * METERS_PER_LATITUDE_DEGREE;
    if (widthMeters < MIN_FEATURE_SPAN_METERS || depthMeters < MIN_FEATURE_SPAN_METERS ||
        widthMeters > MAX_FEATURE_SPAN_METERS || depthMeters > MAX_FEATURE_SPAN_METERS) {
      excludedCounts.footprintSizeOutOfRange += 1;
      continue;
    }
    const id = featureIdentity(feature);
    if (seen.has(id)) {
      excludedCounts.duplicateIdentity += 1;
      continue;
    }
    seen.add(id);
    candidates.push({
      feature,
      id,
      polygons,
      bounds: featureBounds,
      longitude,
      latitude,
      widthMeters,
      depthMeters,
      featureSha256: sha256(Buffer.from(JSON.stringify(feature), "utf8")),
    });
  }

  candidates.sort((left, right) => left.id.localeCompare(right.id));
  if (candidates.length > maxFeatures) excludedCounts.featureLimit = candidates.length - maxFeatures;
  const tiles = [];
  for (const candidate of candidates) {
    if (tiles.length >= maxFeatures) break;
    let contentBytes;
    try {
      contentBytes = createGlb(
        candidate.polygons,
        candidate.longitude,
        candidate.latitude,
        syntheticHeightMeters,
        candidate.id,
        candidate.featureSha256,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/hole|interior ring/i.test(message)) excludedCounts.invalidHoleGeometry += 1;
      else excludedCounts.triangulationFailed += 1;
      continue;
    }
    if (contentBytes.length > MAX_OUTPUT_BYTES) {
      throw new Error("A generated GLB exceeded the 256 MiB per-package safety cap.");
    }
    const padded = padBounds(candidate.bounds, candidate.latitude);
    const hashSuffix = sha256(candidate.id).slice(0, 10);
    const contentUri = `tiles/building-${String(tiles.length + 1).padStart(4, "0")}-${hashSuffix}.glb`;
    tiles.push({
      id: candidate.id,
      featureSha256: candidate.featureSha256,
      contentUri,
      contentBytes,
      contentSha256: sha256(contentBytes),
      boundsDegrees: padded,
      sourceBoundsDegrees: candidate.bounds,
      longitude: candidate.longitude,
      latitude: candidate.latitude,
      widthMeters: candidate.widthMeters,
      depthMeters: candidate.depthMeters,
    });
  }
  if (tiles.length === 0) {
    throw new Error("No valid Dhaka footprint could be triangulated in the selected bounds; no package was written.");
  }

  const combinedBounds = tiles.reduce((combined, tile) => ({
    west: Math.min(combined.west, tile.boundsDegrees.west),
    south: Math.min(combined.south, tile.boundsDegrees.south),
    east: Math.max(combined.east, tile.boundsDegrees.east),
    north: Math.max(combined.north, tile.boundsDegrees.north),
  }), { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity });
  const rootWidthMeters = (combinedBounds.east - combinedBounds.west) *
    METERS_PER_LONGITUDE_DEGREE * Math.cos(((combinedBounds.south + combinedBounds.north) / 2) * Math.PI / 180);
  const rootDepthMeters = (combinedBounds.north - combinedBounds.south) * METERS_PER_LATITUDE_DEGREE;
  const rootError = Math.max(1, rootWidthMeters, rootDepthMeters);
  const tileset = {
    asset: {
      version: "1.1",
      tilesetVersion: "dhaka-overture-multibuilding-pilot-v1",
      extras: {
        purpose: "bounded-multi-building-3d-tiles-package-pilot",
        sourceDataset: SOURCE_DESCRIPTION,
        sourceSha256: sha256(sourceBytes),
        attribution: ATTRIBUTION,
        coordinateSystems: { geographic: "EPSG:4979", globalCartesian: "EPSG:4978" },
        footprintGeometry: "source Polygon/MultiPolygon exterior and interior rings",
        heightStatus: "synthetic-test-height",
        syntheticHeightMeters,
        limitations: [
          "Synthetic extrusion height; not a surveyed building height.",
          "Interior rings are triangulated as courtyard holes with vertical boundary walls; malformed, overlapping or out-of-exterior holes are rejected.",
          "No facade reconstruction, roof reconstruction, imagery texture or photogrammetric accuracy claim.",
        ],
      },
    },
    geometricError: rootError,
    root: {
      boundingVolume: { region: boundsToRegion(combinedBounds, -0.25, syntheticHeightMeters + 0.25) },
      geometricError: rootError,
      refine: "REPLACE",
      children: tiles.map((tile) => ({
        boundingVolume: { region: boundsToRegion(tile.boundsDegrees, -0.25, syntheticHeightMeters + 0.25) },
        geometricError: 0,
        refine: "REPLACE",
        transform: localEnuToEcefTransform(tile.longitude, tile.latitude),
        content: { uri: tile.contentUri },
        extras: { sourceFeatureId: tile.id, sourceFeatureSha256: tile.featureSha256 },
      })),
    },
  };
  const validation = validateTilesetManifest(tileset);
  if (!validation.valid) {
    throw new Error(`Generated tileset failed manifest validation: ${validation.errors.join("; ")}`);
  }

  await rm(normalizedOutput, { recursive: true, force: true });
  await mkdir(path.join(normalizedOutput, "tiles"), { recursive: true });
  const fileRecords = {};
  for (const tile of tiles) {
    await writeFile(path.join(normalizedOutput, tile.contentUri), tile.contentBytes);
    fileRecords[tile.contentUri] = { sha256: tile.contentSha256, bytes: tile.contentBytes.length };
  }
  const tilesetBytes = Buffer.from(`${JSON.stringify(tileset, null, 2)}\n`, "utf8");
  await writeFile(path.join(normalizedOutput, "tileset.json"), tilesetBytes);
  fileRecords["tileset.json"] = { sha256: sha256(tilesetBytes), bytes: tilesetBytes.length };
  const buildManifest = {
    schemaVersion: 1,
    packageType: "dhaka-multibuilding-3d-tiles-pilot",
    source: {
      dataset: SOURCE_DESCRIPTION,
      relativePath: within(projectRoot, normalizedSource)
        ? path.relative(projectRoot, normalizedSource).split(path.sep).join("/")
        : "external-temporary-fixture",
      sha256: sha256(sourceBytes),
      attribution: ATTRIBUTION,
      inputBytes: sourceBytes.length,
      sourceFeatureCount: source.features.length,
    },
    configuration: {
      bounds: { ...bounds },
      maxFeatures,
      emittedFeatures: tiles.length,
      syntheticHeightMeters,
      coordinateSystems: { geographic: "EPSG:4979", globalCartesian: "EPSG:4978" },
      tileContentFormat: "glTF 2.0 binary (GLB) in OGC 3D Tiles 1.1",
    },
    excludedCounts,
    tiles: tiles.map((tile) => ({
      featureId: tile.id,
      featureSha256: tile.featureSha256,
      contentUri: tile.contentUri,
      contentSha256: tile.contentSha256,
      bytes: tile.contentBytes.length,
      sourceBoundsDegrees: tile.sourceBoundsDegrees,
      tileBoundsDegrees: tile.boundsDegrees,
      widthMeters: Number(tile.widthMeters.toFixed(3)),
      depthMeters: Number(tile.depthMeters.toFixed(3)),
    })),
    files: fileRecords,
    validation: {
      manifestValid: true,
      tileCount: validation.tileCount,
      contentCount: tiles.length,
      version: validation.version,
      packageIntegrity: "verified-after-write",
    },
    limitations: [
      "This is a bounded format/placement pilot, not a production-ready city-wide tiling system.",
      "Extrusion height is synthetic and must not be used as real building height.",
      "Polygon and MultiPolygon interior rings are preserved as holes; invalid hole topology is excluded fail-closed.",
      "No independent survey, roof/facade reconstruction, texture, rights determination or visual review is implied.",
    ],
    releaseFlags: {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
  };
  await writeFile(path.join(normalizedOutput, "build-manifest.json"), `${JSON.stringify(buildManifest, null, 2)}\n`, "utf8");

  const packageCheck = await verifyTilesetPackage({ directory: normalizedOutput });
  if (!packageCheck.valid) {
    throw new Error(`Generated package failed integrity verification: ${packageCheck.errors.join("; ")}`);
  }
  const outputBytes = Object.values(fileRecords).reduce((sum, item) => sum + item.bytes, 0);
  if (outputBytes > MAX_OUTPUT_BYTES) throw new Error(`Generated package exceeds ${MAX_OUTPUT_BYTES} bytes.`);

  return {
    packagePath: normalizedOutput,
    sourceSha256: buildManifest.source.sha256,
    emittedFeatureCount: tiles.length,
    excludedCounts,
    outputBytes,
    tilesetSha256: fileRecords["tileset.json"].sha256,
    integrity: packageCheck,
    releaseFlags: buildManifest.releaseFlags,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await buildDhaka3DTilesPackage({
      sourcePath: args.source,
      outputPath: args.output,
      maxFeatures: args.maxFeatures,
      syntheticHeightMeters: args.heightMeters,
      bounds: args.bounds,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
