export interface RoadVisualStyleInput {
  roadClass?: string | null;
  surface?: string | null;
  widthMeters?: number | null;
  layer?: number | null;
  bridge?: boolean;
  tunnel?: boolean;
}
export interface RoadVisualStyle {
  roadClass: "arterial" | "collector" | "local" | "path";
  color: string;
  opacity: number;
  outlineOpacity: number;
  widthMeters: number;
  renderHeight: number;
  hasCentreLine: boolean;
}
export function resolveRoadVisualStyle(road: RoadVisualStyleInput): RoadVisualStyle;
export const ROAD_VISUAL_LIMITS: Readonly<{ minWidthMeters: number; maxWidthMeters: number }>;
