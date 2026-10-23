const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Reject malformed assignments before they can become the active baseline. */
export function isValidBuildingStyleAssignment(value) {
  if (!value || typeof value !== "object") return false;
  const assignment = value;
  if (
    typeof assignment.featureId !== "string" ||
    !assignment.featureId.trim() ||
    !assignment.style ||
    typeof assignment.style !== "object"
  ) {
    return false;
  }

  const style = assignment.style;
  return (
    typeof style.facadeColor === "string" &&
    HEX_COLOR.test(style.facadeColor) &&
    typeof style.roofColor === "string" &&
    HEX_COLOR.test(style.roofColor) &&
    typeof style.accentColor === "string" &&
    HEX_COLOR.test(style.accentColor)
  );
}

/** Match adapter behavior: later valid assignments replace earlier ones for the same exact feature ID. */
export function indexBuildingStyleAssignments(assignments) {
  const indexed = new Map();
  for (const assignment of assignments) {
    if (isValidBuildingStyleAssignment(assignment)) {
      indexed.set(assignment.featureId, assignment);
    }
  }
  return indexed;
}

export function resolveBuildingStyleBaseline(assignment, sourceStyle) {
  return assignment?.style ?? sourceStyle;
}

/** Keep the historical order-sensitive JSON comparison used by the adapter. */
export function areBuildingVisualStylesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function shouldReapplyBuildingStyle(input) {
  return input.baselineChanged || input.previewWasActive || input.heightChanged;
}

export function resolvePreviewGeometryStyle(previewStyle, baselineStyle) {
  return previewStyle && (
    typeof previewStyle.reportedHeightMeters === "number" ||
    typeof previewStyle.reportedFloorCount === "number"
  )
    ? previewStyle
    : baselineStyle;
}

export function shouldRenderDetailedForBuildingStyle(input) {
  return input.isSelected || input.isDetailed;
}
