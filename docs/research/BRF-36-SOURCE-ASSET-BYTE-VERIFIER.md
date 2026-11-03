# BRF-36 — exact source-byte verification

**Status:** local-byte verifier and pinned-source manifest; the real source set remains blocked until each intended asset is acquired locally and hash-verified.  
**Tracking:** issue #250 and [BRF-35 issue #248](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/248).

## What this adds

- Streams the bytes of local files and computes SHA-256; compares the actual byte count and digest to a pinned manifest.
- Rejects absolute/traversal paths, Windows drive syntax, nested symbolic links, missing files, duplicate asset IDs/paths, malformed hashes and declarations over the per-file/aggregate limits.
- Checks file identity/size/mtime stability across hashing to detect common source mutations during verification.
- Makes no network requests. The tool cannot convert a URL, filename or a rights-review string into byte verification.
- Separates byte integrity from rights, physical identity, CRS/vertical frame, accuracy and publication decisions. All four release flags remain false even when the local bytes match.

## Pinned CityGML source

- Immutable source commit: \`e032a71fc9b3c9c3d4869e3aca9677d1234086aa\`
- Source file: \`citygml/lod3-building-datasets/DEBY_LOD3_4959323.gml\`
- Git blob ID: \`2fd72c942399ff0cc78e3478dced74b60180e5dd\`
- Expected bytes: \`51178520\`
- Expected SHA-256: \`a7b30f1596683837329e7b674e16d0dada2c98e3640092129d9092479a67ba37\`
- Parsed in-file Building GML ID: \`DEBY_LOD2_4959323\`
- Source-declared CRS: \`EPSG:25832\`

The CityGML file is not committed in this repository. Place a privately acquired copy at \`private-source-assets/DEBY_LOD3_4959323.gml\`, and run with \`--asset-root private-source-assets\`. The initial benchmark manifest uses a relative source path and intentionally stays blocked until the file is supplied. Image/ULS/survey records remain pending because there is no reviewed same-building mapping.

## Run

~~~bash
npm run test:brf36-source-byte-verifier
node scripts/verify-brf36-source-assets.mjs \
  benchmarks/building-reconstruction/brf-36-source-assets.json \
  --asset-root private-source-assets
~~~

The command does not download files. A matching hash only proves byte identity against the pinned digest; it does not grant rights or prove the file represents the intended building.

## Next boundary

BRF-36 is split into source bytes first and coordinate-operation execution second. A separate follow-up must pin an explicit PROJ/EPSG operation and software/database/grid versions, execute documented test vectors, and independently resolve the Z datum. Until then, no coordinate transformation or accuracy score is claimed.
