# Texture bake readiness preflight

Run:

```powershell
npm run test:texture-bake-readiness
npm run assess:texture-bake-readiness -- ".\\texture-candidate.json" ".\\bake-readiness.json"
```

The input includes source image records (`id`, SHA-256, dimensions, `verifiedSource`), reviewed materials (`id`, `name`, `reviewed`) and faces (`uv`, `sourceImageId`, `materialId`). UV coordinates must be normalized to [0,1].

This stage checks input completeness and flags UV bounding-box overlap candidates for review. Bounding-box overlap is not a definitive triangle-intersection test. The stage does not create texture pixels, pack atlases, repack UV islands or synthesize missing image areas. An external baker and visual seam review are still required.
