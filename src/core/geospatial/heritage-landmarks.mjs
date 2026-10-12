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
export const AHSAN_MANZIL_GEOREFERENCE = Object.freeze({
  longitude: 90.40606,
  latitude: 23.70860,
  anchorConfidence: "[C]",
  longAxisAzimuthDegrees: 90,
  axisConfidence: "[E]",
  note: "Provisional anchor and approximate east-west alignment; trace the footprint and calibrate against elevation imagery before claiming survey accuracy.",
});
