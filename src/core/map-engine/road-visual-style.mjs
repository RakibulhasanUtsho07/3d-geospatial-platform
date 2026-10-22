const ROAD_CLASS_STYLES = Object.freeze({
  arterial: { color: "#687C8B", opacity: 0.96, outlineOpacity: 0.6 },
  collector: { color: "#91A2AF", opacity: 0.87, outlineOpacity: 0.52 },
  local: { color: "#CDD5DA", opacity: 0.76, outlineOpacity: 0.4 },
  path: { color: "#B5A88E", opacity: 0.58, outlineOpacity: 0.28 },
});

const SURFACE_COLORS = Object.freeze({
  asphalt: "#69757F",
  concrete: "#A9B0B7",
  paving_stones: "#B9B5AD",
  cobblestone: "#8B8580",
  gravel: "#9B8F7B",
  unpaved: "#B99B75",
  ground: "#AA8D6A",
  dirt: "#AA8D6A",
  earth: "#AA8D6A",
  sand: "#D0B88C",
  grass: "#72936A",
});

const MIN_ROAD_WIDTH_METERS = 1.1;
const MAX_ROAD_WIDTH_METERS = 24;

/** Resolve a consistent road hierarchy while retaining explicitly tagged surfaces. */
export function resolveRoadVisualStyle(road) {
  const requestedClass = road?.roadClass;
  const roadClass = Object.hasOwn(ROAD_CLASS_STYLES, requestedClass) ? requestedClass : "local";
  const classStyle = ROAD_CLASS_STYLES[roadClass];
  const surface = typeof road?.surface === "string" ? road.surface.toLowerCase() : "";
  const taggedWidth = typeof road?.widthMeters === "number" && Number.isFinite(road.widthMeters)
    ? road.widthMeters
    : MIN_ROAD_WIDTH_METERS;
  const widthMeters = Math.max(MIN_ROAD_WIDTH_METERS, Math.min(MAX_ROAD_WIDTH_METERS, taggedWidth));
  const layer = typeof road?.layer === "number" && Number.isFinite(road.layer) ? road.layer : 1;
  const renderHeight = road?.bridge === true
    ? Math.max(3, layer * 3)
    : road?.tunnel === true
      ? -3
      : 0;

  return {
    roadClass,
    color: SURFACE_COLORS[surface] ?? classStyle.color,
    opacity: classStyle.opacity,
    outlineOpacity: classStyle.outlineOpacity,
    widthMeters,
    renderHeight,
    hasCentreLine: roadClass === "arterial" && widthMeters >= 5,
  };
}

export const ROAD_VISUAL_LIMITS = Object.freeze({
  minWidthMeters: MIN_ROAD_WIDTH_METERS,
  maxWidthMeters: MAX_ROAD_WIDTH_METERS,
});
