# D3M-ENGINE-16 — Registry-bound survey observation record attestations

**Tracking issue:** [#367](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/367)  
**Dependency:** D3M-ENGINE-15 PR [#366](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/366), exact base `4fa635adc3db4c44903bbbc78c896216a27f8b92`  
**Status:** Scope and trust contract established; implementation and validation are pending.

## Gap after D3M-15

D3M-15 packages the original opaque observation bytes and re-hashes them against `observationRecordSha256` from the held-out checkpoint manifest. This detects byte substitution relative to the manifest. It does not establish who made the declaration, who supplied the file, or which operator-controlled signing key approved its association with a checkpoint.

A package checksum alone is not an authenticity mechanism: an actor who can replace both the record and the unsigned manifest can recompute both hashes.

## D3M-16 goal

Add one detached Ed25519 attribution attestation for every held-out observation. The attestation is signed by a surveyor-controlled private key and verified offline against a dedicated, operator-provisioned, public-key-only trusted-surveyor registry.

The signed statement must bind, at minimum:

- observation ID and held-out checkpoint ID from the exact D3M-14 manifest;
- SHA-256 and byte length of the exact opaque D3M-15 record bytes;
- SHA-256 of the exact control-point manifest bytes;
- building ID and an explicit purpose identifying record attribution/checkpoint association;
- opaque surveyor ID, key ID, registry ID and public-key fingerprint;
- registry issue/expiry and key validity windows;
- canonical UTC signing time;
- `publicationEligible: false`.

The signature input must use a fixed domain-separation prefix and a deterministic canonical JSON representation. The attestation must not depend on locale-specific sorting or ambiguous JSON serialization.

## Trusted-surveyor registry

This is a separate trust domain from the reconstruction reviewer registry. Do not reuse reviewer IDs, reviewer keys, or `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON`.

The new registry must contain public keys only and use a strict versioned envelope. Enforce bounded input, canonical UTC timestamps, unique surveyor/key IDs and public-key fingerprints, at most one active key per surveyor, explicit revoked state, and a single linear key replacement chain. Reject unknown fields and malformed/expired/future registries. An all-revoked registry must remain a valid emergency lockout that authorizes no signatures.

The registry belongs in the deployment/operator secret-management system and must never be committed to this repository, included in a package, printed in CI, or populated with invented identities. Organizational onboarding must independently establish civil identity, qualification and authority before an opaque surveyor ID/public key is trusted.

## Package contract

- Keep D3M-15 metadata schema 1.3.0 readable as a legacy byte-integrity-only package.
- Introduce a new package metadata version only when every held-out record has exactly one attestation artifact.
- Derive the attestation path deterministically from the validated observation ID; do not accept manifest-controlled arbitrary paths.
- Offline verification must re-hash actual record bytes, derive the expected observation/checkpoint mapping from the exact packaged control manifest, verify the canonical signed context and Ed25519 signature against the supplied trusted-surveyor registry, and reject missing, extra, orphaned, duplicate, substituted or tampered attestations.
- The package verifier must distinguish `bytes-verified` from `attribution-signature-verified`; neither is a measurement-accuracy result or release approval.
- Preserve historic package verification for schemas 1.0.0–1.3.0. Legacy packages must never be upgraded or silently relabelled as signer-authenticated.

## Implementation sequence

1. Define the JSON Schema, canonical payload encoder, domain-separation constant and strict trusted-surveyor registry parser.
2. Implement deterministic sign/verify functions with exact record bytes, manifest hash and checkpoint context. Keep private keys local to the operator signing process.
3. Add a bounded operator-local CLI to create detached sidecars without emitting key material or altering the original observation records.
4. Extend workspace intake, review-package schema/building and offline verification with one-to-one attestation binding.
5. Add adversarial tests for wrong/unknown/revoked/expired keys, registry/key validity windows, duplicate/forked rotation lineage, non-canonical base64, changed record bytes, manifest/checkpoint substitution, missing/extra/orphaned sidecars, and legacy compatibility.
6. Integrate focused tests into Full CI; update operator documentation and the remaining-work roadmap.
7. Validate using ephemeral synthetic keys only. Production key provisioning and a real surveyor-signed record remain external blockers.

## Trust boundaries

A valid signature establishes that the private key corresponding to one currently active operator-provisioned public key signed the exact attribution statement. It does **not** prove civil identity, professional qualification, employment, legal authority, receiver hardware authenticity, direct receiver origin, data-use rights, CRS/frame/epoch correctness, measurement accuracy, or physical checkpoint-to-GLB correspondence.

A surveyor signature is not a manufacturer/device signature. The platform must not claim hardware authenticity unless an independently verified device-signature protocol and trust chain are separately supplied. Raw record bytes remain opaque; do not parse or reinterpret receiver formats in this increment.

All release flags remain false: `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval`. No map publication or branch promotion is authorized by D3M-16.
