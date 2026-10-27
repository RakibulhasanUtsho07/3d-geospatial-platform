# BRF-05–07 implementation and evidence status

**Tracking:** [Issue #199](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/199)  
**Plan:** [BRF-05–07 Visual Evidence Plan](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/plan/brf-05-07-visual-evidence/docs/research/BRF-05-07-VISUAL-EVIDENCE-PLAN.md)  
**Package engine:** \`building-visual-evidence-package-v1\`  
**Status:** Code integration and synthetic regression coverage added; real-building acceptance remains OPEN.

## Delivered in this implementation slice

### BRF-05 — source-bound masks and review overlays

- Reuses \`validateBuildingMaskArtifact\` and its fail-closed hash, byte-count, dimension, binary-pixel and human-review checks.
- Integrates a reviewed building mask and zero or more explicit occluder masks (vegetation, vehicle, wire/pole, person, nearby structure, shadow, other occluder or uncertainty).
- Produces deterministic SVG overlays that embed the exact source bytes and render bounded mask spans. The original source hash, encoded-mask hash and matching pixel dimensions are checked before overlay generation.
- Rejects stale/mismatched data and bounds overlay work. The overlay is a review artifact, not ground truth.
- A missing occluder mask is reported as incomplete coverage; the code does not infer that the facade is unobstructed.

### BRF-06 — architectural feature evidence

- Extends the versioned human-review schema to accept arch, column, dome, cornice, pediment, staircase, parapet and ornament candidates in addition to existing roofline, floor-band, window, door and balcony categories.
- Adds matching overlay colors so those reviewed annotations remain visible in feature-review SVGs.
- Integrates the existing bounded proposal engine with source/mask/edge identity checks and the existing per-category comparison against reviewed annotations.
- Heuristic proposals remain proposals. An unobserved or occluded architectural element is not inferred to be physically absent.

### BRF-07 — source-camera comparison

- The integrated report hashes the exact source bytes, mask bytes, GLB bytes, camera-manifest bytes, calibration/alignment evidence bytes and source-camera render bytes.
- Existing source-camera projection/reprojection checks gate comparisons. A rejected camera cannot receive a passing comparison status.
- Adds binary silhouette IoU, precision/recall/F1 and symmetric contour-distance diagnostics in source-pixel units, bound to the exact source image, reviewed reference mask, candidate mask and render hash.
- Keeps silhouette/contour metrics, semantic-feature metrics and physical/metric geometry as separate evidence families. The package does not calculate a physical dimension error without independent dimensions.
- The output is always review-only: \`acceptanceEligible\`, \`publicationEligible\` and \`mapReady\` remain false.

## End-to-end evidence graph

The entry point is:

\`\`\`js
import { buildBuildingVisualEvidencePackage } from "../src/core/building-generation/building-visual-evidence-package.mjs";

const result = buildBuildingVisualEvidencePackage(verifiedEvidenceInputs);
// Persist result.manifest as JSON and result.artifacts.maskOverlays as SVG files.
// Retain the exact input artifacts; never replace them with generated previews.
\`\`\`

The caller must provide exact bytes for the source image, encoded masks, GLB, camera/calibration/alignment manifests and source-camera PNG, together with decoder-verified dimensions, binary pixel planes, reviewed annotations and review metadata. The package computes byte hashes itself and binds the results into \`evidenceGraphSha256\`. It intentionally does not attempt to decode general image formats in this contract layer; real decoding and GLB geometry/topology/texture checks remain responsibilities of the existing renderer and QA pipeline.

The JSON report records source/model identities, per-mask validation, mask-overlay hashes, feature proposals and reviewed-feature metrics, source-camera assessment and render manifest, silhouette metrics, held-out benchmark status, warnings, errors and a non-publication policy.

## Gap / acceptance matrix

| Requirement | Code status | Evidence status / acceptance |
|---|---|---|
| Source image and mask hash/size binding | Implemented and tested | Synthetic tests verify integrity behavior; real mask overlay still needs visual inspection |
| Building mask review overlay | Implemented and tested | No real-photo overlay is accepted in this change |
| Occluder mask separation | Integrated input path and tests | Completeness is explicitly incomplete until source-specific masks are supplied/reviewed |
| Human-reviewed architectural classes | Schema extended; review history reused | Real arch/column/dome annotations remain to be independently reviewed |
| Comparable source-camera gate | Integrated with existing camera projection checks | Synthetic camera fixtures test code only; they do not calibrate a real camera |
| Silhouette and contour metrics | Implemented and tested | No real candidate/ground-truth pair is claimed |
| Semantic feature metrics | Existing evaluator integrated | A metric is incomplete without reviewed same-source annotations |
| Licensed, hash-pinned real-building held-out set | Not present in repository baseline | **Blocking acceptance gap** |
| Independent mask/feature reviewer sign-off | Not present for a real-building pilot | **Blocking acceptance gap** |
| Visually inspected real-photo overlays and source-camera renders | Not present | **Blocking acceptance gap** |
| Independent surveyed dimensions / 3D truth | Not included | No physical-dimension or universal accuracy claim is allowed |

The package only marks real-world validation as present when an exact manifest and report are supplied, their hashes match the bytes, manifest validation succeeds, the report includes evaluated held-out samples and metrics, and rights/annotation review states are supplied. Even then the result remains \`review-required\`; caller attestations and hashes cannot independently prove that a licence or annotation is true.

## Validation

Run the focused integration tests:

\`\`\`bash
npm run test:building-visual-evidence-package
npm run test:building-mask-provider
npm run test:architectural-observation-schema
npm run test:architectural-feature-proposals
npm run test:source-camera-render
npm run test:building-segmentation-benchmark
\`\`\`

The new integration command is added to \`.github/workflows/ci.yml\`. Exact-head CI must complete before merge. The existing full CI includes production build and browser/render validation; this document does not treat a source test as proof that a real building was reconstructed accurately.

## Required real pilot before calling BRF-05–07 accepted

1. Assemble a permissioned, hash-pinned real-building capture set with known building/view identity and independently reviewed building/occluder masks.
2. Keep capture groups wholly inside development or held-out evaluation; do not tune thresholds against held-out views.
3. Review feature overlays for the same original pixels and mark visible, partly occluded, occluded, not visible and not detected separately.
4. Capture a credible source-camera manifest with calibration/frame-alignment evidence and independently grounded control points.
5. Render the exact candidate GLB and inspect each source-camera image against its own reference. A mismatched or uncertain camera remains \`not-comparable\`.
6. Record metric definitions, per-class sample counts, per-building failures, reviewer decisions and artifact hashes.
7. Only after these artifacts and exact-head CI are reviewed may the tracking issue's remaining acceptance boxes be closed. No provider is automatically selected and no candidate is made map-ready by this package.


## Runnable bundle CLI

The package can now be executed through the repository's safe, manifest-driven CLI:

\`\`\`bash
npm run build:building-visual-evidence-package -- path/to/evidence-bundle.json
\`\`\`

The bundle and every referenced asset path must be project-relative and stay inside the repository root. The CLI rejects traversal/symlink inputs, checks the source image's decoded dimensions and bytes, decodes binary mask assets to source-resolution 0/255 planes, verifies GLB and evidence bytes, creates the hash-bound report, and writes each generated overlay to a new output directory without silently overwriting previous artifacts. Supply an explicit second output-directory argument when the default artifact location already exists. Use \`--root=path/to/project\` when running from another working directory.

A minimal bundle shape is shown below. The entries in angle brackets are placeholders, not valid evidence; every path, digest, reviewed annotation and camera/calibration file must be supplied by the real capture package.

\`\`\`json
{
  "schemaVersion": "1.0.0",
  "buildingId": "building-example",
  "viewId": "front",
  "generatedAt": "2026-10-27T00:00:00Z",
  "datasetTier": "real-building",
  "source": {
    "id": "source-front",
    "sourceId": "capture-front",
    "path": "data/source/front.png",
    "sha256": "<actual-source-sha256>",
    "width": 1600,
    "height": 1200,
    "mimeType": "image/png",
    "rights": {
      "status": "verified",
      "evidenceId": "rights-review-01",
      "evidencePath": "data/rights/front-permission.pdf",
      "evidenceSha256": "<actual-rights-file-sha256>",
      "reviewerId": "reviewer-id",
      "reviewedAt": "2026-10-27T00:00:00Z"
    }
  },
  "model": {
    "path": "data/candidate/building.glb",
    "sha256": "<actual-glb-sha256>"
  },
  "buildingMask": {
    "path": "data/masks/front-building.png",
    "result": {
      "schemaVersion": "1.0.0",
      "sourceId": "capture-front",
      "inputSha256": "<actual-source-sha256>",
      "provider": {
        "id": "manual-review-v1",
        "kind": "human-reviewed-mask",
        "version": "1",
        "configurationSha256": "<actual-configuration-sha256>"
      },
      "mask": {
        "sha256": "<actual-encoded-mask-sha256>",
        "bytes": 12345,
        "width": 1600,
        "height": 1200,
        "encoding": "binary-8bit-white-foreground-v1",
        "coordinateConvention": "pixel-origin-top-left",
        "backgroundValue": 0,
        "foregroundValue": 255
      },
      "assessment": {
        "status": "reviewed",
        "confidence": 1,
        "humanReviewed": true,
        "reviewerId": "reviewer-id",
        "reviewedAt": "2026-10-27T00:00:00Z"
      }
    }
  },
  "occluderMasks": [
    {
      "role": "vegetation",
      "path": "data/masks/front-vegetation.png",
      "result": {
        "...": "provide the same source-bound reviewed mask result contract"
      }
    }
  ],
  "edgeMap": {
    "path": "data/edges/front.png",
    "sha256": "<actual-edge-map-sha256>",
    "width": 1600,
    "height": 1200
  },
  "reviewedAnnotationsBatch": {},
  "camera": {
    "manifestPath": "data/camera/front.json",
    "calibrationEvidencePath": "data/camera/calibration.json",
    "frameAlignmentEvidencePath": "data/camera/model-frame-alignment.json"
  },
  "sourceCameraRender": {
    "path": "data/renders/source-camera.png",
    "silhouetteMask": {
      "path": "data/renders/source-camera-silhouette.png",
      "extractionVersion": "reviewed-mask-extractor-v1"
    }
  },
  "referenceSilhouette": {
    "path": "data/reference/front-silhouette.png",
    "review": {
      "status": "reviewed",
      "independentlyReviewed": true,
      "annotationId": "independent-mask-01",
      "reviewerId": "independent-reviewer",
      "reviewedAt": "2026-10-27T00:00:00Z"
    }
  }
}
\`\`\`

The CLI report is diagnostic evidence, not the final sign-off. The reference silhouette must be independently reviewed and source-bound; the candidate silhouette must have been extracted from the exact source-camera render. The candidate GLB still needs the existing geometry/topology/texture QA and visual review workflows. A \`review-required\` report is not approval, and \`incomplete\` / \`not-comparable\` should be treated as blocked acceptance.
