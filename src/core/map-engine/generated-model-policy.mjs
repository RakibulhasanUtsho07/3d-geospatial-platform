function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFiniteRange(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(label + " must be a finite number between " + minimum + " and " + maximum + ".");
  }
  return value;
}

function isSafeModelUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || value !== value.trim()) return false;
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("\\")) return false;
    const rawPath = value.split(/[?#]/, 1)[0];
    let decodedPath = rawPath;
    try { decodedPath = decodeURIComponent(rawPath); } catch { return false; }
    return !decodedPath.split("/").some((segment) => segment === ".." || segment === ".");
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function readAngle(value, label, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  return requireFiniteRange(value, label, minimum, maximum);
}

function readAxis(value, label, fallback) {
  const axis = value === undefined ? fallback : value;
  if (axis !== "X" && axis !== "Y" && axis !== "Z") {
    throw new TypeError(label + " must be one of X, Y or Z.");
  }
  return axis;
}

/**
 * Validate and normalize a declarative single-model placement before handing it to Cesium.
 * Only same-origin absolute paths or HTTPS asset URLs are accepted; data: and blob: URLs are rejected.
 */
export function normalizeGeneratedModelDefinition(value) {
  if (!isRecord(value)) throw new TypeError("Generated model definition must be an object.");

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) {
    throw new TypeError("Model id must start with a letter or number and contain at most 160 safe characters.");
  }
  if (!isSafeModelUrl(value.url)) {
    throw new TypeError("Model URL must be a same-origin absolute path or a valid HTTPS URL without credentials.");
  }
  if (!isRecord(value.position)) throw new TypeError("Model position is required.");

  const position = {
    longitude: requireFiniteRange(value.position.longitude, "Longitude", -180, 180),
    latitude: requireFiniteRange(value.position.latitude, "Latitude", -90, 90),
    height: value.position.height === undefined
      ? 0
      : requireFiniteRange(value.position.height, "Height", -12000, 9000000),
  };
  const headingDegrees = readAngle(value.headingDegrees, "Heading", 0, -360, 360);
  const pitchDegrees = readAngle(value.pitchDegrees, "Pitch", 0, -90, 90);
  const rollDegrees = readAngle(value.rollDegrees, "Roll", 0, -360, 360);
  const scale = value.scale === undefined ? 1 : requireFiniteRange(value.scale, "Scale", 0.001, 1000);
  const minimumPixelSize = value.minimumPixelSize === undefined
    ? 0
    : requireFiniteRange(value.minimumPixelSize, "Minimum pixel size", 0, 512);
  const show = value.show === undefined ? true : value.show;
  if (typeof show !== "boolean") throw new TypeError("Model show must be a boolean.");

  const upAxis = readAxis(value.upAxis, "Up axis", "Y");
  const forwardAxis = readAxis(value.forwardAxis, "Forward axis", "Z");
  if (upAxis === forwardAxis) throw new RangeError("Model up axis and forward axis must be different.");

  const result = {
    id,
    url: value.url,
    position,
    headingDegrees,
    pitchDegrees,
    rollDegrees,
    scale,
    minimumPixelSize,
    show,
    upAxis,
    forwardAxis,
  };

  if (value.name !== undefined) {
    if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.length > 200) {
      throw new TypeError("Model name must be a non-empty string of at most 200 characters when supplied.");
    }
    result.name = value.name.trim();
  }
  if (value.maximumScale !== undefined) {
    result.maximumScale = requireFiniteRange(value.maximumScale, "Maximum scale", 1, 100000);
  }
  return result;
}
