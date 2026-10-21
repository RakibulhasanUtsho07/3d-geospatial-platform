const finite = (value) => typeof value === "number" && Number.isFinite(value);
const sha256Pattern = /^[a-f0-9]{64}$/i;

function validateImages(images) {
  if (!Array.isArray(images) || images.length === 0) throw new TypeError("images must be a non-empty array");
  const ids = new Set();
  for (const image of images) {
    if (!image || typeof image.id !== "string" || !image.id || ids.has(image.id)) {
      throw new TypeError("images must have unique, non-empty string IDs");
    }
    ids.add(image.id);
    if (!Number.isInteger(image.width) || image.width < 1 || !Number.isInteger(image.height) || image.height < 1) {
      throw new TypeError(`image ${image.id} must have positive integer dimensions`);
    }
    if (image.verifiedSource !== true || !sha256Pattern.test(image.sha256 ?? "")) {
      throw new TypeError(`image ${image.id} requires verifiedSource=true and a SHA-256 hash`);
    }
  }
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function contains(a, b) {
  return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

function pruneFreeRects(rects) {
  const result = [];
  for (let i = 0; i < rects.length; i++) {
    let redundant = false;
    for (let j = 0; j < rects.length; j++) {
      if (i !== j && contains(rects[j], rects[i]) &&
        (rects[j].x !== rects[i].x || rects[j].y !== rects[i].y || rects[j].w !== rects[i].w || rects[j].h !== rects[i].h || j < i)) {
        redundant = true;
        break;
      }
    }
    if (!redundant) result.push(rects[i]);
  }
  return result;
}

function packAtScale(images, width, height, padding, scale) {
  const free = [{ x: 0, y: 0, w: width, h: height }];
  const prepared = images.map((image) => {
    const contentWidth = Math.max(1, Math.floor(image.width * scale));
    const contentHeight = Math.max(1, Math.floor(image.height * scale));
    return { ...image, contentWidth, contentHeight, w: contentWidth + 2 * padding, h: contentHeight + 2 * padding };
  }).sort((a,b) => (b.w*b.h - a.w*a.h) || (Math.max(b.w,b.h)-Math.max(a.w,a.h)) || a.id.localeCompare(b.id));
  const placements = new Map();
  for (const item of prepared) {
    let bestIndex = -1, bestScore = Infinity, bestLong = Infinity;
    for (let i = 0; i < free.length; i++) {
      const rect = free[i];
      if (item.w > rect.w || item.h > rect.h) continue;
      const dw = rect.w - item.w, dh = rect.h - item.h;
      const short = Math.min(dw, dh), long = Math.max(dw, dh);
      if (short < bestScore || (short === bestScore && long < bestLong) ||
        (short === bestScore && long === bestLong && (rect.y < free[bestIndex]?.y || (rect.y === free[bestIndex]?.y && rect.x < free[bestIndex]?.x)))) {
        bestIndex = i; bestScore = short; bestLong = long;
      }
    }
    if (bestIndex < 0) return null;
    const chosen = free[bestIndex];
    const used = { x: chosen.x, y: chosen.y, w: item.w, h: item.h };
    const next = [];
    for (const rect of free) {
      if (!intersects(rect, used)) { next.push(rect); continue; }
      if (used.x > rect.x) next.push({ x: rect.x, y: rect.y, w: used.x - rect.x, h: rect.h });
      if (used.x + used.w < rect.x + rect.w) next.push({ x: used.x + used.w, y: rect.y, w: rect.x + rect.w - (used.x + used.w), h: rect.h });
      if (used.y > rect.y) next.push({ x: rect.x, y: rect.y, w: rect.w, h: used.y - rect.y });
      if (used.y + used.h < rect.y + rect.h) next.push({ x: rect.x, y: used.y + used.h, w: rect.w, h: rect.y + rect.h - (used.y + used.h) });
    }
    free.splice(0, free.length, ...pruneFreeRects(next));
    placements.set(item.id, {
      id: item.id,
      x: used.x + padding,
      y: used.y + padding,
      outerX: used.x,
      outerY: used.y,
      width: item.contentWidth,
      height: item.contentHeight,
      outerWidth: used.w,
      outerHeight: used.h,
      sourceWidth: item.width,
      sourceHeight: item.height,
      scaleX: item.contentWidth / item.width,
      scaleY: item.contentHeight / item.height,
      padding,
    });
  }
  return placements;
}

export function packTextureAtlas(images, options = {}) {
  validateImages(images);
  const width = options.width ?? 4096;
  const height = options.height ?? 4096;
  const padding = options.padding ?? 4;
  const allowDownscale = options.allowDownscale ?? true;
  if (![width, height].every((n) => Number.isInteger(n) && n > 0)) throw new RangeError("atlas width and height must be positive integers");
  if (!Number.isInteger(padding) || padding < 0 || padding * 2 >= width || padding * 2 >= height) {
    throw new RangeError("padding must be a non-negative integer smaller than half of each atlas dimension");
  }
  let placements = packAtScale(images, width, height, padding, 1);
  let scale = 1;
  if (!placements) {
    if (!allowDownscale) throw new RangeError("images do not fit atlas at source resolution; enable downscaling or enlarge the atlas");
    const minimum = packAtScale(images, width, height, padding, 0);
    if (!minimum) throw new RangeError("too many images to fit even at 1x1 content size with the requested padding");
    let low = 0, high = 1, best = minimum;
    for (let i = 0; i < 32; i++) {
      const mid = (low + high) / 2;
      const attempt = packAtScale(images, width, height, padding, mid);
      if (attempt) { low = mid; best = attempt; } else high = mid;
    }
    scale = low;
    placements = best;
  }
  return {
    schemaVersion: "1.0.0",
    width,
    height,
    padding,
    uniformScale: scale,
    coordinateOrigin: "top-left-pixels",
    uvConvention: "normalized-bottom-left",
    placements: images.map((image) => placements.get(image.id)),
    policy: { imageRotation: false, aspectRatioPreserved: true, paddingExtrusionRequiredForBake: padding > 0 },
  };
}

export function remapUvToAtlas(uv, placement, atlasWidth, atlasHeight) {
  if (!Array.isArray(uv) || uv.length !== 2 || uv.some((n) => !finite(n) || n < 0 || n > 1)) {
    throw new TypeError("uv must be a normalized [u,v] pair in [0,1]");
  }
  if (!placement || ![placement.x, placement.y, placement.width, placement.height].every((n) => Number.isInteger(n)) ||
    placement.width < 1 || placement.height < 1 || !Number.isInteger(atlasWidth) || atlasWidth < 1 ||
    !Number.isInteger(atlasHeight) || atlasHeight < 1) {
    throw new TypeError("valid atlas placement and positive integer atlas dimensions are required");
  }
  return [
    (placement.x + uv[0] * placement.width) / atlasWidth,
    (atlasHeight - placement.y - placement.height + uv[1] * placement.height) / atlasHeight,
  ];
}

export function remapFacesToAtlas(faces, atlas) {
  if (!Array.isArray(faces) || !atlas || !Array.isArray(atlas.placements)) {
    throw new TypeError("faces and atlas placements are required");
  }
  const placementById = new Map(atlas.placements.map((placement) => [placement.id, placement]));
  return faces.map((face, index) => {
    const placement = placementById.get(face?.sourceImageId);
    if (!placement) throw new Error(`face ${index} references an image not present in the atlas`);
    if (!Array.isArray(face.uv) || face.uv.length !== 3) throw new TypeError(`face ${index} must have three UV pairs`);
    return {
      ...face,
      sourceUv: face.uv.map((uv) => uv.slice()),
      uv: face.uv.map((uv) => remapUvToAtlas(uv, placement, atlas.width, atlas.height)),
      atlasId: "main",
    };
  });
}
