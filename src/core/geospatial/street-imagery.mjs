const DEFAULT_RADIUS_METERS = 250;
const MIN_RADIUS_METERS = 50;
const MAX_RADIUS_METERS = 500;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const EARTH_RADIUS_METERS = 6_371_008.8;

function isFiniteRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function safeIntegerParam(params, name, fallback, min, max) {
  const raw = params.get(name);
  if (raw === null) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: name + " must be a whole number between " + min + " and " + max + "." };
  }
  return { ok: true, value };
}

export function parseStreetImageryParams(params) {
  const rawLatitude = params.get("lat");
  const rawLongitude = params.get("lon");

  if (rawLatitude === null || rawLongitude === null) {
    return { ok: false, error: "Latitude (lat) and longitude (lon) are required." };
  }

  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  if (!isFiniteRange(latitude, -90, 90) || !isFiniteRange(longitude, -180, 180)) {
    return { ok: false, error: "Latitude must be between -90 and 90 and longitude between -180 and 180." };
  }

  const radius = safeIntegerParam(params, "radius", DEFAULT_RADIUS_METERS, MIN_RADIUS_METERS, MAX_RADIUS_METERS);
  if (!radius.ok) return radius;
  const limit = safeIntegerParam(params, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (!limit.ok) return limit;

  return {
    ok: true,
    value: { latitude, longitude, radiusMeters: radius.value, limit: limit.value },
  };
}

export function haversineDistanceMeters(latitudeA, longitudeA, latitudeB, longitudeB) {
  const radians = Math.PI / 180;
  const deltaLatitude = (latitudeB - latitudeA) * radians;
  const deltaLongitude = (longitudeB - longitudeA) * radians;
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(latitudeA * radians) * Math.cos(latitudeB * radians)
    * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

function asFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function safeText(value, maxLength = 160) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function safeMediaUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const permittedHost = hostname === "openstreetcam.org"
      || hostname.endsWith(".openstreetcam.org")
      || hostname === "kartaview.org"
      || hostname.endsWith(".kartaview.org");
    if (url.protocol !== "https:" || url.username || url.password || !permittedHost) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function getPhotoCollection(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const result = payload.result;
  if (result && typeof result === "object" && !Array.isArray(result) && Array.isArray(result.data)) {
    return result.data;
  }
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

export function normalizeKartaViewPhotos(payload, request) {
  const collection = getPhotoCollection(payload);
  const seen = new Set();
  const photos = [];

  for (const record of collection) {
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;

    const visibility = safeText(record.visibility, 24)?.toLowerCase();
    const status = safeText(record.status, 32)?.toLowerCase();
    // Do not surface private or deleted imagery. When visibility is missing,
    // the public API's default result is still eligible after URL validation.
    if (visibility && visibility !== "public") continue;
    if (status === "deleted" || status === "inactive") continue;

    const latitude = asFiniteNumber(record.lat ?? record.latitude);
    const longitude = asFiniteNumber(record.lng ?? record.lon ?? record.longitude);
    const idValue = record.id ?? record.photoId ?? record.photo_id;
    const id = typeof idValue === "number" || typeof idValue === "string"
      ? String(idValue).trim().slice(0, 100)
      : "";
    if (!id || !isFiniteRange(latitude, -90, 90) || !isFiniteRange(longitude, -180, 180)) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    const distanceMeters = haversineDistanceMeters(
      request.latitude,
      request.longitude,
      latitude,
      longitude,
    );
    if (distanceMeters > request.radiusMeters) continue;

    const thumbnailUrl = safeMediaUrl(
      record.fileurlLTh
      ?? record.fileurlTh
      ?? record.fileurl_th
      ?? record.thumbnailUrl
      ?? record.fileurl
      ?? record.url,
    );
    const imageUrl = safeMediaUrl(
      record.fileurlProc
      ?? record.fileurl
      ?? record.url
      ?? record.fileurlLTh
      ?? record.fileurlTh,
    );
    if (!thumbnailUrl) continue;

    const sequenceId = safeText(String(record.sequenceId ?? record.sequence_id ?? ""), 80);
    const videoId = safeText(String(record.videoId ?? record.video_id ?? ""), 80);
    const isVideoFrame = Boolean(videoId)
      || record.isVideo === true
      || record.isVideo === 1
      || record.isVideo === "1"
      || record.is_video === true
      || record.is_video === "1";
    const heading = asFiniteNumber(record.heading);
    const captureDate = safeText(
      record.shotDate ?? record.shot_date ?? record.dateAdded ?? record.date_added,
      80,
    );
    const username = safeText(record.username ?? record.userName ?? record.user_name, 100);

    photos.push({
      id,
      sequenceId,
      videoId,
      latitude,
      longitude,
      headingDegrees: heading !== null && heading >= 0 && heading <= 360 ? heading : null,
      distanceMeters: Math.round(distanceMeters),
      captureDate,
      username,
      mediaKind: isVideoFrame ? "video-frame" : "photo",
      thumbnailUrl,
      imageUrl,
      sourceUrl: "https://kartaview.org",
      license: "CC BY-SA 4.0",
      attribution: "© Grab and KartaView Contributors",
    });
  }

  photos.sort((left, right) =>
    left.distanceMeters - right.distanceMeters || left.id.localeCompare(right.id),
  );

  return photos.slice(0, request.limit);
}

export function assessReconstructionReadiness(photos) {
  if (!Array.isArray(photos) || photos.length === 0) {
    return {
      level: "estimated",
      title: "Estimated architecture",
      detail: "No usable public street imagery was returned for this location. The current model remains an estimated footprint/height extrusion.",
      distinctCapturePoints: 0,
    };
  }

  const capturePoints = new Set(
    photos
      .filter((photo) => Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude))
      .map((photo) => photo.latitude.toFixed(5) + "," + photo.longitude.toFixed(5)),
  );

  if (photos.length >= 3 && capturePoints.size >= 3) {
    return {
      level: "multi-view-candidate",
      title: "Potential multi-view reference",
      detail: "Multiple capture positions may help a photogrammetry workflow. A valid textured mesh has not been reconstructed or verified yet.",
      distinctCapturePoints: capturePoints.size,
    };
  }

  return {
    level: "reference-only",
    title: "Facade reference only",
    detail: "The imagery can guide a visual facade estimate, but it is not enough evidence to claim a complete or accurate 3D reconstruction.",
    distinctCapturePoints: capturePoints.size,
  };
}

export const STREET_IMAGERY_LIMITS = Object.freeze({
  defaultRadiusMeters: DEFAULT_RADIUS_METERS,
  minRadiusMeters: MIN_RADIUS_METERS,
  maxRadiusMeters: MAX_RADIUS_METERS,
  defaultLimit: DEFAULT_LIMIT,
  maxLimit: MAX_LIMIT,
});
