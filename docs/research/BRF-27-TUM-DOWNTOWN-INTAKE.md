# BRF-27 — TUM Downtown survey-backed sample intake

**Status:** `BLOCKED` / source-discovery only  
**Branch target:** `development`  
**Purpose:** Establish a reproducible candidate path for one building without treating a campus-wide archive, a source-derived photogrammetry model, or unverified licensing/CRS metadata as accepted truth.

## What the sources establish

- The [Zenodo record v1.2.0](https://zenodo.org/records/15282970) publishes TUM Downtown UAS imagery, ULS point clouds, photogrammetry outputs, and a metadata document. The source record lists an `Images.zip` archive (displayed as 5.9 GB) and `TUM_Downtown_ULS_20241217_manual.laz` (displayed as 2.8 GB), with MD5 checksums.
- The [TUM2TWIN UAS photograph page](https://tum2t.win/datasets/im-uas) says the images are georeferenced by the UAS RTK GNSS system.
- The [UAS laser-scanning page](https://tum2t.win/datasets/pc-uas) says the point clouds are georeferenced by integrated RTK GNSS and include manually flown oblique scans for facade coverage.
- The [UAS photogrammetry page](https://tum2t.win/datasets/pc-uasp) documents photogrammetric point clouds reconstructed from the UAS photographs.
- The [semantic model page](https://tum2t.win/datasets/cm-buildings) says LOD3 building facades were manually modeled using official LOD2 building models plus additional mobile-laser-scan point clouds. This derivation must be recorded before the model is chosen as a reference.

## Why the intake remains blocked

The source discovery is promising, but these are not yet verified facts for a specific building:
1. The exact asset/version's applicable license, attribution, and use terms have not been reviewed. The rendered Zenodo record inspected here did not expose a specific license value.
2. The metadata PDF is listed on the record but has not yet been inspected for horizontal CRS, units, vertical datum, coordinate offsets, camera/point-cloud frames, and the exact transformations needed for metric comparison.
3. No single building has yet been demonstrated to match a selected UAS image subset, a crop of the independent-sensor ULS cloud, and an individual model/footprint.
4. No selected source files have been downloaded and byte-verified locally. Publisher MD5 values and human-readable sizes are recorded only as discovery metadata; they are **not** local SHA-256 pins.
5. No platform-generated candidate GLB exists for this sample, and no independently held-out checkpoints have been sampled, pinned, and withheld from model fitting.

## The blocked intake fixture

[`brf-27-tum-downtown-intake.json`](../../benchmarks/building-reconstruction/brf-27-tum-downtown-intake.json) feeds the existing BRF-10 readiness validator. Its expected result is `blocked`; the corresponding regression test prevents accidental promotion to `manifest-complete` while unknown fields remain blank.

Run:

```bash
npm run test:building-benchmark-readiness
npm run assess:building-benchmark-readiness -- benchmarks/building-reconstruction/brf-27-tum-downtown-intake.json
```

The assessment command exits with code `2` because blockers are intentional. It is not a CI failure when interpreted as a fixture result; the regression test must pass.

## Metadata-document inspection automation

The [BRF-27 metadata workflow](../../.github/workflows/brf27-tum-metadata-intake.yml) fetches only the 1.3 MB PDF (never the multi-GB source archives), enforces a 10 MiB byte ceiling, verifies the publisher's recorded MD5 against the downloaded bytes, computes SHA-256, runs `pdfinfo` / `pdftotext`, and produces a keyword-evidence JSON plus extracted text. It uploads only the derived audit files; the raw PDF stays in ephemeral runner storage.

The report is a navigation aid, not a CRS decision. Human review must trace any CRS, horizontal units, vertical datum, offset and transformation values back to the relevant page and figure/table. A missing keyword is not proof that a field is absent if the document uses a different name or image-only table. The readiness manifest remains blocked until those source facts are explicitly recorded and checked.

## Required order to unblock

1. Download the Zenodo metadata PDF and inspect its pages and embedded tables. Record the exact CRS/units/vertical datum/offsets and pin the document bytes.
2. Obtain and record the exact asset-level license/terms and attribution review. Do not convert the site's generic “open data” wording into a guessed CC license.
3. Select one real building by matching imagery coverage to the ULS cloud and a stable LOD2/LOD3 building ID. Save a small, deterministic image subset plus an explicit same-building evidence record.
4. Download only the chosen source files/crops, verify byte sizes and SHA-256, and retain the publisher MD5 only as a secondary cross-check.
5. Define the metric evaluation frame and explicit source-to-evaluation transforms. Separate candidate image inputs from the ULS reference cloud; document how controls/checkpoints are chosen.
6. Generate the candidate with this platform's reconstruction path. Extract candidate vertex positions and bind at least six genuinely held-out reference checkpoints to exact candidate GLB POSITION vertices.
7. Run BRF-25 and BRF-26, inspect geometry residuals and same-camera views, then obtain real human review. Keep every release gate false unless the actual evidence passes.

## Fail-closed assertions

- No fabricated building identity, byte count, SHA-256, reviewer identity, coordinate transform, control coordinate, or candidate GLB.
- A benchmark ground-truth/LOD3 model is never relabelled as platform-generated candidate geometry.
- Same-flight campaign does not imply identical sensor geometry or independent held-out control by itself; the provenance and split must be documented.
- `acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval` remain false.
- `main` is out of scope.

## Sources

- [Zenodo dataset record](https://zenodo.org/records/15282970)
- [TUM2TWIN UAS photographs](https://tum2t.win/datasets/im-uas)
- [TUM2TWIN UAS laser scanning](https://tum2t.win/datasets/pc-uas)
- [TUM2TWIN UAS photogrammetry](https://tum2t.win/datasets/pc-uasp)
- [TUM2TWIN semantic building models](https://tum2t.win/datasets/cm-buildings)
