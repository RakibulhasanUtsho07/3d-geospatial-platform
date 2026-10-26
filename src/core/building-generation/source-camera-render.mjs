const HASH = /^[a-f0-9]{64}$/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;
const EPSILON = 1e-9;

function isMatrix3(value) {
  return Array.isArray(value) && value.length === 3 &&
    value.every((row) => Array.isArray(row) && row.length === 3 && row.every(finite));
}
function determinant3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
function rotationIssues(rotation) {
  if (!isMatrix3(rotation)) return ["camera-to-world rotation must be a finite 3x3 matrix"];
  const issues = [];
  for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) {
    let dot = 0;
    for (let c = 0; c < 3; c++) dot += rotation[r][c] * rotation[s][c];
    const expected = r === s ? 1 : 0;
    if (Math.abs(dot - expected) > 1e-3) issues.push("camera-to-world rotation must be orthonormal");
  }
  if (Math.abs(determinant3(rotation) - 1) > 1e-3) issues.push("camera-to-world rotation determinant must be +1");
  return [...new Set(issues)];
}
function validCrop(crop, imageSize) {
  if (crop == null) return true;
  if (!crop || typeof crop !== "object") return false;
  const ints = ["x", "y", "width", "height", "originalWidth", "originalHeight"];
  if (ints.some((key) => !Number.isSafeInteger(crop[key]) || crop[key] < 0)) return false;
  if (crop.width < 1 || crop.height < 1 || crop.originalWidth < 1 || crop.originalHeight < 1) return false;
  if (crop.x + crop.width > crop.originalWidth || crop.y + crop.height > crop.originalHeight) return false;
  return crop.appliedToImage === true && crop.width === imageSize.width && crop.height === imageSize.height;
}

/**
 * Fail-closed validator and projection adapter for a reviewed pinhole source camera.
 * pose.rotation maps vision-camera axes (right, down, forward) into the model world frame.
 * pose.translation is the camera centre in that exact model world frame.
 */
export function prepareSourceCameraRender({ cameraEvidence, sourceImage, modelCoordinateFrame, modelSha256 } = {}) {
  const errors = [];
  const camera = cameraEvidence?.camera;
  if (!cameraEvidence || cameraEvidence.schemaVersion !== "1.0.0") errors.push("camera-evidence-schema-version-unsupported");
  if (!camera || typeof camera.id !== "string" || !camera.id.trim()) errors.push("camera-id-required");
  if (camera?.calibrationStatus !== "verified") errors.push("camera-calibration-not-verified");
  if (!camera?.evidence || typeof camera.evidence.id !== "string" || !camera.evidence.id.trim() ||
      typeof camera.evidence.sourceId !== "string" || !camera.evidence.sourceId.trim() ||
      !HASH.test(camera.evidence.sha256 ?? "")) errors.push("camera-calibration-evidence-link-invalid");
  if (camera?.convention !== "vision-x-right-y-down-z-forward") errors.push("camera-axis-convention-unsupported");
  if (typeof modelCoordinateFrame !== "string" || !modelCoordinateFrame.trim()) errors.push("model-coordinate-frame-required");
  if (!camera?.coordinateFrame || camera.coordinateFrame !== modelCoordinateFrame) errors.push("camera-model-coordinate-frame-mismatch");
  if (!HASH.test(modelSha256 ?? "")) errors.push("model-sha256-invalid");

  if (!sourceImage || typeof sourceImage.path !== "string" || !sourceImage.path.trim()) errors.push("source-image-path-required");
  if (!HASH.test(sourceImage?.sha256 ?? "")) errors.push("source-image-sha256-invalid");
  if (camera?.sourceImageSha256 !== sourceImage?.sha256) errors.push("camera-source-image-hash-mismatch");
  const imageSize = sourceImage?.imageSize;
  if (!imageSize || !positiveInt(imageSize.width) || !positiveInt(imageSize.height) ||
      imageSize.width > 8192 || imageSize.height > 8192 || imageSize.width * imageSize.height > 40000000) {
    errors.push("source-image-dimensions-invalid");
  }
  if (!camera?.imageSize || camera.imageSize.width !== imageSize?.width ||
      camera.imageSize.height !== imageSize?.height) errors.push("camera-source-image-dimensions-mismatch");
  if (sourceImage?.crop != null && !validCrop(sourceImage.crop, imageSize ?? {})) {
    errors.push("source-image-crop-metadata-invalid");
  }
  if (!camera?.intrinsics || !finite(camera.intrinsics.fx) || camera.intrinsics.fx <= 0 ||
      !finite(camera.intrinsics.fy) || camera.intrinsics.fy <= 0 ||
      !finite(camera.intrinsics.cx) || !finite(camera.intrinsics.cy) ||
      (imageSize && (camera.intrinsics.cx < 0 || camera.intrinsics.cx >= imageSize.width ||
        camera.intrinsics.cy < 0 || camera.intrinsics.cy >= imageSize.height))) {
    errors.push("camera-intrinsics-invalid");
  }
  const pose = camera?.pose;
  if (!pose || !Array.isArray(pose.translation) || pose.translation.length !== 3 || pose.translation.some((n) => !finite(n))) {
    errors.push("camera-translation-invalid");
  }
  errors.push(...rotationIssues(pose?.rotation).map((issue) => issue.startsWith("camera-to-world rotation determinant")
    ? "camera-rotation-determinant-invalid"
    : issue.startsWith("camera-to-world rotation must be orthonormal")
      ? "camera-rotation-not-orthonormal" : "camera-rotation-invalid"));

  const distortion = camera?.distortion;
  const distortionCoefficients = distortion?.coefficients ?? [];
  if (!distortion || !["none", "pinhole-zero"].includes(distortion.model) ||
      !Array.isArray(distortionCoefficients) || distortionCoefficients.some((n) => !finite(n) || Math.abs(n) > EPSILON)) {
    errors.push("camera-distortion-unsupported-undistortion-required");
  }

  if (errors.length) {
    return { schemaVersion: "1.0.0", status: "failed", valid: false, publicationEligible: false,
      errors: [...new Set(errors)], warnings: ["No calibrated render was produced; repair the evidence contract and retry."] };
  }

  const { width, height } = imageSize;
  const { fx, fy, cx, cy } = camera.intrinsics;
  const rotation = pose.rotation.map((row) => [row[0], -row[1], -row[2]]);
  const renderPlan = {
    schemaVersion: "1.0.0",
    mode: "calibrated-source-camera",
    cameraId: camera.id,
    cameraEvidenceId: camera.evidence.id,
    cameraEvidenceSourceId: camera.evidence.sourceId,
    cameraEvidenceSha256: camera.evidence.sha256.toLowerCase(),
    sourceImagePath: sourceImage.path,
    sourceImageSha256: sourceImage.sha256.toLowerCase(),
    sourceImageSize: { width, height },
    sourceImageCrop: sourceImage.crop ?? null,
    modelCoordinateFrame,
    modelSha256: modelSha256.toLowerCase(),
    visionCameraConvention: camera.convention,
    worldFromVisionCamera: { rotation: pose.rotation.map((row) => [...row]), translation: [...pose.translation] },
    blenderCamera: {
      location: [...pose.translation],
      // Blender camera local axes are right/up/back; vision-camera axes are right/down/forward.
      rotationMatrix: rotation,
      lensMm: fx * 36 / width,
      sensorWidthMm: 36,
      sensorFit: "HORIZONTAL",
      pixelAspectX: 1,
      pixelAspectY: fx / fy,
      // Blender shifts are normalized by image width; principal point is in pixel-centre coordinates.
      shiftX: (width / 2 - cx) / width,
      shiftY: (cy - height / 2) / width,
      imageWidth: width,
      imageHeight: height,
    },
    intrinsics: { fx, fy, cx, cy },
    distortion: { model: distortion.model, coefficients: [...distortionCoefficients] },
    renderSettings: { resolutionX: width, resolutionY: height, resolutionPercentage: 100, transparentCandidate: true },
    publicationEligible: false,
  };
  return { schemaVersion: "1.0.0", status: "ready-for-calibrated-render", valid: true,
    publicationEligible: false, errors: [], warnings: [], renderPlan };
}

/** Reproject a model-world point into the exact calibrated source image. */
export function projectWorldPointToSourceImage(camera, worldPoint) {
  if (!camera?.pose || !isMatrix3(camera.pose.rotation) ||
      !Array.isArray(camera.pose.translation) || camera.pose.translation.length !== 3 ||
      camera.pose.translation.some((n) => !finite(n)) ||
      !Array.isArray(worldPoint) || worldPoint.length !== 3 || worldPoint.some((n) => !finite(n)) ||
      !camera.intrinsics || !finite(camera.intrinsics.fx) || !finite(camera.intrinsics.fy)) {
    throw new TypeError("camera pose, intrinsics and a finite 3D world point are required");
  }
  const delta = worldPoint.map((n, i) => n - camera.pose.translation[i]);
  const local = [0, 1, 2].map((r) => camera.pose.rotation.reduce((sum, row, c) => sum + row[r] * delta[c], 0));
  if (local[2] <= EPSILON) return { visible: false, reason: "point-at-or-behind-camera", cameraPoint: local };
  return {
    visible: true,
    cameraPoint: local,
    pixel: { x: camera.intrinsics.fx * local[0] / local[2] + camera.intrinsics.cx,
      y: camera.intrinsics.fy * local[1] / local[2] + camera.intrinsics.cy },
  };
}

/** Finalize a same-camera render record; hashes prove identity, not calibration truth or model accuracy. */
export function finalizeSourceCameraRenderManifest({ renderPlan, renderFiles } = {}) {
  const errors = [];
  if (!renderPlan || renderPlan.mode !== "calibrated-source-camera" || renderPlan.publicationEligible !== false) {
    errors.push("source-camera-render-plan-invalid");
  }
  const size = renderPlan?.sourceImageSize;
  for (const key of ["candidate", "overlay"]) {
    const file = renderFiles?.[key];
    if (!file || !HASH.test(file.sha256 ?? "") || !positiveInt(file.width) || !positiveInt(file.height) ||
        !positiveInt(file.bytes)) errors.push("render-file-metadata-invalid:" + key);
    else if (file.width !== size?.width || file.height !== size?.height) errors.push("render-dimensions-mismatch:" + key);
  }
  if (errors.length) return { schemaVersion: "1.0.0", status: "failed", valid: false,
    publicationEligible: false, errors: [...new Set(errors)] };
  return {
    schemaVersion: "1.0.0",
    engine: "building-source-camera-render-v1",
    status: "render-pair-ready-for-human-review",
    valid: true,
    publicationEligible: false,
    modelSha256: renderPlan.modelSha256,
    sourceImage: { path: renderPlan.sourceImagePath, sha256: renderPlan.sourceImageSha256,
      width: size.width, height: size.height, crop: renderPlan.sourceImageCrop },
    camera: { id: renderPlan.cameraId, evidenceId: renderPlan.cameraEvidenceId,
      evidenceSourceId: renderPlan.cameraEvidenceSourceId, evidenceSha256: renderPlan.cameraEvidenceSha256,
      convention: renderPlan.visionCameraConvention, coordinateFrame: renderPlan.modelCoordinateFrame,
      pose: renderPlan.worldFromVisionCamera, intrinsics: renderPlan.intrinsics, distortion: renderPlan.distortion },
    render: { width: size.width, height: size.height, candidate: { ...renderFiles.candidate },
      overlay: { ...renderFiles.overlay } },
    humanReview: { status: "pending", checklist: [
      { id: "source-identity", reviewed: false, label: "Confirm the source photo is the intended, permitted building view" },
      { id: "camera-calibration", reviewed: false, label: "Review independent camera calibration and control-point residuals" },
      { id: "silhouette-alignment", reviewed: false, label: "Compare projected building silhouette and facade edges in overlay" },
      { id: "occlusion", reviewed: false, label: "Review occlusions, crops, and image regions unsupported by geometry" },
    ] },
    limitations: [
      "The source camera is only comparable when its calibration and model coordinate frame are independently verified.",
      "Non-zero lens distortion is rejected; undistort the source image and recalibrate before rendering.",
      "A render/overlay hash proves artifact identity, not architectural accuracy or survey truth.",
      "Human comparison against independent dimensions and permissioned reference evidence remains required.",
    ],
    errors: [],
  };
}
