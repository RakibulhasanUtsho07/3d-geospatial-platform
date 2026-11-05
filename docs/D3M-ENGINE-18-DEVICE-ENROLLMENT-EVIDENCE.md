# D3M-ENGINE-18 — authority-signed survey-device hardware enrollment evidence

**Tracking issue:** [#371](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/371)  
**Implementation branch:** `feat/d3m-engine18-signed-device-enrollment-evidence-20261105`  
**Stack base:** D3M-ENGINE-17 PR [#370](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/370), exact base `3cde93738045e47da1b09e453573ed6bedda61a3`.

## Purpose and the D3M-17 rotation contract

D3M-ENGINE-17 stores an `enrollmentEvidenceSha256` in each trusted-device entry and explicitly requires that digest to remain unchanged through device-key rotation. The first D3M-18 draft incorrectly bound that one immutable digest to an individual device public-key fingerprint. A new key would then require a new document digest, contradicting the D3M-17 invariant.

This implementation therefore treats enrollment as **device-level hardware-identity evidence**, not device-key enrollment. The signed statement binds device ID, manufacturer/model identifiers and the privacy-preserving keyed serial commitment. The exact statement SHA-256 must match the one stable `enrollmentEvidenceSha256` value shared by that device's D3M-17 key history. The verifier requires exactly one currently active D3M-17 key for the device, but deliberately does not sign or compare that key's fingerprint or key ID.

Device public-key possession, key validity, revocation and rotation remain independently checked by the D3M-17 registry and survey-observation device-attestation flow. A device-key rotation does not require rewriting the device-level enrollment statement.

## Trust configuration

- `trusted-survey-device-enrollment-authority-public-key-registry.schema.json` describes a separate operator-provisioned authority registry. It contains public keys only, supports explicit revocation and linear key rotation, and is bounded to 64 KiB, 100 key-history entries and a maximum 90-day registry lifetime.
- `trusted-survey-device-public-key-registry.schema.json` remains the D3M-17 device registry and is supplied separately.
- The authority registry is an operator-managed trust anchor. Provision it from an organization-controlled secure process; do not place production registry files or signing secrets in Git, CI, issue comments, review packages or chat.
- `authorityType: manufacturer` is only an operator-assigned registry classification. It is not proof of legal manufacturer identity, certificate path, accreditation or certification.

## Offline verification

```bash
npm run verify:survey-device-enrollment-evidence -- \
  /secure/operator-managed/trusted-devices.json \
  /secure/operator-managed/trusted-enrollment-authorities.json \
  /secure/evidence/receiver-01.enrollment.json \
  --device-id receiver-01
```

Optional deterministic test time:

```bash
  --now 2026-11-05T14:00:00.000Z
```

The CLI reads each input as a bounded regular file, rejects symlinks and checks file identity before/after reading. It prints only sanitized IDs, digests and validation checks. Exit codes: `0` verified, `1` evidence invalid, `2` input/CLI/runtime error.

The evidence document is canonical UTF-8 JSON no larger than 32 KiB. Its conventional path is `evidence/device-enrollments/<deviceId>.enrollment.json`.

## What a pass proves — and does not prove

A pass proves that a key in the current operator-provisioned authority registry signed the exact device-level enrollment statement bytes, that those bytes match the stable digest in the D3M-17 device registry across key rotation, and that the statement matches the current device's manufacturer/model and keyed serial commitment.

It does **not** bind or authenticate a particular device public key. D3M-17 independently verifies device-key possession and current key status/rotation. The enrollment evidence also does **not** independently validate a manufacturer certificate chain, legal identity or accreditation of the authority, hardware secure-element custody, physical device authenticity, firmware integrity, GNSS receiver capture, tamper-resistant sensor logs, source rights, coordinate reference frame, survey measurement quality or physical checkpoint-to-building correspondence.

This increment is an offline evidence verifier only. It does not yet add enrollment documents to D3M review-package schema 1.6.0 or make enrollment evidence a publication gate. All publication/map-ready/automatic-approval flags remain false; no production key or real enrollment document is included in CI.

## Validation status

Synthetic-key tests cover exact digest binding, canonical bytes, signature tampering, device/identity substitution, reuse of the same enrollment evidence after a D3M-17 device-key rotation, wrong/revoked/expired authority, malformed schemas, issuance windows, CLI success and symlink rejection. These tests prove software behavior only. Exact-head GitHub Full CI is required before this PR can be considered validated.
