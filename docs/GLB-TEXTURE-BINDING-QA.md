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

This is data-level QA, not a renderer. It does not detect pixel-level seams, a flipped facade, blur, incorrect perspective, lighting mismatch, wrong-building imagery, or architectural detail. Those require rendering the GLB and reviewing it against independent references. A clean report never sets `publicationEligible` to true by itself.
