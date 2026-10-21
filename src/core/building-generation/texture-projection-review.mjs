const finite = (value) => typeof value === "number" && Number.isFinite(value);
const sha256Pattern = /^[a-f0-9]{64}$/i;

export function reviewTextureProjection(candidate, options = {}) {
  if (!candidate || !Array.isArray(candidate.images) || !Array.isArray(candidate.cameraCalibrations) || !Array.isArray(candidate.faces)) {
    throw new TypeError("candidate must contain images, cameraCalibrations and faces arrays");
  }
  const maxReprojectionErrorPx = options.maxReprojectionErrorPx ?? 2;
  if (!finite(maxReprojectionErrorPx) || maxReprojectionErrorPx < 0) {
    throw new RangeError("maxReprojectionErrorPx must be a non-negative finite number");
  }
  const images = new Map();
  const calibrations = new Map();
  const duplicateImageIds = [];
  const duplicateCalibrationIds = [];
  for (const image of candidate.images) {
    if (!image || typeof image.id !== "string" || !image.id || images.has(image.id)) {
      duplicateImageIds.push(image?.id ?? null);
      continue;
    }
    images.set(image.id, image);
  }
  for (const calibration of candidate.cameraCalibrations) {
    if (!calibration || typeof calibration.id !== "string" || !calibration.id || calibrations.has(calibration.id)) {
      duplicateCalibrationIds.push(calibration?.id ?? null);
      continue;
    }
    calibrations.set(calibration.id, calibration);
  }

  const rejectedFaces = [];
  const acceptedFaceIndices = [];
  const sourceImageUsage = new Map();
  const uvBounds = { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
  candidate.faces.forEach((face, index) => {
    const reasons = [];
    if (!face || !Array.isArray(face.vertices) || face.vertices.length !== 3 ||
      face.vertices.some((id) => typeof id !== "string" || !id) || new Set(face.vertices).size !== 3) {
      reasons.push("face-must-reference-three-distinct-vertex-ids");
    }
    if (!Array.isArray(face?.uv) || face.uv.length !== 3 ||
      face.uv.some((pair) => !Array.isArray(pair) || pair.length !== 2 || pair.some((n) => !finite(n)))) {
      reasons.push("missing-or-invalid-corner-uvs");
    } else {
      for (const [u,v] of face.uv) {
        uvBounds.minU = Math.min(uvBounds.minU,u);
        uvBounds.minV = Math.min(uvBounds.minV,v);
        uvBounds.maxU = Math.max(uvBounds.maxU,u);
        uvBounds.maxV = Math.max(uvBounds.maxV,v);
        if (u < 0 || u > 1 || v < 0 || v > 1) reasons.push("uv-out-of-normalized-range");
      }
    }
    const image = images.get(face?.sourceImageId);
    if (!image) reasons.push("unknown-source-image");
    else {
      if (image.verifiedSource !== true) reasons.push("source-image-not-verified");
      if (!sha256Pattern.test(image.sha256 ?? "")) reasons.push("source-image-sha256-missing-or-invalid");
      if (!Number.isInteger(image.width) || image.width < 1 || !Number.isInteger(image.height) || image.height < 1) {
        reasons.push("source-image-dimensions-invalid");
      }
      sourceImageUsage.set(image.id, (sourceImageUsage.get(image.id) ?? 0) + 1);
    }
    const calibration = calibrations.get(face?.cameraCalibrationId);
    if (!calibration) reasons.push("camera-calibration-not-found");
    else {
      if (calibration.status !== "verified") reasons.push("camera-calibration-not-verified");
      if (!finite(calibration.reprojectionErrorPx)) reasons.push("calibration-reprojection-error-missing");
      else if (calibration.reprojectionErrorPx > maxReprojectionErrorPx) reasons.push("calibration-reprojection-error-exceeds-threshold");
    }
    if (reasons.length) rejectedFaces.push({ index, reasons: [...new Set(reasons)] });
    else acceptedFaceIndices.push(index);
  });

  const blockers = [];
  if (duplicateImageIds.length) blockers.push("duplicate-image-ids");
  if (duplicateCalibrationIds.length) blockers.push("duplicate-calibration-ids");
  if (rejectedFaces.length) blockers.push("faces-failed-evidence-validation");
  if (acceptedFaceIndices.length === 0 && candidate.faces.length > 0) blockers.push("no-faces-eligible-for-texture-projection");
  const noUv = uvBounds.minU === Infinity;
  return {
    schemaVersion: "1.0.0",
    status: blockers.length ? "review-required" : "evidence-validation-passed",
    faceCount: candidate.faces.length,
    evidenceEligibleFaceIndices: acceptedFaceIndices,
    rejectedFaces,
    duplicateImageIds,
    duplicateCalibrationIds,
    sourceImageUsage: [...sourceImageUsage].map(([imageId, faceCount]) => ({ imageId, faceCount })),
    uvBounds: noUv ? null : uvBounds,
    blockers,
    policy: {
      generatesUvs: false,
      projectsTextures: false,
      fabricatesMissingTexturePixels: false,
      usesUnverifiedCalibration: false,
      maxReprojectionErrorPx,
    },
    limitations: [
      "This validates supplied projection evidence; it does not compute camera poses, UVs, or texture pixels.",
      "Passing this review does not prove correct material appearance, seam quality, or real-world geometry accuracy.",
      "Camera calibration and source-image verification must be independently established and recorded by the pipeline operator.",
    ],
    publicationEligible: false,
  };
}
