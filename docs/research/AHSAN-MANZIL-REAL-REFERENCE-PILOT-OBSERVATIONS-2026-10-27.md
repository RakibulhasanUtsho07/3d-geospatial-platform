# Ahsan Manzil BRF-05–07 real-reference pilot observations

**Research date:** 2026-10-27  
**Tracking issue:** [#199](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/199)  
**Reference-intake workflow:** [Run 40445441981](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40445441981)  
**Reference artifact:** \`brf-05-07-ahsan-manzil-reference-review-packet\` (artifact ID \`12707817673\`, 30-day retention)  
**Status:** Real source bytes and a visual packet are available. Independent annotation and calibrated model comparison are still pending.

## 1. Hash-pinned reference imagery collected

The existing allowlisted downloader fetched the four sources from Wikimedia Commons and verified the source manifest contracts. SHA-256 below is computed from the actual downloaded bytes, including the aerial derivative; the aerial's published SHA-1 and byte length describe the original file and are kept separately.

| View | Source / attribution | Downloaded dimensions | Bytes | SHA-256 |
|---|---|---:|---:|---|
| Front elevation | [Front view of Ahsan Manzil.jpg](https://commons.wikimedia.org/wiki/File:Front_view_of_Ahsan_Manzil.jpg), Sumonto.ck, CC BY-SA 4.0 | 4160 × 3120 | 3,223,750 | \`90c5ca2c27020d5d49294675c8cb662a40ec50874c298bff227a95aa90de7a99\` |
| Side facade | [Ahsan Manzil (side).jpg](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil_(side).jpg), Mrpluto11, CC BY-SA 4.0 | 3096 × 2322 | 1,322,192 | \`6330269884ed2a34927e41e3cc14223795cc6d6f3e92a96cf279a28e34a4a0b0\` |
| Oblique facade | [Ahsan Manzil Side View.jpg](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil_Side_View.jpg), Parvezahmed, CC BY-SA 4.0 | 4000 × 3000 | 2,808,254 | \`e8d2076274c078aa6bef7de9c1ff968135a55dd5df8c60dca1b1636764ccbe77\` |
| Aerial-oblique roof view | [Ahsan Manzil 01.jpg](https://commons.wikimedia.org/wiki/File:Ahsan_Manzil_01.jpg), Azim Khan Ronnie, CC BY-SA 4.0; Wikimedia 1280 × 853 derivative | 1280 × 853 | 489,368 | \`bd09cb982800dc42cbf80e096d59ccb70126f5816939ea9d55c00ef3c45d29d9\` |

All four original/derivative files and the machine-generated packet are stored as a GitHub Actions artifact, not committed into source control. The packet includes the image files, a contact sheet (1600 × 1200; SHA-256 \`7d8ce49047ee496b3a9a55cfac3b8b05c292a13b921ff31d92621144e0f8c0d4\`), a manifest, checksums and one annotation template per view.

**License caution:** The source metadata identifies the photos as CC BY-SA 4.0. Attribution, licence link and modification disclosure must travel with redistributed derivatives. The packet's rights field remains \`pending-independent-review\`; download/hash verification is not a legal opinion.

## 2. Annotation and segmentation status

The packet intentionally contains *pending templates*, not accepted masks or ground truth:

- The building and each occluder class (vegetation, vehicles, people, wire/poles, adjacent structures, shadows and uncertain regions) still require pixel-level human annotation or correction.
- Roofline, outer corners, floor bands, windows, doors, arches, columns, dome, cornice, pediment, staircase, parapet and ornament records are empty until reviewed in original-image pixel coordinates.
- All templates explicitly carry \`groundTruth: false\`, \`acceptanceEligible: false\` and \`reviewedByIndependentHuman: false\`.

An exploratory pink-colour threshold was inspected only as a diagnostic. It falsely selected non-building pixels (for example, neighbouring pink surfaces, people/clothing and foreground areas) and missed some shaded facade regions. **It is rejected as a semantic building mask** and must not be used as training ground truth or to pass BRF-05. No accuracy score is reported without reviewed labels.

## 3. Preliminary generated-GLB visual finding

The successful repository CI render workflow produced \`ahsan-manzil.glb\` in artifact \`ahsan-manzil-generated-glb\` (from [CI run 40381892198](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40381892198)). The exact GLB examined has:

- Size: 7,235,652 bytes
- SHA-256: \`10285b0c68c7ca9b137f4d05aa03f4b6c7cf1908c4d67d749beeedaef3e83f70\`
- 22 geometry objects in the loaded scene; 85,920 triangles across those objects, including site-context geometry
- Main plinth X bounds: \`[-62.7, +62.7]\` (125.4 model units wide)
- Dome/finial center X ≈ 34.8; front-stair center X ≈ 34.8; stair bounds X ≈ \`[19.89, 49.71]\`
- Normalized dome/stair X within the plinth width: \`(34.8 - (-62.7)) / 125.4 ≈ 0.778\` (about 77.8%)

On the front reference photo, the central dome and main staircase appear close to the facade centre (approximately 46.9% of the image width by visual inspection). The generated GLB places both in the right-hand portion of the plinth (about 77.8%). This is a **suspected major placement/layout defect** requiring correction and independent review.

This visual comparison used an explicitly approximate front-facing VTK render and is **not a calibrated source-camera comparison**. The reference camera pose, lens calibration, surveyed control points and independent building dimensions are not available. Its status for BRF-07 acceptance is therefore **\`NOT_COMPARABLE\`**; the percentage difference above is a visual discrepancy signal, not a physical-accuracy score. Do not publish or mark the model accurate because the GLB is syntactically valid or CI is green.

## 4. Evidence and reproducibility

- [Reference-image intake and review-packet workflow](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40445441981) — passed. It downloaded/hash-checked the four views and uploaded the packet.
- [Integrated BRF-05–07 CI run](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40381892198) — passed on the implementation commit; includes focused integration tests, CLI smoke test, production build and viewport/browser validation.
- [Visual evidence package implementation](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/src/core/building-generation/building-visual-evidence-package.mjs)
- [Evidence bundle CLI](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/blob/rakibul-hasan/scripts/build-building-visual-evidence-package.mjs)

## 5. Remaining acceptance blockers

1. Independent reviewer(s) must correct and sign off the source-bound building/occluder masks and architectural feature observations.
2. Produce a genuine held-out evaluation split grouped by capture/building, with hash-verified label bytes and per-class, per-image metrics.
3. Obtain credible camera calibration/frame-alignment evidence and independently grounded control points; if not comparable, keep the view blocked.
4. Correct the suspected dome/stair placement issue, render the actual candidate GLB through the same calibrated source camera, inspect the render/reference overlays, and record exact artifact hashes.
5. Supply independent surveyed dimensions or other accepted dimensional control before claiming metric 3D accuracy.

Until these gates pass, \`acceptanceEligible\`, \`publicationEligible\` and \`mapReady\` stay false, and Issue #199 must remain open.
