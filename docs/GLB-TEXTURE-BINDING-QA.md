# GLB texture-binding QA

This stage checks whether an exported GLB is structurally wired for texturing. It is separate from geometry QA and does not claim visual or architectural correctness.

## Run the unit tests

```powershell
npm run test:glb-texture-binding-qa
```

## Review an existing GLB

```powershell
npm run review:glb-texture-bindings -- ".\\building.glb" ".\\glb-texture-qa.json"
```

To require that the exact atlas PNG is embedded in the GLB, pass both the atlas and the manifest produced by `build:texture-atlas`:

```powershell
npm run review:glb-texture-bindings -- ".\\building.glb" ".\\glb-texture-qa.json" ".\\texture-atlas.png" ".\\texture-atlas-manifest.json"
```

The optional atlas verification computes the PNG SHA-256, validates its dimensions against the manifest, and confirms that the same byte stream appears as an image in the GLB. It is not sufficient that a material simply declares some texture.

The report checks embedded image sources and dimensions, glTF material-to-texture-to-image references, sampler references, each textured primitive's requested `TEXCOORD_n` attribute, UV accessor layout and values, index bounds, and UV-degenerate triangles. External image URIs are reported because they mean the GLB is not self-contained. Structural errors return a non-zero process exit code; the report is still saved for diagnosis.

## Limits

This is data-level QA, not a renderer. It does not determine whether a photo belongs to the correct facade, nor can it prove architectural detail or eliminate every visible artifact. A clean report never sets `publicationEligible` to true by itself.

## UV seam and texture image review

The GLB report now includes `uvSeamReviews` per used texture-coordinate set. Shared geometric edges are matched using a scale-relative tolerance; when adjacent triangles assign different UVs to the same 3D edge endpoints, the report records `review-candidate` items. These may be intentional atlas seams; no UVs are altered and no seam is automatically labelled a defect.

For embedded PNG base-color textures, candidates also receive bounded pixel samples along the two mapped atlas edges. The `texturePixelSeamReviews` report records mean, p95 and maximum RGB edge deltas plus inset-side comparisons. High or moderate color discontinuities are warnings for human review, not automatic defect classifications: adjacent building surfaces can legitimately differ in color, lighting, exposure or material. Unsupported or too-small pixel data is explicitly reported as unavailable/insufficient instead of silently passing.

For embedded PNG files with a supported non-interlaced 8-bit layout, the report estimates pixel-luminance variation from a bounded sample. Tiny textures and near-uniform/mostly-transparent images receive review-risk hints. Unsupported PNG layouts and JPEG pixel statistics are reported as unavailable rather than being treated as clean. These are heuristics, not semantic image classification.

Added test commands:

```powershell
npm run test:uv-seam-review
npm run test:texture-pixel-seam-review
npm run test:texture-image-content-review
npm run test:glb-texture-binding-qa
```

None of these checks confirms how the model looks when rendered. Review the GLB in a viewer to judge visible seams, projection, texture sharpness and correct facade assignment.
