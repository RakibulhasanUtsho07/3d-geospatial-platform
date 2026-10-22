# Texture atlas baking and UV remapping

Run the tests:

```powershell
npm run test:texture-atlas
```

Build a PNG atlas and manifest from a reviewed input JSON:

```powershell
npm run build:texture-atlas -- ".\\texture-candidate.json" ".\\texture-atlas-manifest.json" ".\\texture-atlas.png" --width=4096 --height=4096 --padding=4
```

Input example:

```json
{
  "images": [
    {
      "id": "front",
      "path": "./front.jpg",
      "width": 1600,
      "height": 1200,
      "sha256": "replace-with-64-character-lowercase-sha256",
      "verifiedSource": true
    }
  ],
  "faces": [
    {
      "vertices": ["v1", "v2", "v3"],
      "uv": [[0, 0], [1, 0], [0.5, 1]],
      "sourceImageId": "front",
      "materialId": "reviewed-front"
    }
  ]
}
```

The image path is resolved relative to the input JSON. Before baking, the CLI checks the image SHA-256 and uses `ffprobe` to verify that actual dimensions match the manifest. FFmpeg scales images with aspect ratio preserved, packs them into a deterministic, non-rotating atlas, extends edge pixels into gutters, writes a PNG, and remaps each face UV into atlas coordinates.

The default UV convention is normalized bottom-left. Input UVs are copied to `sourceUv` in the manifest for audit. The atlas builder does not estimate camera poses or verify that a source image truly corresponds to the face; these are upstream responsibilities. Any downscaling is recorded in the packing manifest. `publicationEligible` remains false pending visual seam review and geometry/registration QA.

After baking and GLB export, `reviewGlbTextureBindings` checks both UV discontinuity candidates and sampled pixel-color deltas on embedded PNG atlas edges. Pixel differences remain review signals, not automatic defects or repair instructions. The QA stage never changes UVs or repaints the atlas.
