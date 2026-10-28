# BRF-38 — exact-asset rights-scope gate

**Status:** validator and blocked TUM2TWIN rights manifest. No source rights approval is inferred.  
**Tracking:** BRF-38 issue #254 and [asset-rights / candidate selection issue #240](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/240).

## Current public-source findings (checked 2026-10-28)

- TUM2TWIN UAS photographs: https://tum2t.win/datasets/im-uas — describes the images as openly available and notes filtering of recognizable people/license plates, but the page does not state an asset-specific license.
- TUM2TWIN UAS laser scanning: https://tum2t.win/datasets/pc-uas — likewise describes the point-cloud data as openly available without a visible asset-specific license on the page.
- Zenodo latest record v1.2.0: https://zenodo.org/records/15282970 — includes Images.zip, ULS/photogrammetry LAZ products, trajectory and metadata. The rendered Rights section contains a License heading with no value. The published file checksums shown there are MD5; they are not SHA-256.
- Separate GT-LOD3 Benchmark repository: https://github.com/gdslab/GT-LOD3-Benchmark — declares CC BY 4.0 for its benchmark. The separate repository license does not, by itself, prove that every different TUM2TWIN/Zenodo file or derived GLB uses that license.

These observations do not grant permission. The manifest keeps the exact TUM2TWIN CityGML, image archive and ULS source blocked pending exact-file rights evidence. The known CityGML SHA/size are retained as source pins, but BRF-38 still requires that the exact local source bytes are supplied and rehashed for the current evidence packet.

## What the gate enforces

1. Every source asset must bind rights to its own file SHA-256, exact source filename, record URL and immutable/versioned source record.
2. A license identifier/name/URL alone is insufficient. The record also needs an evidence URL, locally acquired evidence snapshot, exact snapshot hash and size verified by the BRF-36 verifier, retrieval time, grantor/rights holder, attribution, restrictions, scope description and named/time-stamped human decision.
3. The human-reviewed grant must explicitly include every requested use scope. Source-byte redistribution is a separate scope and is not inferred from permission to publish a derived model.
4. Candidate GLB rights require every reconstruction parent asset to allow derivation, public display of the derived model and commercial derived-model use (or the explicit custom parent-scope list in the manifest).
5. Derived candidate artifact bytes must themselves be locally pinned and verified. No rights metadata can make a missing candidate GLB valid.
6. The gate returns evidence completeness only. Even a complete synthetic fixture yields evidence-complete-human-review-required; all release flags remain false.

## Run

~~~bash
npm run test:brf38-rights-scope
node scripts/validate-brf38-rights-scope.mjs \
  benchmarks/building-reconstruction/brf-38-rights-scope.json \
  --asset-root . \
  --report artifacts/brf38-rights-scope-report.json
~~~

The real manifest is expected to exit with code 2 until local source assets and the rights-evidence snapshots have been supplied and byte-verified, each grant explicitly covers the requested scope, and a candidate artifact exists. The CLI does not download source files or trust URL access as proof.

## Release boundary

This is not legal advice or a license interpreter. The source maintainer or rights holder must explicitly confirm the exact file scope, derivative use, commercial use, attribution and restrictions. The same-building identity, independent held-out controls, approved horizontal/vertical frames, GLB geometry QA and human accuracy review remain separate gates. All release flags stay false.
