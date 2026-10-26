# M13 — Source-Camera Rendering Contract

**Status:** implementation candidate; automated tests must pass before merge.  
**Task:** BAUB-001 / M13.  
**Publication:** never enabled by this task.

## Purpose

Render a GLB through an explicitly calibrated source-photo camera instead of fitting a fresh orthographic camera to the model. This creates a valid pair for later reference/silhouette diagnostics only when the source image, calibration, model-frame alignment and render artifact can be tied together.

The existing 13 canonical inspection renders are unchanged. The optional source-camera result is a separate `source-camera-render-manifest.json`; it does not replace the canonical human-review manifest.

## Input contract

A UTF-8 JSON file passed as `--source-camera=<camera.json>`:

```json
{
  "schemaVersion": "1.0.0",
  "id": "front-camera-01",
  "calibrationStatus": "verified",
  "calibrationEvidence": {
    "id": "calibration-report-01",
    "sha256": "<64-character SHA-256 of calibration evidence>"
  },
  "frameAlignmentEvidence": {
    "id": "model-frame-fit-01",
    "sha256": "<64-character SHA-256 of evidence aligning the camera and GLB coordinates>"
  },
  "coordinateFrame": "model-local-blender-v1",
  "sourceImage": {
    "sha256": "<SHA-256 of the exact source image>",
    "width": 640,
    "height": 480
  },
  "pose": {
    "position": [0, 0, 0],
    "quaternionWxyz": [1, 0, 0, 0]
  },
  "intrinsics": {
    "fx": 400,
    "fy": 400,
    "cx": 320,
    "cy": 240,
    "distortionModel": "none"
  },
  "controlPoints": [
    { "id": "p1", "worldPoint": [0, 0, -10], "imagePoint": { "x": 320, "y": 240 } },
    { "id": "p2", "worldPoint": [1, 0, -10], "imagePoint": { "x": 360, "y": 240 } },
    { "id": "p3", "worldPoint": [0, 1, -10], "imagePoint": { "x": 320, "y": 200 } },
    { "id": "p4", "worldPoint": [-1, -1, -10], "imagePoint": { "x": 280, "y": 280 } }
  ]
}
```

The values above are a synthetic test example only, not a camera calibration for a real building.

- Camera coordinates are expressed in the same declared model-local Blender frame as the GLB; camera local `-Z` points forward and local `+Y` points up.
- `quaternionWxyz` is a camera-to-world rotation quaternion in WXYZ order. It must be unit length.
- Intrinsics are measured in pixels with a top-left image origin. `fx` and `fy` must be positive. The source image must already be undistorted or rectified (`distortionModel` is `none` or `rectified`).
- The image passed as `--source-image=<photo.png|photo.jpg|photo.jpeg>` must match the declared bytes hash and dimensions exactly. Resizing/re-encoding after calibration invalidates the pair.
- At least four distinct, independently checked 3D-to-image control points are required; the default maximum reprojection error is 3 pixels per point. A project can use a stricter documented tolerance. Reprojection checks validate consistency, not the truth of the survey.
- Calibration and model-frame alignment each need a stable evidence ID and evidence SHA-256. A hash establishes file identity only; it does not authenticate the evidence's truth.

## Usage

```sh
node scripts/render-building-review-views.mjs candidate.glb out/review-2026-01 \
  --source-camera=references/front-camera.json \
  --source-image=references/front.jpg
```

The renderer creates the normal canonical render set and writes `source-camera.png` plus `source-camera-render-manifest.json` only when the same-camera gate passes. If metadata or hashes are missing/inconsistent, no source-camera PNG is produced; the sidecar reports `not-comparable` with stable error codes and the command exits non-zero after recording the canonical render manifest. The current implementation supports PNG and JPEG source images; camera input is not inferred from image pixels.

## Projection model and tolerances

For camera-local point ((X,Y,Z)), positive depth is (d=-Z). The pixel projection is

- (u = f_x X/d + c_x)
- (v = c_y - f_y Y/d)

Points behind the camera are non-projectable. The renderer must use the supplied pose/intrinsics and exact input frame dimensions; it must never auto-fit, recenter, resize, or silently substitute an orthographic view for this pair. The contract test includes a known synthetic projection; Blender camera wiring is also checked by source-level tests and Python syntax validation in CI.

## Limitations / acceptance boundary

- This gate does not establish accurate real-building geometry or validate the provenance assertion on its own.
- A same-camera render remains a candidate diagnostic, not a pass/fail architectural verdict.
- It does not fill occluded geometry, solve unknown camera calibration, estimate a missing model-frame transform, or enable publication.
- Independent measurements, reference-image inspection, dimension/GCP gates and human approval remain mandatory.
