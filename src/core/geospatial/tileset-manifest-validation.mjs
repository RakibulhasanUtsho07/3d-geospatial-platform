const MAX_TILES = 100_000;
const MAX_DEPTH = 64;
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isFiniteNumber(value) { return typeof value === "number" && Number.isFinite(value); }
function validateBoundingVolume(volume, path, errors) {
  if (!isRecord(volume)) { errors.push(`${path} must be an object.`); return; }
  const candidates = ["region", "box", "sphere"].filter((key) => Object.prototype.hasOwnProperty.call(volume, key));
  if (candidates.length !== 1) { errors.push(`${path} must define exactly one of region, box, or sphere.`); return; }
  const key = candidates[0], value = volume[key], expectedLength = key === "region" ? 6 : key === "box" ? 12 : 4;
  if (!Array.isArray(value) || value.length !== expectedLength || !value.every(isFiniteNumber)) {
    errors.push(`${path}.${key} must be an array of ${expectedLength} finite numbers.`); return;
  }
  if (key === "region") {
    const [west, south, east, north, minimumHeight, maximumHeight] = value;
    if (west < -Math.PI || west > Math.PI || east < -Math.PI || east > Math.PI || south < -Math.PI / 2 || south > Math.PI / 2 || north < -Math.PI / 2 || north > Math.PI / 2 || south > north || minimumHeight > maximumHeight)
      errors.push(`${path}.region contains invalid radians or inverted height/latitude bounds.`);
  } else if (key === "sphere" && value[3] < 0) errors.push(`${path}.sphere radius must be non-negative.`);
}
function validateContent(content, path, errors) {
  if (!isRecord(content)) { errors.push(`${path} must be an object.`); return; }
  const uri = content.uri ?? content.url;
  if (typeof uri !== "string" || uri.trim() === "") { errors.push(`${path} must define a non-empty uri (or legacy url).`); return; }
  if (uri.startsWith("/") || uri.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(uri)) errors.push(`${path}.uri must be a relative tileset/content path, not an absolute URL.`);
  if (uri.split(/[?#]/, 1)[0].split("/").includes("..")) errors.push(`${path}.uri must not traverse parent directories.`);
}
export function validateTilesetManifest(manifest, options = {}) {
  const errors = [];
  const maxTiles = Number.isInteger(options.maxTiles) && options.maxTiles > 0 ? Math.min(options.maxTiles, MAX_TILES) : 10_000;
  if (!isRecord(manifest)) return { valid: false, errors: ["tileset must be a JSON object."], tileCount: 0, version: null };
  if (!isRecord(manifest.asset)) errors.push("asset must be an object.");
  else {
    if (manifest.asset.version !== "1.1") errors.push('asset.version must be "1.1" for the OGC 3D Tiles 1.1 pilot.');
    if (manifest.asset.tilesetVersion !== undefined && typeof manifest.asset.tilesetVersion !== "string") errors.push("asset.tilesetVersion must be a string when present.");
  }
  if (!isFiniteNumber(manifest.geometricError) || manifest.geometricError < 0) errors.push("geometricError must be a finite non-negative number.");
  let tileCount = 0;
  const stack = [{ tile: manifest.root, depth: 1, path: "root" }];
  while (stack.length) {
    const current = stack.pop(); if (!current) continue;
    tileCount += 1;
    if (tileCount > maxTiles) { errors.push(`tileset exceeds the configured tile limit (${maxTiles}).`); break; }
    if (current.depth > MAX_DEPTH) { errors.push(`tileset exceeds the maximum hierarchy depth (${MAX_DEPTH}) at ${current.path}.`); continue; }
    const tile = current.tile;
    if (!isRecord(tile)) { errors.push(`${current.path} must be a tile object.`); continue; }
    if (!isFiniteNumber(tile.geometricError) || tile.geometricError < 0) errors.push(`${current.path}.geometricError must be finite and non-negative.`);
    validateBoundingVolume(tile.boundingVolume, `${current.path}.boundingVolume`, errors);
    if (tile.refine !== undefined && tile.refine !== "ADD" && tile.refine !== "REPLACE") errors.push(`${current.path}.refine must be ADD or REPLACE when present.`);
    if (tile.content !== undefined) validateContent(tile.content, `${current.path}.content`, errors);
    if (tile.contents !== undefined) {
      if (!Array.isArray(tile.contents) || !tile.contents.length) errors.push(`${current.path}.contents must be a non-empty array when present.`);
      else tile.contents.forEach((content, index) => validateContent(content, `${current.path}.contents[${index}]`, errors));
    }
    if (tile.children !== undefined) {
      if (!Array.isArray(tile.children)) errors.push(`${current.path}.children must be an array when present.`);
      else for (let index = tile.children.length - 1; index >= 0; index--) stack.push({ tile: tile.children[index], depth: current.depth + 1, path: `${current.path}.children[${index}]` });
    }
  }
  return { valid: errors.length === 0, errors, tileCount, version: isRecord(manifest.asset) && typeof manifest.asset.version === "string" ? manifest.asset.version : null };
}
export const TILESET_VALIDATION_LIMITS = Object.freeze({ maxTiles: MAX_TILES, maxDepth: MAX_DEPTH });
