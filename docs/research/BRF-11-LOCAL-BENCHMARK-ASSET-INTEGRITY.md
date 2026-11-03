# BRF-11 — Local benchmark asset byte integrity

**Date:** 27 October 2026  
**Status:** implementation under review; actual survey-backed evaluation remains blocked.

## Why this step exists

BRF-10 validates that a manifest declares expected asset URLs, byte sizes, SHA-256 digests, rights review, source separation, coordinate frames and held-out controls. It deliberately does not prove that bytes on disk match those declarations. BRF-11 adds a deterministic local verifier so an intake can fail closed before a reconstruction or geometry evaluation uses stale, substituted or missing files.

## New tooling

Run:

```bash
npm run test:building-benchmark-asset-integrity
npm run verify:building-benchmark-assets -- --help
npm run verify:building-benchmark-assets -- path/to/manifest.json --asset-root path/to/downloaded-assets
```

Each `assets[]` entry used by this verifier needs a safe `localPath` relative to the selected asset root, a positive `byteSize`, and a SHA-256 digest computed from the exact file bytes. The candidate additionally needs `candidate.glbPath`, `candidate.glbByteSize`, and `candidate.glbSha256`. The verifier streams bytes through SHA-256, checks exact sizes, refuses path traversal and symlinked asset components, checks declared candidate inputs are image assets, and blocks candidate bytes that duplicate a verified reference asset. Exit code 0 means all checks in this *local byte-integrity scope* passed; code 2 means a blocked manifest/file; code 1 means malformed input or an invocation/read error.

## What the verifier does not prove

It does not download files, authenticate the source's authority to license them, prove the same physical building appears in every file, validate the correctness of CRS/vertical datum/frame transforms, determine that controls are truly independent of fitting, certify that a GLB came from the platform rather than being manually substituted, evaluate reconstruction accuracy, or enable acceptance/publication/map readiness. SHA-256 provides byte identity, not provenance truth.

## Public benchmark intake triage (27 October 2026)

- [GT-LOD3 benchmark repository](https://github.com/gdslab/GT-LOD3-Benchmark) identifies a Gold Coast collection and advertises CC BY 4.0 for the benchmark. Its documented Gold Coast data link resolves to [the D2S STAC collection](https://stac.d2s.org/collections/ee10a5c0-2554-44e5-b59f-81eedfe02eb6?language=en). During this review, the browser returned a 404 for the requested collection/item API path, so an exact asset could not be selected or downloaded from that link. Do not declare a sample acquired until a working official asset URL is confirmed.
- The same benchmark repository links its TUM subset to [TUM2TWIN UAS point clouds](https://tum2t.win/datasets/pc-uas) and [semantic building models](https://tum2t.win/datasets/cm-buildings). The public [TUM2TWIN model repository](https://github.com/tum-gis/tum2twin) shows a CC BY 4.0 repository licence and points to a distinct GitLab dataset repository. That repository-level licence should not be assumed to cover every external point-cloud asset or upstream data source.
- [Fraunhofer's TUM-MLS-2016 dataset page](https://www.iosb.fraunhofer.de/en/competences/image-exploitation/object-recognition/3d-data/datasets/tum-mls-2016.html) describes a separately acquired mobile laser scan at TUM City Campus and explicitly states CC BY-NC-SA 4.0. This is a different sensor modality from UAS imagery, but the non-commercial/share-alike terms and access conditions must be reviewed against intended use before selecting it. Its acquisition may have time gaps and it is not automatically a complete, facade-visible match for any specific GT-LOD3 building.
- The TUM2TWIN UAS laser scan hosted separately on Zenodo was also left out of intake because its current record's visible licence field was blank in the earlier source audit.

## Current decision

**No sample is accepted yet.** The available public pages are promising leads, but a working exact asset, exact version, source bytes, file-level attribution/licence review, building identity pairing, coordinate frame/vertical datum, and a credible independently held-out control source have not all been verified together. No dataset sample or raw survey archive is committed to the repository. No candidate GLB or real-world accuracy result is claimed. `acceptanceEligible`, `publicationEligible`, `mapReady`, and automatic approval remain false.
