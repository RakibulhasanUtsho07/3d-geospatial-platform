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
2. The metadata PDF is now checksum-verified and text-extracted. It declares WGS 84 / UTM 32N (EPSG:32632), meters/degrees, and elevation above mean sea level; however, it does not name a vertical datum/geoid model. Its XYZ description also says "local coordinate system" separately from the georeferenced CRS, so the exact selected LAS/LAZ header/VLR and source-to-evaluation mapping still require review. The page previews for relevant tables/figures are being added to the revised workflow artifact.
3. No single building has yet been demonstrated to match a selected UAS image subset, a crop of the independent-sensor ULS cloud, and an individual model/footprint.
4. No selected source images or point-cloud crop have been downloaded and byte-verified for a chosen building. The small metadata PDF alone was verified: 1,256,889 bytes; publisher MD5 matched; actual PDF SHA-256 `54f646b757e03d1797c66b1811273b830592143ff868466077e456fac51db2a3`; extracted-text SHA-256 `3fa9bdf71110c7a1f07adfeae3c9228cf09d58314883ab015994106b7c634d45`. These hashes identify the metadata evidence, not the actual imagery/point-cloud files.
5. No platform-generated candidate GLB exists for this sample, and no independently held-out checkpoints have been sampled, pinned, and withheld from model fitting.

## Findings from the checksum-verified metadata PDF

The first exact-byte inspection succeeded in [workflow run #40634521973](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40634521973). The publisher MD5 matched the downloaded PDF; the PDF is 9 pages. Extracted text identifies these items:

- **Horizontal CRS declared by the PDF:** WGS 84 / UTM 32N, EPSG:32632 (PDF page 2).
- **Units:** meters and degrees. The same page says the XYZ coordinates are in a local coordinate system while separately identifying georeferenced data as EPSG:32632. The selected ULS LAZ header/VLR has now been inspected and declares EPSG:32632; the meaning of “local” in the PDF and source-to-evaluation mapping remain unresolved.
- **Vertical reference:** the PDF states elevation is above mean sea level but does not name a vertical CRS, datum or geoid model in the extracted text. This remains **BLOCKED** for metric 3D comparison.
- **Within-ULS alignment:** the PDF lists a 4×4 rigid ICP transform for aligning point-cloud part 3 to part 1, with post-alignment mean/std distances of 3.6/4.5 cm and 5.8/5.7 cm for comparisons to parts 1/2 (page 4). This is a source-acquisition-internal alignment, not a generic candidate-to-reference transform.
- **Source-product cross-comparison:** photogrammetry versus ULS (nadir-only) is reported with M3C2 mean difference 1.7 cm and standard deviation 22.8 cm (page 7). It is a comparison between related products of the same acquisition campaign—not accuracy for this platform's candidate GLB and not held-out checkpoint validation.

These are metadata-document declarations, not yet independent verification of a chosen building or exact asset bytes. The current workflow revision also renders pages 2, 4 and 7 as PNG previews so an operator can visually inspect the CRS statement, transformation table and accuracy chart rather than relying solely on text extraction. The readiness state stays blocked.

## The blocked intake fixture

[`brf-27-tum-downtown-intake.json`](../../benchmarks/building-reconstruction/brf-27-tum-downtown-intake.json) feeds the existing BRF-10 readiness validator. Its expected result is `blocked`; the corresponding regression test prevents accidental promotion to `manifest-complete` while unknown fields remain blank.

Run:

```bash
npm run test:building-benchmark-readiness
npm run assess:building-benchmark-readiness -- benchmarks/building-reconstruction/brf-27-tum-downtown-intake.json
```

The assessment command exits with code `2` because blockers are intentional. It is not a CI failure when interpreted as a fixture result; the regression test must pass.

## Metadata-document inspection automation

The [BRF-27 metadata workflow](../../.github/workflows/brf27-tum-metadata-intake.yml) fetches only the 1.3 MB PDF (never the multi-GB source archives), enforces a 10 MiB byte ceiling, verifies the publisher's recorded MD5 against the downloaded bytes, computes SHA-256, runs `pdfinfo` / `pdftotext`, and produces a keyword-evidence JSON plus extracted text. The revised workflow also renders pages 2, 4 and 7 to PNG for visual checks. It uploads only derived audit files and these page previews; the raw PDF stays in ephemeral runner storage.

The report is a navigation aid, not a CRS decision. Human review must trace any CRS, horizontal units, vertical datum, offset and transformation values back to the relevant page and figure/table. A missing keyword is not proof that a field is absent if the document uses a different name or image-only table. The readiness manifest remains blocked until those source facts are explicitly recorded and checked.

## BRF-28 — bounded LAZ header and CRS-VLR inspection

The [BRF-28 workflow](../../.github/workflows/brf28-laz-header-intake.yml) requests only bytes `0–8,388,607` from the selected ULS LAZ. It accepts the response only if the server returns HTTP `206` and a valid `Content-Range` beginning at byte zero with an end below the configured ceiling. If the origin responds with HTTP `200` instead, the script closes the response without reading the body and records a blocked result. It never attempts a full archive download.

The script parses the LAS signature/version, header size, point-data offset, point format, record length, scale factors, offsets, bounds and any CRS-related VLRs contained in the downloaded prefix. It records a SHA-256 only for the prefix. It explicitly does **not** claim the publisher's whole-file MD5 was verified, and may not see an EVLR placed after point records.

This is a metadata probe, not coordinate-frame approval. The header result must be compared with the documentation's local XYZ statement and EPSG:32632 declaration. It cannot name a vertical datum that the source does not specify, approve asset rights, establish a same-building identity, generate a candidate GLB, or certify any held-out accuracy result. All release gates remain false.

The unit tests cover a synthetic LAS header with an EPSG WKT VLR, truncated VLRs, invalid signatures, malformed ranges and—critically—the no-read behavior when a range endpoint returns a whole-response `200`.

## BRF-28 actual LAZ header findings

The bounded probe succeeded in [workflow run #40636959484](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40636959484); the JSON report is in [artifact #12793024221](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/40636959484/artifacts/12793024221).

- The source returned HTTP 206 with Content-Range bytes 0-8388607/2840830691. Exactly 8,388,608 bytes were read. The prefix SHA-256 is 3a9b3ae9d07520dcee6bae53ab17d932a9a76483cbb8673ec0ad6ac9dbd4abb4. The whole LAZ was not downloaded and its publisher MD5 remains unverified.
- The prefix parses as LAS 1.2: 227-byte header, point-data offset 1,186, four VLRs, compressed point format 3 (raw point-format byte 131), record length 34 bytes.
- Coordinate scale is 0.0001 for X/Y/Z. Header offsets: X=690802.2210446384, Y=5335907.745415179, Z=568.5466850988182. Header bounds: X 690787.9737446384–691169.3342446384; Y 5335827.531815179–5336383.198915179; Z 530.5947850988182–606.4985850988182.
- The GeoTIFF GeoKeyDirectoryTag identifies ProjectedCSTypeGeoKey = 32632. The companion GeoASCII tag says “WGS 84 / UTM zone 32N” and “WGS 84”. A WKT VLR stored with user ID liblas, record ID 2112, also states “WGS 84 / UTM zone 32N” and authority EPSG:32632. The linear-unit key is 9001 (metre).
- The parsed GeoKeyDirectoryTag contains no VerticalCSTypeGeoKey. That does not prove a particular vertical datum; the named vertical reference/geoid remains unresolved.

The header evidence strongly corroborates the projected horizontal CRS declaration. It does not resolve why the PDF describes local XYZ coordinates, nor does it establish a transform into an independently controlled evaluation frame. Header offsets and bounds are source-file coordinate metadata, not an approved candidate-to-reference transform.

## Required order to unblock

1. Visually review the checksum-bound page previews (especially the page-4 transformation/accuracy table) and inspect the selected source LAS/LAZ headers/VLRs. Establish the named vertical datum/geoid and confirm how local XYZ coordinates map to EPSG:32632; pin every chosen source file's actual bytes.
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
