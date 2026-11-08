# D3M-ENGINE-11 — Signing-time package integrity preflight

**Tracking issue:** [#360](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/360)  
**Dependency:** D3M-ENGINE-10 PR [#359](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/359), exact base `bfbcde08c2657a359bdc3dd9afbed5d4f308cee0`  
**Branch:** `feat/d3m-engine11-signing-integrity-preflight-20261104`

## Verified gap

D3M-ENGINE-10 added registry-bound v2 Ed25519 signatures, but its signing CLI only checked manifest policy fields. It did not enumerate the actual package directory or call `verifyBuildingReviewPackage` before signing. Therefore a package with a missing artifact, changed bytes, broken cross-reference or invalid recomputed GLB/texture QA could still receive a signature, even though later combined verification would reject the package.

## Implementation

A shared `building-review-package-directory.mjs` inventory layer is now used by:
- `sign:building-review-package` for mandatory pre-signing and post-signing integrity verification;
- `verify:building-review-package` for standalone package integrity;
- `verify:signed-building-review-package` for combined artifact and signer verification.

The directory reader:
- rejects a symlinked package root, nested symlink, special file, unsafe path and traversal;
- opens regular files with `O_NOFOLLOW` where supported;
- checks descriptor and path identity plus byte length, size, modification time and change time before and after each read;
- computes SHA-256 from the exact bytes read and produces a deterministic inventory snapshot token.

The v2 signer now:
1. takes the shared snapshot and runs full offline package integrity verification;
2. refuses to sign if any integrity error exists;
3. validates the existing trusted reviewer registry and private/public key match;
4. exclusively creates the detached signature;
5. takes a fresh package snapshot and repeats integrity verification;
6. requires the manifest/artifact snapshot to remain identical; on drift, removes only the signature file created by this process and fails.

A package with warnings but zero integrity errors can remain eligible for final human review; the warning count is reported and is not converted to acceptance. The combined verifier uses the same inventory logic, preventing the signer/verifier from silently interpreting the directory differently.

## Regression coverage

- Stable inventory hashing, deterministic snapshot comparison and snapshot drift.
- Root/manifest/artifact symlink rejection, non-directory package roots and unsafe filenames.
- CLI refusal to sign an incomplete package, with no signature file left behind.
- Existing registry-based v2 signature verification and explicit v1 legacy path still covered.
- Combined verifier continues to report independently whether the signature passed while artifact integrity failed.

## Limits

The preflight verifies package contents relative to the included manifest at signing time. It is not a filesystem lock and cannot stop a privileged writer from changing files after signing. Use controlled, non-concurrent write access during signing and re-run combined verification after copy/transfer.

A valid signature still proves possession of an operator-provisioned key and exact package bytes only. It does not prove reviewer civil identity/authority, source rights, surveyor authenticity, metric survey truth, vertical datum, building correspondence or architectural accuracy. All publication/map/automatic approval flags remain false.

**Validation pending:** exact-head focused tests, ESLint, production build, and Push/PR Full CI must all pass before calling this milestone software-validated. No parent PR is merged or retargeted by this increment.
