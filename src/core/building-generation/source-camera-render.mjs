const sha256Pattern = /^[a-f0-9]{64}$/i;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const validHash = (value) => typeof value === "string" && sha256Pattern.test(value);
const validVector3 = (value) => Array.isArray(value) && value.length === 3 && value.every(finite);

function rotateByQuaternion(vector, quaternion) {
  const [w, x, y, z] = quaternion;
  const [vx, vy, vz] = vector;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function cameraLocalPoint(camera, worldPoint) {
  const delta = worldPoint.map((value, index) => value - camera.pose.position[index]);
  const [w, x, y, z] = camera.pose.quaternionWxyz;
  return rotateByQuaternion(delta, [w, -x, -y, -z]);
}

/**
 * Project one point using the documented Blender-camera convention:
 * camera-to-world quaternion in WXYZ order; camera looks along local -Z;
 * pixels have origin at the upper-left; lens distortion must already be removed.
 */
export function projectWorldPointToSourceCamera(camera, worldPoint) {
  if (!camera || !camera.pose || !validVector3(worldPoint)) throw new TypeError("camera and finite worldPoint are required");
  const intrinsics = camera.intrinsics;
  if (!intrinsics || !["fx", "fy", "cx", "cy"].every((key) => finite(intrinsics[key]))) {
    throw new TypeError("camera intrinsics fx/fy/cx/cy must be finite numbers");
  }
  const local = cameraLocalPoint(camera, worldPoint);
  const depth = -local[2];
  if (!(depth > 1e-9)) return { visible: false, reason: "point-not-in-front-of-camera" };
  return {
    visible: true,
    x: intrinsics.fx * local[0] / depth + intrinsics.cx,
    y: intrinsics.cy - intrinsics.fy * local[1] / depth,
    depth,
  };
}

function validateCamera(camera) {
  const errors = [];
  if (!camera || typeof camera !== "object" || Array.isArray(camera)) {
    return ["camera-manifest-must-be-an-object"];
  }
  if (camera.schemaVersion !== "1.0.0") errors.push("camera-schema-version-unsupported");
  if (typeof camera.id !== "string" || !camera.id.trim()) errors.push("camera-evidence-id-missing");
  if (camera.calibrationStatus !== "verified") errors.push("camera-calibration-not-verified");
  if (!camera.calibrationEvidence || typeof camera.calibrationEvidence.id !== "string" ||
      !camera.calibrationEvidence.id.trim() || !validHash(camera.calibrationEvidence.sha256)) {
    errors.push("camera-calibration-evidence-missing-or-invalid");
  }
  if (!camera.frameAlignmentEvidence || typeof camera.frameAlignmentEvidence.id !== "string" ||
      !camera.frameAlignmentEvidence.id.trim() || !validHash(camera.frameAlignmentEvidence.sha256)) {
    errors.push("camera-model-frame-alignment-evidence-missing-or-invalid");
  }
  if (typeof camera.coordinateFrame !== "string" || !camera.coordinateFrame.trim()) {
    errors.push("camera-coordinate-frame-missing");
  }
  const size = camera.sourceImage;
  if (!size || !validHash(size.sha256) || !Number.isSafeInteger(size.width) || size.width < 1 ||
      !Number.isSafeInteger(size.height) || size.height < 1) {
    errors.push("source-image-metadata-invalid");
  }
  const intrinsics = camera.intrinsics;
  if (!intrinsics || !["fx", "fy", "cx", "cy"].every((key) => finite(intrinsics[key])) ||
      !(intrinsics.fx > 0) || !(intrinsics.fy > 0)) {
    errors.push("camera-intrinsics-invalid");
  } else if (size && (intrinsics.cx < 0 || intrinsics.cy < 0 ||
      intrinsics.cx >= size.width || intrinsics.cy >= size.height)) {
    errors.push("camera-principal-point-outside-image");
  }
  if (intrinsics && intrinsics.distortionModel !== "none" && intrinsics.distortionModel !== "rectified") {
    errors.push("source-camera-image-must-be-undistorted-or-rectified");
  }
  const pose = camera.pose;
  if (!pose || !validVector3(pose.position) || !Array.isArray(pose.quaternionWxyz) ||
      pose.quaternionWxyz.length !== 4 || !pose.quaternionWxyz.every(finite)) {
    errors.push("camera-pose-invalid");
  } else {
    const magnitude = Math.hypot(...pose.quaternionWxyz);
    if (Math.abs(magnitude - 1) > 1e-3) errors.push("camera-quaternion-must-be-unit-length");
  }
  if (!Array.isArray(camera.controlPoints) || camera.controlPoints.length < 4) {
    errors.push("at-least-four-independent-control-points-required");
  } else {
    const seen = new Set();
    for (const point of camera.controlPoints) {
      if (!point || typeof point.id !== "string" || !point.id.trim() || seen.has(point.id) ||
          !validVector3(point.worldPoint) || !point.imagePoint ||
          !finite(point.imagePoint.x) || !finite(point.imagePoint.y)) {
        errors.push("camera-control-point-invalid-or-duplicated");
        break;
      }
      seen.add(point.id);
    }
  }
  return errors;
}

/**
 * Fail-closed same-camera eligibility check. It verifies artifact identity and
 * reprojection against supplied independent control points; it does not certify
 * the truth of the survey, rights, camera calibration, or model-frame attestation.
 */
export function assessSourceCameraForRender({
  camera,
  sourceImageSha256,
  sourceImageSize,
  cameraManifestSha256,
  calibrationEvidenceSha256,
  frameAlignmentEvidenceSha256,
  modelSha256,
  maxControlPointErrorPixels = 3,
} = {}) {
  if (!finite(maxControlPointErrorPixels) || maxControlPointErrorPixels <= 0) {
    throw new RangeError("maxControlPointErrorPixels must be positive");
  }
  const errors = validateCamera(camera);
  if (!validHash(sourceImageSha256)) errors.push("actual-source-image-sha256-invalid");
  if (!sourceImageSize || !Number.isSafeInteger(sourceImageSize.width) || sourceImageSize.width < 1 ||
      !Number.isSafeInteger(sourceImageSize.height) || sourceImageSize.height < 1) {
    errors.push("actual-source-image-dimensions-invalid");
  }
  if (!validHash(cameraManifestSha256)) errors.push("camera-manifest-sha256-invalid");
  if (!validHash(calibrationEvidenceSha256)) errors.push("calibration-evidence-file-sha256-invalid");
  if (!validHash(frameAlignmentEvidenceSha256)) errors.push("frame-alignment-evidence-file-sha256-invalid");
  if (validHash(calibrationEvidenceSha256) && validHash(camera?.calibrationEvidence?.sha256) &&
      calibrationEvidenceSha256.toLowerCase() !== camera.calibrationEvidence.sha256.toLowerCase()) {
    errors.push("calibration-evidence-sha256-mismatch");
  }
  if (validHash(frameAlignmentEvidenceSha256) && validHash(camera?.frameAlignmentEvidence?.sha256) &&
      frameAlignmentEvidenceSha256.toLowerCase() !== camera.frameAlignmentEvidence.sha256.toLowerCase()) {
    errors.push("frame-alignment-evidence-sha256-mismatch");
  }
  if (!validHash(modelSha256)) errors.push("model-sha256-invalid");
  if (validHash(sourceImageSha256) && validHash(camera?.sourceImage?.sha256) &&
      sourceImageSha256.toLowerCase() !== camera.sourceImage.sha256.toLowerCase()) {
    errors.push("source-image-sha256-mismatch");
  }
  if (sourceImageSize && camera?.sourceImage &&
      (sourceImageSize.width !== camera.sourceImage.width || sourceImageSize.height !== camera.sourceImage.height)) {
    errors.push("source-image-dimensions-mismatch");
  }

  const controlPointReports = [];
  if (Array.isArray(camera?.controlPoints) && camera.controlPoints.length >= 4 &&
      camera.pose && camera.intrinsics && !errors.some((code) =>
        ["camera-pose-invalid", "camera-intrinsics-invalid", "camera-quaternion-must-be-unit-length"].includes(code))) {
    for (const point of camera.controlPoints) {
      if (!validVector3(point.worldPoint) || !point.imagePoint ||
          !finite(point.imagePoint.x) || !finite(point.imagePoint.y)) continue;
      const projected = projectWorldPointToSourceCamera(camera, point.worldPoint);
      if (!projected.visible) {
        controlPointReports.push({ id: point.id, status: "failed", reason: projected.reason });
        errors.push("control-point-not-projectable:" + point.id);
        continue;
      }
      const errorPixels = Math.hypot(projected.x - point.imagePoint.x, projected.y - point.imagePoint.y);
      controlPointReports.push({
        id: point.id,
        observed: { x: point.imagePoint.x, y: point.imagePoint.y },
        projected: { x: projected.x, y: projected.y },
        errorPixels,
        status: errorPixels <= maxControlPointErrorPixels ? "within-tolerance" : "failed",
      });
      if (point.imagePoint.x < 0 || point.imagePoint.y < 0 ||
          point.imagePoint.x >= camera.sourceImage.width || point.imagePoint.y >= camera.sourceImage.height) {
        errors.push("control-point-outside-image:" + point.id);
      }
      if (errorPixels > maxControlPointErrorPixels) errors.push("control-point-reprojection-error-exceeds-tolerance:" + point.id);
    }
  }
  const uniqueErrors = [...new Set(errors)];
  return {
    schemaVersion: "1.0.0",
    status: uniqueErrors.length ? "not-comparable" : "same-camera-comparable",
    sameCameraComparable: uniqueErrors.length === 0,
    modelSha256: validHash(modelSha256) ? modelSha256.toLowerCase() : null,
    sourceImageSha256: validHash(sourceImageSha256) ? sourceImageSha256.toLowerCase() : null,
    sourceImageSize: sourceImageSize ?? null,
    cameraManifestSha256: validHash(cameraManifestSha256) ? cameraManifestSha256.toLowerCase() : null,
    cameraEvidenceId: typeof camera?.id === "string" ? camera.id : null,
    calibrationEvidenceId: typeof camera?.calibrationEvidence?.id === "string" ? camera.calibrationEvidence.id : null,
    calibrationEvidenceSha256: validHash(calibrationEvidenceSha256) ? calibrationEvidenceSha256.toLowerCase() : null,
    frameAlignmentEvidenceId: typeof camera?.frameAlignmentEvidence?.id === "string" ? camera.frameAlignmentEvidence.id : null,
    frameAlignmentEvidenceSha256: validHash(frameAlignmentEvidenceSha256) ? frameAlignmentEvidenceSha256.toLowerCase() : null,
    coordinateFrame: typeof camera?.coordinateFrame === "string" ? camera.coordinateFrame : null,
    cameraPose: camera?.pose ?? null,
    cameraIntrinsics: camera?.intrinsics ?? null,
    sourceImage: camera?.sourceImage ?? null,
    sourceImageCrop: camera?.sourceImage?.crop ?? null,
    maxControlPointErrorPixels,
    controlPointReports,
    errors: uniqueErrors,
    publicationEligible: false,
    limitations: [
      "A matching hash establishes file identity, not the truth of the calibration, frame-alignment, measurement, or rights attestation.",
      "Projection comparisons assume a pinhole camera with no residual lens distortion and a camera pose expressed in the model's declared coordinate frame.",
      "A same-camera render does not prove hidden geometry or overall architectural accuracy; independent dimensions and human review remain required.",
    ],
  };
}

/** Add output evidence only after the exact PNG has been inspected and hashed by the caller. */
export function finalizeSourceCameraRenderManifest({ assessment, renderFile = null } = {}) {
  if (!assessment || typeof assessment !== "object" ||
      !["same-camera-comparable", "not-comparable"].includes(assessment.status)) {
    throw new TypeError("assessment must be a source-camera assessment");
  }
  const errors = [...assessment.errors];
  let render = null;
  if (assessment.sameCameraComparable) {
    if (!renderFile || renderFile.filename !== "source-camera.png" ||
        !Number.isSafeInteger(renderFile.width) || renderFile.width !== assessment.sourceImageSize?.width ||
        !Number.isSafeInteger(renderFile.height) || renderFile.height !== assessment.sourceImageSize?.height ||
        !validHash(renderFile.sha256) || !Number.isSafeInteger(renderFile.bytes) || renderFile.bytes < 1) {
      errors.push("source-camera-render-output-missing-or-invalid");
    } else {
      render = {
        filename: renderFile.filename,
        width: renderFile.width,
        height: renderFile.height,
        bytes: renderFile.bytes,
        sha256: renderFile.sha256.toLowerCase(),
      };
    }
  } else if (renderFile) {
    errors.push("render-must-not-be-produced-for-non-comparable-camera");
  }
  const sameCameraComparable = assessment.sameCameraComparable && errors.length === 0;
  return {
    ...assessment,
    status: sameCameraComparable ? "same-camera-comparable" : "not-comparable",
    sameCameraComparable,
    render,
    errors: [...new Set(errors)],
    publicationEligible: false,
  };
}
