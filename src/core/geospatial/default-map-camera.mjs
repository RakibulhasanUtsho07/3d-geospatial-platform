/**
 * Initial property-discovery view for the committed Dhaka Overture building
 * dataset. Keep the heritage landmark presets separate: the Ahsan Manzil
 * anchor is south of the current building-data coverage and must be opened
 * explicitly rather than silently starting on an empty building viewport.
 */
export const DEFAULT_DHAKA_MAP_CAMERA = Object.freeze({
  longitude: 90.41,
  latitude: 23.78,
  targetHeight: 0,
  headingDegrees: 0,
  pitchDegrees: -55,
  rangeMeters: 350,
});
