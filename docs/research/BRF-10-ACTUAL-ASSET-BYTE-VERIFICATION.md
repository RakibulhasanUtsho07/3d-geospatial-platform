# BRF-10 — Actual local asset byte verification

**Status:** Implemented as a fail-closed local-file verifier; real survey-backed building acceptance remains blocked.

## Why this stage exists

The benchmark-readiness preflight checks that an asset manifest declares a URL, filename, byte size and SHA-256. Declarations alone do not prove the local asset matches those values. This stage verifies the bytes of files already downloaded into a controlled directory.

## Usage

Put the exact downloaded files under a dedicated directory. Add a `localPath` to each `assets[]` entry in the intake manifest; it must be relative to the asset root and must not use `.`/`..`, absolute paths or symlinks.

```sh
npm run test:building-benchmark-asset-verification
npm run verify:building-benchmark-asset-bytes -- path/to/intake-manifest.json --root path/to/downloaded-assets
```

The CLI emits per-asset actual byte size and streamed SHA-256. It exits with:
- `0` only when all declared asset files exist, are regular files under the selected root, and match both declared byte size and SHA-256;
- `2` for incomplete or mismatched declarations/assets;
- `1` for unreadable or malformed input (including invalid JSON).

The verifier hashes one file at a time as a stream and applies an 8 GiB default per-file limit; tests can lower the limit to exercise the fail-closed gate. Raw survey archives must not be committed to Git. Keep them outside the repository and store only approved small evidence/manifests or short-lived CI artifacts where allowed.

## Important distinctions

- A `verified` byte report means the local file contents match the manifest's declared size and SHA-256. It does **not** authenticate the source server, validate license terms, prove the file depicts the declared building, validate the coordinate reference system/vertical datum, verify frame registration, or establish that ground control is independent.
- `rightsReviewDeclared` is only a mirror of the manifest's `license.reviewStatus`; the verifier is not a legal review and does not certify a licence.
- The tool never changes `acceptanceEligible`, `publicationEligible`, `mapReady` or `automaticApproval` to true.
- Candidate GLB generation and independent-truth geometry evaluation are separate later gates; dataset ground truth must never be imported as the platform-generated candidate.

## Source intake limitation

GT-LOD3's public repository states CC BY 4.0 and documents a paired image/ground-truth LOD3 benchmark. Its linked Gold Coast STAC collection was observed returning a 404 during the 27 October 2026 source audit. Do not infer an individual downloadable building asset or local checksum from that broken collection reference. The TUM2TWIN UAS laser-scanning record previously reviewed has no visible license value, so it remains blocked from reuse until exact asset/version rights are confirmed.

Sources:
- [GT-LOD3 Benchmark repository and licence statement](https://github.com/gdslab/GT-LOD3-Benchmark)
- [GT-LOD3 paper](https://doi.org/10.5194/isprs-annals-XI-2-2026-293-2026)
- [TUM2TWIN UAS laser-scanning dataset page](https://tum2t.win/datasets/pc-uas)
- [TUM2TWIN LOD3 building models](https://tum2t.win/datasets/cm-buildings)

## Next gate

Select one exact building only when source assets can be paired unambiguously, exact asset/version reuse terms are reviewed, actual downloads are hash-verified, and CRS/vertical datum/source-to-evaluation transform can be established. Then produce a separate platform-generated candidate GLB and evaluate it against independent reference geometry with held-out controls. Until those conditions are met, the real-building result stays `BLOCKED`/`NOT_COMPARABLE`.
