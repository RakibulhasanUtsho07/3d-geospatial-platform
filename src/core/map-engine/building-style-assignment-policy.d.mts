import type { BuildingStyleAssignment } from "./types";
import type { BuildingVisualStyle } from "../buildings/building-style";

export function isValidBuildingStyleAssignment(value: unknown): value is BuildingStyleAssignment;
export function indexBuildingStyleAssignments(assignments: BuildingStyleAssignment[]): Map<string, BuildingStyleAssignment>;
export function resolveBuildingStyleBaseline(
  assignment: BuildingStyleAssignment | undefined,
  sourceStyle: BuildingVisualStyle,
): BuildingVisualStyle;
export function areBuildingVisualStylesEqual(
  left: BuildingVisualStyle,
  right: BuildingVisualStyle,
): boolean;
export function shouldReapplyBuildingStyle(input: {
  baselineChanged: boolean;
  previewWasActive: boolean;
  heightChanged: boolean;
}): boolean;
export function resolvePreviewGeometryStyle(
  previewStyle: BuildingVisualStyle | null,
  baselineStyle: BuildingVisualStyle,
): BuildingVisualStyle;
export function shouldRenderDetailedForBuildingStyle(input: {
  isSelected: boolean;
  isDetailed: boolean;
}): boolean;
