# M13 — Calibrated source-camera rendering

## Purpose and safety boundary

M13 renders an existing GLB using an explicitly reviewed source-photo camera, then produces a candidate PNG, a translucent candidate/reference overlay and a hash-bound manifest. It is a deterministic comparison aid, not an architectural-accuracy score. Every report keeps `publicationEligible: false`.

The current generic 13-view renderer remains unchanged. M13 is a separate path because a same-camera comparison must not be inferred from generic front/side views.

## Evidence contract

The camera evidence JSON has `schemaVersion: "1.0.0"` and a `camera` object containing:

- A stable `id`, `calibrationStatus: "verified"`, calibration `evidence.id`, `evidence.sourceId` and calibration-evidence SHA-256.
- `sourceImageSha256`, `imageSize`, and `coordinateFrame` matching the exact source-image bytes and model frame.
- `convention: "vision-x-right-y-down-z-forward"`.
- `pose.rotation`: a proper orthonormal 3×3 rotation mapping the vision-camera basis to the model/world frame; `pose.translation`: camera centre in that same frame.
- Pinhole intrinsics `fx`, `fy`, `cx`, `cy` in source-image pixels.
- A root `sourceImage.rightsAttestation` with `status: "permitted"`, a non-empty `sourceId` and SHA-256 of the permission/rights record. This is an operator-attested input; it does not independently prove that the permission claim is true.
- `distortion: { "model": "none", "coefficients": [] }` or `pinhole-zero` with finite zero coefficients only.

The camera file may include `sourceImage.crop`. If present, it records `x`, `y`, `width`, `height`, `originalWidth`, `originalHeight`, and `appliedToImage: true`. The image supplied to the renderer must already be that crop; crop dimensions must match the actual input raster, and camera intrinsics must already use crop-relative pixel coordinates. M13 does not silently crop or recalibrate pixels.

The source camera and GLB must use the same explicit coordinate-frame label. The top-level `sourceImage` object in the JSON carries the `rightsAttestation` and optional `crop` metadata; the runner calculates the actual image SHA-256 and pixel dimensions from the supplied file. This is an assertion by the workflow operator, not independent proof that the frames are correctly aligned. M13 does not estimate camera pose, scale, georeferencing, or hidden surfaces.

## Coordinate mapping

For a world point (X), camera rotation (R) and camera centre (t), the vision-camera coordinates are computed with (X_c = R^T(X-t)). Points with (Z_c \le 0) are behind/on the camera plane. The ideal pinhole projection is (u=f_x X_c/Z_c+c_x) and (v=f_y Y_c/Z_c+c_y).

Blender uses camera-local right/up/back axes while this evidence contract uses right/down/forward. The renderer therefore maps the camera local-to-world orientation using (R_\text{Blender}=R\,\mathrm{diag}(1,-1,-1)); it does not alter model vertices. Lens, principal point shift, pixel aspect and render dimensions are derived from the supplied intrinsics and image size. Brown–Conrady or any other non-zero/unmodelled lens distortion is rejected until the source image has been undistorted and calibrated in that image space.

## Run

The source image must be a readable PNG or JPEG. Use a fresh output directory; previous evidence is never overwritten.

```sh
node scripts/render-building-source-camera.mjs \
  path/to/candidate.glb \
  path/to/camera-evidence.json \
  path/to/reference-image.png \
  artifacts/source-camera-review \
  --coordinate-frame=building-local-enu-v1
```

Optional flags are `--blender=/path/to/blender` and `--timeout-ms=600000`. The coordinate-frame flag must exactly match both the camera evidence and the declared GLB coordinate frame. A hash mismatch, unverified calibration, malformed rotation, unsupported distortion, dimension mismatch or missing frame fails before a render can be accepted.

Successful output contains:

- `candidate.png`: the model rendered using the calibrated camera at the source image's exact dimensions.
- `overlay.png`: the candidate composited at 50% opacity over the reference photo.
- `source-camera-render-manifest.json`: GLB hash, source image hash, calibration evidence ID/hash, camera pose/intrinsics/crop, output dimensions and candidate/overlay hashes.

## Verification and limits

Run `npm run test:source-camera-render`. The tests exercise known pinhole projection coordinates, camera basis conversion, evidence/hash/dimension fail-closed rules, crop metadata, render-manifest integrity and the Blender overlay wiring. They do **not** execute Blender or validate a real-world camera calibration; a CI pass proves software contracts only.

For a real building, independently verify the camera calibration and coordinate-frame transform, inspect the candidate and overlay, and compare with separate surveyed dimensions/control points. If calibration is absent or inconsistent, the pipeline must not claim same-camera comparability. File hashes prove identity, not image permissions, calibration truth or model accuracy.
