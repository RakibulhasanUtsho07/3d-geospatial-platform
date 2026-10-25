# Bangabhaban candidate review decision — P3.3

**Decision: provisional candidate accepted for engineering review only. Not accepted as a historically accurate, survey-verified model; PR remains Draft.**

## Exact artifact identity

- Building: বঙ্গভবন (Bangabhaban), Dhaka
- Candidate GLB: `public/models/bangabhaban-lod3.glb`
- Candidate SHA-256: `b51d01087e205b8051921cfc2427293309ff91e3180b3f6b4bcdfc2f4d2a0399`
- Candidate bytes: 743,056
- Render workflow: [P3.3 run 40206865435](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40206865435)
- Review bundle artifact ID: 12604305395
- Source code commit used by the successful render: `28f1aa86a49ca5c0ac156abda8e43efebf12a24a`
- The workflow then committed the generated candidate and evidence. This decision note is based on that hash-pinned artifact, not a later unverified re-render.

## Verified automated results

| Gate | Result | Interpretation |
|---|---|---|
| GLB container / geometry QA | Valid | File can be parsed by the project's GLB QA adapter |
| LOD1 / LOD2 / LOD3 generation | Passed in render workflow | Three candidate detail levels were built |
| LOD3 triangle count | 8,684 | Geometry quantity only; not a fidelity score |
| Degenerate triangles | 0 | No degenerate triangles found by the current QA adapter |
| Meshes / primitives | 15 / 19 | Semantic mesh names are present |
| Deterministic render views | 13 / 13 at 1024×1024 | Front, back, left, right, top and eight 45° turntable images exist |
| Render manifest | Valid; 0 errors, 0 warnings | All required render files and their hashes were checked |
| Licensed reference intake | 3 / 3 verified | Actual downloaded bytes have SHA-256 records and per-file license/author metadata |
| Texture / UV QA | Review recommended | 0 textures, 0 images and 0 UV accessors; all 19 primitives are untextured |
| Topology QA | Review required | 14 primitives report long-triangle-edge hints; 10 report disconnected-component hints. No degenerate triangles were found. |
| Publication eligibility | Blocked | Successful generation/rendering does not prove architectural accuracy |

## Visual review findings

The updated fixed-camera contact sheet is materially easier to inspect after the dark-background/light-scaling correction. Recess-shadow panels also make the front arcade bays more legible.

The model remains a stylized parametric exterior proxy:
- The broad wing/roof masses and the dome position are approximations from uncalibrated photos, not a traced architectural plan.
- The central roof field is simplified, and facade detail density does not fully reproduce the reference photograph.
- The stairs, plinth, openings and orientation remain estimated in model space.
- No source photo is used as a texture. There is no texture atlas, UV projection or image-derived photogrammetric reconstruction.
- The 2006 aerial (Naira Al Husain, CC BY-SA 4.0) and two 2017 images (ASaber91, CC BY 2.0) are used for qualitative comparison only; retain attribution and applicable license conditions.

## Remaining release blockers

1. Obtain an independently traced footprint and/or rectified facade set with known camera geometry or survey/control measurements.
2. Correct facade/roof/dome proportions against those references, rather than assuming visual similarity from a render alone.
3. Review long-edge and disconnected-component warnings primitive-by-primitive; do not auto-dismiss architectural pieces as harmless without inspection.
4. Add UVs and a texture atlas only with licensed source images and a validated projection/occlusion workflow.
5. Run the full repository CI on the final current PR head and record the final status.

**No merge to `development` or `main` is approved by this review note. Keep PR #169 Draft until the remaining visual, geometry and evidence gates are independently satisfied.**
