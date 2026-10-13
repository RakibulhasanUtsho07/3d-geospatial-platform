/** Shared geospatial constants for the default heritage camera and Ahsan Manzil asset. */
export const SHAT_GOMBUJ_CAMERA_TARGET = Object.freeze({
  longitude: 89.7417917,
  latitude: 22.6744861,
  height: 250,
});
export const SHAT_GOMBUJ_CAMERA_ORIENTATION = Object.freeze({
  heading: 0,
  pitch: -82,
  roll: 0,
});
export const SHAT_GOMBUJ_CAMERA = Object.freeze({
  ...SHAT_GOMBUJ_CAMERA_TARGET,
  ...SHAT_GOMBUJ_CAMERA_ORIENTATION,
});

/**
 * Ahsan Manzil's provisional world anchor. The viewer uses these as camera
 * targets, not as the camera's own positions. The front offset is [E] and is
 * kept separate from the provisional georeference so it never silently moves
 * the building or changes its claimed geographic accuracy.
 */
export const AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS = 31.35;
const AHSAN_MANZIL_ANCHOR_LONGITUDE = 90.40606;
const AHSAN_MANZIL_ANCHOR_LATITUDE = 23.70860;
const METERS_PER_LONGITUDE_DEGREE = 111_319.49 * Math.cos(
  (AHSAN_MANZIL_ANCHOR_LATITUDE * Math.PI) / 180,
);
const AHSAN_MANZIL_FRONT_LONGITUDE = Number((
  AHSAN_MANZIL_ANCHOR_LONGITUDE +
  AHSAN_MANZIL_FRONT_FOCUS_OFFSET_EAST_METERS / METERS_PER_LONGITUDE_DEGREE
).toFixed(6));

export const AHSAN_MANZIL_CAMERA_RANGE_METERS = 160;
export const AHSAN_MANZIL_FOOTPRINT_CAMERA_RANGE_METERS = 205;
export const AHSAN_MANZIL_ORBIT_PITCH_DEGREES = -18;
export const AHSAN_MANZIL_ORBIT_DEGREES_PER_SECOND = 10;
export const AHSAN_MANZIL_FRONT_BOUNDING_RADIUS_METERS = 98;
export const AHSAN_MANZIL_FOOTPRINT_BOUNDING_RADIUS_METERS = 72;

export const AHSAN_MANZIL_CAMERA_TARGET = Object.freeze({
  longitude: AHSAN_MANZIL_FRONT_LONGITUDE,
  latitude: AHSAN_MANZIL_ANCHOR_LATITUDE,
  height: 10,
});
export const AHSAN_MANZIL_FOOTPRINT_CAMERA_TARGET = Object.freeze({
  longitude: AHSAN_MANZIL_ANCHOR_LONGITUDE,
  latitude: AHSAN_MANZIL_ANCHOR_LATITUDE,
  height: 10,
});
export const AHSAN_MANZIL_CAMERA_ORIENTATION = Object.freeze({
  heading: 180,
  pitch: AHSAN_MANZIL_ORBIT_PITCH_DEGREES,
  roll: 0,
});
export const AHSAN_MANZIL_CAMERA = Object.freeze({
  ...AHSAN_MANZIL_CAMERA_TARGET,
  ...AHSAN_MANZIL_CAMERA_ORIENTATION,
});

export const AHSAN_MANZIL_GEOREFERENCE = Object.freeze({
  longitude: 90.40606,
  latitude: 23.70860,
  anchorConfidence: "[C]",
  longAxisAzimuthDegrees: 90,
  axisConfidence: "[E]",
  note: "Provisional anchor and approximate east-west alignment; trace the footprint and calibrate against elevation imagery before claiming survey accuracy.",
});

/**
 * Estimated camera-distance LOD thresholds. These are rendering parameters,
 * not historic-building facts; mirrored with confidence tags in the parameter JSON.
 */
export const AHSAN_MANZIL_LOD_THRESHOLDS = Object.freeze({
  lod3: Object.freeze({ maxDistanceMeters: 2_000, maxCameraHeightMeters: 2_500 }),
  lod2: Object.freeze({ maxDistanceMeters: 6_500, maxCameraHeightMeters: 8_000 }),
  lod1: Object.freeze({ maxDistanceMeters: 18_000, maxCameraHeightMeters: 20_000 }),
});

export function selectAhsanManzilLod(distanceMeters, cameraHeightMeters) {
  if (
    !Number.isFinite(distanceMeters) ||
    !Number.isFinite(cameraHeightMeters) ||
    distanceMeters < 0 ||
    cameraHeightMeters < 0
  ) return null;

  if (
    distanceMeters <= AHSAN_MANZIL_LOD_THRESHOLDS.lod3.maxDistanceMeters &&
    cameraHeightMeters <= AHSAN_MANZIL_LOD_THRESHOLDS.lod3.maxCameraHeightMeters
  ) return 3;

  if (
    distanceMeters <= AHSAN_MANZIL_LOD_THRESHOLDS.lod2.maxDistanceMeters &&
    cameraHeightMeters <= AHSAN_MANZIL_LOD_THRESHOLDS.lod2.maxCameraHeightMeters
  ) return 2;

  if (
    distanceMeters <= AHSAN_MANZIL_LOD_THRESHOLDS.lod1.maxDistanceMeters &&
    cameraHeightMeters <= AHSAN_MANZIL_LOD_THRESHOLDS.lod1.maxCameraHeightMeters
  ) return 1;

  return null;
}
