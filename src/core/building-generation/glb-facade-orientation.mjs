const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const COORDINATE_FRAME = "glTF-local:+X=east,+Y=up,+Z=north";
const METHODS = new Set(["explicit-edge-index", "azimuth-nearest-edge", "longest-edge-inferred"]);
const CONFIDENCE = new Set(["verified", "derived", "estimated", "ai-proposed", "unknown", "operator-specified"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(label + " must be a finite number");
  return value;
}
function angularDistance(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function readGlbDocument(input) {
  const bytes = Buffer.isBuffer(input) ? input :
    input instanceof Uint8Array ? Buffer.from(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!bytes || bytes.length < 20) throw new TypeError("GLB input must be a Uint8Array with a JSON chunk");
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw new TypeError("GLB magic is invalid");
  if (bytes.readUInt32LE(4) !== 2) throw new TypeError("GLB version must be 2");
  if (bytes.readUInt32LE(8) !== bytes.length) throw new TypeError("GLB declared length does not match its bytes");
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== JSON_CHUNK) throw new TypeError("GLB must start with a JSON chunk");
  const jsonEnd = 20 + jsonLength;
  if (jsonLength < 2 || jsonEnd > bytes.length) throw new TypeError("GLB JSON chunk length is invalid");
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8", 20, jsonEnd).trim());
  } catch (error) {
    throw new TypeError("GLB JSON chunk is invalid: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!isObject(document)) throw new TypeError("GLB JSON root must be an object");
  return document;
}

/** Read explicit orientation metadata; legacy GLBs without it return null. */
export function extractGlbFacadeOrientation(input) {
  const document = readGlbDocument(input);
  const raw = document.extras?.building?.facadeOrientation;
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw new TypeError("GLB facadeOrientation metadata must be an object");
  if (raw.schemaVersion !== "1.0.0") throw new TypeError("GLB facadeOrientation schemaVersion is unsupported");
  if (raw.coordinateFrame !== COORDINATE_FRAME) throw new TypeError("GLB facadeOrientation coordinateFrame is unsupported");
  if (!METHODS.has(raw.selectionMethod)) throw new TypeError("GLB facadeOrientation selectionMethod is invalid");
  if (!Number.isSafeInteger(raw.edgeIndex) || raw.edgeIndex < 0) throw new TypeError("GLB facadeOrientation edgeIndex is invalid");
  if (!CONFIDENCE.has(raw.confidence)) throw new TypeError("GLB facadeOrientation confidence is invalid");
  if (typeof raw.source !== "string" || !raw.source.trim() || raw.source.length > 200) {
    throw new TypeError("GLB facadeOrientation source must be a non-empty string of at most 200 characters");
  }
  if (typeof raw.reviewRequired !== "boolean") throw new TypeError("GLB facadeOrientation reviewRequired must be boolean");
  const requestedAzimuthDegrees = raw.requestedAzimuthDegrees === null ? null :
    finite(raw.requestedAzimuthDegrees, "facadeOrientation.requestedAzimuthDegrees");
  if (requestedAzimuthDegrees !== null && (requestedAzimuthDegrees < 0 || requestedAzimuthDegrees > 360)) {
    throw new RangeError("GLB facadeOrientation requestedAzimuthDegrees must be between 0 and 360");
  }
  const actualAzimuthDegrees = finite(raw.actualAzimuthDegrees, "facadeOrientation.actualAzimuthDegrees");
  if (actualAzimuthDegrees < 0 || actualAzimuthDegrees > 360) {
    throw new RangeError("GLB facadeOrientation actualAzimuthDegrees must be between 0 and 360");
  }
  if (!isObject(raw.outwardNormal)) throw new TypeError("GLB facadeOrientation outwardNormal must be an object");
  const outwardNormal = {
    x: finite(raw.outwardNormal.x, "facadeOrientation.outwardNormal.x"),
    z: finite(raw.outwardNormal.z, "facadeOrientation.outwardNormal.z"),
  };
  if (Math.abs(Math.hypot(outwardNormal.x, outwardNormal.z) - 1) > 1e-3) {
    throw new TypeError("GLB facadeOrientation outwardNormal must be unit length");
  }
  const normalAzimuth = (Math.atan2(outwardNormal.x, outwardNormal.z) * 180 / Math.PI + 360) % 360;
  if (angularDistance(normalAzimuth, actualAzimuthDegrees) > 0.05) {
    throw new TypeError("GLB facadeOrientation azimuth does not match its outwardNormal");
  }
  return {
    schemaVersion: raw.schemaVersion, coordinateFrame: raw.coordinateFrame,
    selectionMethod: raw.selectionMethod, edgeIndex: raw.edgeIndex,
    requestedAzimuthDegrees, actualAzimuthDegrees, outwardNormal,
    confidence: raw.confidence, source: raw.source, reviewRequired: raw.reviewRequired,
  };
}

/** glTF +Z north maps to Blender -Y; the GLB vertices are not transformed. */
export function toBlenderCameraDirection(orientation, elevationDegrees = 5) {
  if (!isObject(orientation) || !isObject(orientation.outwardNormal)) {
    throw new TypeError("a validated facade orientation is required");
  }
  finite(elevationDegrees, "elevationDegrees");
  if (elevationDegrees < 0 || elevationDegrees > 60) throw new RangeError("elevationDegrees must be between 0 and 60");
  const x = finite(orientation.outwardNormal.x, "outwardNormal.x");
  const z = finite(orientation.outwardNormal.z, "outwardNormal.z");
  if (Math.abs(Math.hypot(x, z) - 1) > 1e-3) throw new TypeError("outwardNormal must be unit length");
  const elevation = elevationDegrees * Math.PI / 180;
  const horizontal = Math.cos(elevation);
  const vector = [x * horizontal, -z * horizontal, Math.sin(elevation)];
  const norm = Math.hypot(...vector);
  return vector.map(value => Number((value / norm).toFixed(9)));
}
