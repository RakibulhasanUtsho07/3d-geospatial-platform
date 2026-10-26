# M09 — Camera/projection evidence validation

M09 adds a deterministic structural validator for camera projection evidence used by multi-view wireframe reconstruction.

## Contract
- Require unique camera IDs, finite 3×4 projection matrices of rank three, positive integer image dimensions, and an explicit shared-coordinate-frame label.
- A camera marked `verified` must bind a calibration evidence source ID and SHA-256. This is provenance validation, not independent authentication.
- Check observation pixel bounds against the exact camera image dimensions.
- Where an observation includes an independently checked 3D control point, report reprojection error per observation and compare it with a configurable pixel threshold.
- Preserve missing/unverified calibration as review-required; malformed evidence fails closed.
- Do not infer camera pose, scale, world origin, or hidden geometry. Every report remains `publicationEligible: false`.

## Run
```sh
npm run test:camera-projection-validation
npm run test:multi-view-wireframe-registration
```

## Evidence boundary
Synthetic fixtures verify contract behaviour only. A real building needs checked camera metadata, independently sourced control points, permissioned source imagery and a human review of reprojection residuals before calibration can be accepted.
