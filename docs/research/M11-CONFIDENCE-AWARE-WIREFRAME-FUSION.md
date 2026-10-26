# M11 — Confidence-aware wireframe fusion

## Purpose

M11 converts reviewed, hash-pinned per-view architectural observations and explicitly accepted cross-view correspondences into a shared sparse 3D feature graph. It reuses the M07 observation schema, M09 camera/projection evidence validator and M10 robust triangulation. It does not train a matcher or invent hidden geometry.

## Input contract

    fuseReviewedObservationsIntoWireframe({
      buildingId,
      cameras,                 // M09 camera records with imageSize, coordinateFrame and calibration evidence
      observationBatches,      // M07-normalized, source-hash-pinned per-view batches
      correspondences: [{
        id: "corner-front-left",
        status: "accepted",   // proposed | accepted | review-required | rejected | conflict
        confidence: 0.92,     // reviewer supplied score, not a probability
        reviewedBy: "reviewer-id",
        reviewedAt: "2026-10-26T08:00:00Z",
        observationRefs: [{ batchId: "front", observationId: "corner-01" }, ...]
      }],
      edgeProposals: [{
        id: "front-wall-top",
        fromCorrespondenceId: "corner-front-left",
        toCorrespondenceId: "corner-front-right",
        status: "reviewed",
        confidence: 0.88,
        reviewedBy: "reviewer-id",
        reviewedAt: "2026-10-26T08:00:00Z",
        sourceViewIds: ["front", "oblique-front"]
      }],
      facadeInventory: ["front", "rear", "left", "right", "roof"],
      facadeCoverage: [{
        facadeId: "front",
        visibility: "observed",
        status: "reviewed",
        reviewedBy: "reviewer-id",
        reviewedAt: "2026-10-26T08:00:00Z",
        sourceViewIds: ["front", "oblique-front"]
      }]
    })

The viewCameraMap option maps a batch viewId to a camera ID where those identifiers differ. By default, they must match. A camera's declared imageSize must match the source-image dimensions. Every point correspondence must reference at least two distinct reviewed, visible Point observations.

## Output guarantees

- Each 3D vertex retains the observation batch/ID, source image ID and SHA-256, original pixel coordinate, camera/view, reviewer, observation confidence, and per-view reprojection residual/classification.
- A source observation assigned to multiple correspondence groups produces a conflict; it is not duplicated into multiple 3D vertices.
- Vertices with only two views, low/unknown parallax, suspected outliers, non-accepted correspondences, missing review attestations or unaudited camera calibration remain review-required.
- Edges are accepted only when their endpoints are accepted and the edge relation itself has a review attestation plus at least one common supporting source view. Endpoint residual evidence is retained; the system does not claim an independent edge residual.
- The facade inventory is explicit. Unobserved, occluded, not-visible and not-detected facades remain unknown; an explicitly inferred facade remains inferred. No such status proves the physical facade is absent.
- The graph is always publicationEligible: false and carries geometryCompleteness: sparse-wireframe-only. Faces are not generated.

## Confidence semantics

The output score combines correspondence confidence, source-observation confidence, inlier ratio, residual quality, parallax state and calibration-evidence readiness. The score is explicitly a heuristic ranking score, not a calibrated probability, and must not be described as survey accuracy.

## Verification

Run:

    npm run test:confidence-aware-wireframe-fusion
    npm run test:multi-view-wireframe-registration
    npm run test:camera-projection-validation

Synthetic tests cover accepted multi-view corners, provenance, edge review gates, duplicate correspondence conflicts, two-view underdetermination, unaudited calibration, unknown/inferred facades, source-dimension mismatch and proposed observations.

## Limits

This contract only fuses reviewed pixel correspondences through supplied projection matrices. It does not prove the calibration matrix is physically correct, detect all semantically wrong matches, infer absent vertices or faces, recover metres without valid scale/control evidence, or validate a real building's visual/dimensional accuracy. Real-building acceptance still needs independently checked control dimensions, source rights, deterministic reference-camera overlays and human review.
