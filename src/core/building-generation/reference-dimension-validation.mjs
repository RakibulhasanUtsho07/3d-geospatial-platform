const AXES = Object.freeze(["x", "y", "z"]);

function finitePositive(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(label + " must be a finite number greater than zero");
  }
  return value;
}

/**
 * Compare axis-aligned GLB bounds with independently measured reference dimensions.
 * This is a dimensional consistency check, not a surface-to-surface accuracy metric.
 */
export function validateReferenceDimensions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("dimension validation options must be an object");
  }
  const measured = options.measuredModelDimensions;
  const reference = options.referenceDimensionsM;
  if (!measured || typeof measured !== "object" || Array.isArray(measured)) {
    throw new TypeError("measuredModelDimensions must be an x/y/z object");
  }
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new TypeError("referenceDimensionsM must be an x/y/z object");
  }
  const metresPerModelUnit = finitePositive(options.metresPerModelUnit, "metresPerModelUnit");
  const tolerancePercent = options.tolerancePercent ?? 5;
  if (typeof tolerancePercent !== "number" || !Number.isFinite(tolerancePercent) || tolerancePercent < 0.1 || tolerancePercent > 100) {
    throw new RangeError("tolerancePercent must be between 0.1 and 100");
  }
  const axisMapping = options.axisMapping ?? { x: "x", y: "y", z: "z" };
  if (!axisMapping || typeof axisMapping !== "object" || Array.isArray(axisMapping)) {
    throw new TypeError("axisMapping must map model x/y/z to reference x/y/z");
  }
  const mapped = AXES.map((modelAxis) => {
    const referenceAxis = axisMapping[modelAxis];
    if (!AXES.includes(referenceAxis)) throw new TypeError("axisMapping." + modelAxis + " must be x, y or z");
    return { modelAxis, referenceAxis };
  });
  if (new Set(mapped.map((item) => item.referenceAxis)).size !== 3) {
    throw new TypeError("axisMapping must map each axis to a unique reference axis");
  }

  const axes = mapped.map(({ modelAxis, referenceAxis }) => {
    const modelUnits = finitePositive(measured[modelAxis], "measuredModelDimensions." + modelAxis);
    const expectedM = finitePositive(reference[referenceAxis], "referenceDimensionsM." + referenceAxis);
    const measuredM = modelUnits * metresPerModelUnit;
    const absoluteErrorM = Math.abs(measuredM - expectedM);
    const relativeErrorPercent = absoluteErrorM / expectedM * 100;
    return {
      modelAxis,
      referenceAxis,
      measuredModelUnits: modelUnits,
      measuredM: Number(measuredM.toFixed(4)),
      referenceM: expectedM,
      absoluteErrorM: Number(absoluteErrorM.toFixed(4)),
      relativeErrorPercent: Number(relativeErrorPercent.toFixed(3)),
      withinTolerance: relativeErrorPercent <= tolerancePercent,
    };
  });
  const maxRelativeErrorPercent = Math.max(...axes.map((axis) => axis.relativeErrorPercent));
  const rmsRelativeErrorPercent = Math.sqrt(axes.reduce((sum, axis) => sum + axis.relativeErrorPercent ** 2, 0) / axes.length);
  const withinTolerance = axes.every((axis) => axis.withinTolerance);
  return {
    schemaVersion: "1.0.0",
    engine: "reference-dimension-validation-v1",
    status: withinTolerance ? "dimension-check-passed-review-required" : "dimension-mismatch-review-required",
    method: "axis-aligned GLB bounds compared with operator-supplied reference dimensions",
    units: "metres",
    metresPerModelUnit,
    tolerancePercent,
    axisMapping: Object.fromEntries(mapped.map(({ modelAxis, referenceAxis }) => [modelAxis, referenceAxis])),
    axes,
    maxRelativeErrorPercent: Number(maxRelativeErrorPercent.toFixed(3)),
    rmsRelativeErrorPercent: Number(rmsRelativeErrorPercent.toFixed(3)),
    mapReady: false,
    publicationEligible: false,
    limitations: [
      "Reference dimensions must come from trustworthy independent measurements; guessed values are not ground truth.",
      "Axis-aligned bounds can change when a building is rotated, irregular, tilted or contains protrusions.",
      "A dimension match does not validate facade shape, floor layout, texture alignment, camera calibration, vertical datum or WGS84 placement.",
      "A passing result is a dimensional sanity check only and still requires visual and human review.",
    ],
  };
}
