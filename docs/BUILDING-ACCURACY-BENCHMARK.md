# Building Accuracy Benchmark — Parliament Pilot

**Purpose:** record what is and is not evidenced about the current Parliament photogrammetry pilot, and define repeatable acceptance gates. This is an evidence-based baseline, not a claim of survey-grade accuracy.

## Current evidence snapshot

The following values are from the previously recorded local Parliament reconstruction run. The exact GLB, COLMAP workspace and JSON report are not in this repository snapshot, so the measurements have not been independently re-run in CI.

| Area | Recorded evidence | Assessment |
|---|---|---|
| Reference image set | 8 original views: backside-2, front-facade, front-south-plaza, lake-01, photowalk-09, photowalk-10, wide-01, wide-02 | Small/incomplete multi-view set for a complex landmark; overlap and viewpoint spread need review |
| Registered images | 4 of 8 reference views were registered in the recorded run (50% of that set) | Weak coverage; registration ratio alone does not prove geometry accuracy |
| Sparse reconstruction | 96 sparse 3D points recorded | Weak evidence for the full landmark's complex shape |
| Dense reconstruction | 15,154 dense points recorded | More points do not prove correct surfaces or dimensions |
| Mesh | A cleaned output was recorded at about 5,474 vertices / 10,846 faces | Polygon count alone is not a fidelity metric |
| Texture | Texture atlas was generated and later mapping improved | Partial visual improvement only; texture quality cannot repair wrong geometry |
| Visual geometry | Recorded inspection found slab/block-like surfaces, stretched bands, holes, spikes/wings and sky/tree/background patches on the building surface | **Fails visual-fidelity review** |
| Real-world dimensions | No verified, independent length/width/height benchmark attached to this baseline | Not measured |
| Geospatial placement | No accepted surveyed ground-control residual report attached to this baseline | Not verified |
| Repeatability | Exact inputs, run config and output report are not committed with the asset | Cannot yet reproduce this baseline from CI alone |

The local test output parliament-develop-test.glb was previously reported at roughly 250 KB. File size is not a quality or accuracy measurement.

## Current verdict

- **Geometry / architectural fidelity: FAIL (qualitative visual review).** Known distortion and missing/incorrect surfaces are visible in the recorded inspection.
- **Texture: PARTIAL.** Mapping improved, but stretched/background patches remain evidence that the asset is not ready.
- **Scale accuracy: NOT MEASURED.** Requires independent dimensions and calibrated model scale.
- **WGS84 placement: NOT VERIFIED.** Requires reliable control points and separate vertical/elevation evidence.
- **Pipeline / automated QA: IMPLEMENTED, NOT A PROOF OF REAL-WORLD ACCURACY.** COLMAP diagnostics, camera-coverage heuristics, mesh-topology QA and review triage help find risks, but cannot prove the mesh matches the real building.
- **Overall accuracy percentage: NOT AVAILABLE.** There is no defensible way to convert these incomplete signals into a single percentage.

## Acceptance protocol for the next Parliament run

1. **Freeze the evidence.** Keep the eight original images, rights/attribution records, source IDs, exact COLMAP settings, exact GLB/PLY, sparse model and JSON report together under one run ID. Do not silently replace source images.
2. **Improve coverage before increasing mesh density.** Add sharp, overlapping photos around all accessible facades and corners, plus roofline/upper-level views. Keep camera-to-building distance and exposure reasonably consistent; avoid near-duplicate frames. Re-run image preflight and verify which photos registered.
3. **Review sparse geometry.** Check registered-image ratio, sparse point count, track lengths, reprojection error and camera positions/directions. Treat every metric as a diagnostic, not a standalone pass.
4. **Review the mesh.** Inspect front, rear, left, right, top and oblique views. Confirm the building silhouette, roofline, facade planes and corners. Investigate holes, detached islands, stretched triangles and background/sky texture contamination before retopology or texture baking.
5. **Benchmark dimensions.** Supply independently verified dimensions and a justified metres-per-model-unit value to npm run validate:model-dimensions. Do not derive the reference dimensions from the same generated mesh.
6. **Benchmark map placement separately.** Use at least three non-collinear surveyed ground-control points where practical. Review horizontal residuals and document vertical datum/height separately. A successful horizontal fit is not a geometry pass.
7. **Human sign-off.** A reviewer compares each side against its corresponding reference view, marks unsupported/occluded areas as unknown, and records accepted limitations. Keep mapReady and publicationEligible false until the project's approval workflow explicitly approves the asset.

## Recommended gates (initial engineering targets, not universal guarantees)

| Gate | Initial target | Why |
|---|---|---|
| Source coverage | At least 80% of selected usable views registered, with views distributed around the building | Avoid approving a model built from a small subset of the intended views |
| Sparse reconstruction | No low-coverage warnings; adequate feature tracks and acceptable reprojection error for the scene | Catch unstable camera/point reconstruction |
| Mesh integrity | No unexplained holes, spikes, long stretched surfaces or detached fragments in inspected building surfaces | A structurally valid GLB can still be visually wrong |
| Dimension check | All independently measured axes within a documented tolerance; start with 5% only as a screening tolerance | Scale/bounds sanity check, not architectural accuracy |
| Georeference | Survey/control-point residuals within the project's documented tolerance; vertical datum reported separately | Prevent plausible-looking but misplaced models |
| Texture | No obvious sky/trees/background baked into building faces; no missing material references | Ensure source imagery maps to the correct surfaces |
| Reproducibility | Exact input manifest, tool versions, settings and report retained | Make regressions measurable |

These are starter gates for internal review. They must be tuned to the building type, capture method and intended use. Passing them does not certify architectural, cadastral or survey accuracy.

## Required next evidence bundle

Attach or preserve these files for an actual numerical audit:

- exact latest GLB and preferably the cleaned/dense PLY;
- COLMAP sparse model (cameras, images, points3D, binary or TXT);
- run report.json, image-preflight report and model-review summary;
- the original eight reference images (not only a contact sheet);
- trustworthy independent building dimensions and their source;
- surveyed control points if map placement accuracy is required.

Once this bundle is available, report separate results for **view coverage, mesh integrity, dimensions, georeferencing, texture and human visual fidelity**. Do not publish a single accuracy percentage unless a defined, repeatable reference metric actually supports it.
