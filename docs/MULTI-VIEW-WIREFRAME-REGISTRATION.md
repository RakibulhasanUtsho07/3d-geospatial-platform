# Calibrated multi-view sparse wireframe

This stage triangulates explicitly matched image features into a **sparse 3D wireframe candidate**. It is a mathematical foundation, not a complete architectural reconstruction.

## Input contract

Create a JSON input file with:

- `cameras`: unique IDs and calibrated 3×4 projection matrices in one common world coordinate frame.
- `features`: a stable feature ID and one manually verified image pixel observation per camera that sees that same physical point.
- `edges`: pairs of feature IDs that should be connected in the intended wireframe.
- Optional `options.maxRmsReprojectionError`: pixel threshold for flagging feature points for review (default 3 pixels).

Projection matrices must map homogeneous world coordinates `[X,Y,Z,1]` to image homogeneous coordinates. The output is only as valid as the camera calibration and cross-view correspondences. A feature ID must mean the same physical point in every listed view.

## Run

```powershell
npm run test:multi-view-wireframe-registration
npm run build:multi-view-wireframe -- ".\wireframe-input.json" ".\wireframe-candidate.json"
```

The command refuses to overwrite an existing output file. It exits nonzero if QA issues are found, but still writes the candidate and its issue report when processing succeeds.

## Current capabilities

- Linear multi-view triangulation using a symmetric eigensolver on the DLT normal matrix.
- Per-view reprojection error and RMS error calculation.
- Flags high-error points, failed triangulations, invalid edge references and missing edge endpoints.
- Produces explicit vertex/edge records with review status and source camera observations' reprojection details.

## Critical limits

- **Camera calibration is not performed.** The caller must supply trustworthy calibrated projection matrices in a common frame.
- **Feature matching is not performed.** Observations must be verified to refer to the same architectural corner/point.
- Sparse correspondences do not produce a watertight building mesh, surfaces, textures, floor plans or metric georeferencing by themselves.
- There is no automatic repair yet; `repairPasses` remains zero.
- Candidate models are never marked publication-eligible by this stage.
- Do not use arbitrary/guessed camera matrices and then interpret the output as real building dimensions or accuracy.

Next stages should validate camera calibration and correspondence quality, establish explicit wireframe constraints, and add bounded review/correction passes. Dense geometry should only be attempted after sparse alignment passes QA.
