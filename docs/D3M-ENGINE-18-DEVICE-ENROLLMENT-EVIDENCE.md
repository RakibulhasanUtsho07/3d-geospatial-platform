# D3M-ENGINE-18 — verify authority-signed survey-device enrollment evidence

**Tracking issue:** [#371](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/371)  
**Implementation branch:** `feat/d3m-engine18-signed-device-enrollment-evidence-20261105`  
**Stack base:** D3M-ENGINE-17 PR [#370](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/370), exact base `3cde93738045e47da1b09e453573ed6bedda61a3`.

## Purpose and scope

D3M-ENGINE-17 records `enrollmentEvidenceSha256` in its device registry, but the digest alone does not verify the document it refers to or identify who signed it. This increment adds a bounded offline verifier for an exact-byte Ed25519 enrollment statement. It checks the document against the active D3M-17 device/key entry and a separate operator-provisioned enrollment-authority public-key registry.

The authority statement binds the device ID, manufacturer/model identifiers, keyed serial commitment digest, device key ID and SPKI fingerprint, enrollment ID, authority identity/type/key/registry and validity timestamps. The document's exact SHA-256 must equal the `enrollmentEvidenceSha256` stored in the D3M-17 device registry. Signature verification uses a dedicated domain separator and canonical JSON payload.

## Trust configuration

- `trusted-survey-device-enrollment-authority-public-key-registry.schema.json` describes the separate authority registry. It contains public keys only, supports explicit revocation and a linear key-rotation chain, and is bounded to 64 KiB, 100 key-history entries and a maximum 90-day registry lifetime.
- `trusted-survey-device-public-key-registry.schema.json` remains the D3M-17 device registry and is supplied separately.
- The authority registry is an operator-managed trust anchor. Provision it from an organization-controlled secure process; do not place production registry files or private keys in Git, CI, issue comments, review packages or chat.
- `authorityType: manufacturer` is only an operator-assigned registry classification. It is not proof of a legal manufacturer's identity, certificate path, accreditation or certification.

## Offline verification

```bash
npm run verify:survey-device-enrollment-evidence -- \
  /secure/operator-managed/trusted-devices.json \
  /secure/operator-managed/trusted-enrollment-authorities.json \
  /secure/evidence/receiver-01.receiver-key-01.enrollment.json \
  --device-id receiver-01 \
  --key-id receiver-key-01
```

Optional deterministic test time:

```bash
  --now 2026-11-05T14:00:00.000Z
```

The CLI reads each input as a bounded regular file, rejects symlinks and checks file identity before/after reading. It prints only sanitized IDs, digests and validation checks. Exit codes: `0` verified, `1` evidence invalid, `2` input/CLI/runtime error.

The evidence document is expected to be canonical UTF-8 JSON no larger than 32 KiB. Its conventional evidence path is `evidence/device-enrollments/<deviceId>.<keyId>.enrollment.json`.

## What a pass proves — and does not prove

A pass proves that a key in the current operator-provisioned authority registry signed the exact enrollment statement bytes, that those bytes match the digest in the D3M-17 device registry, and that the statement matches the current device key's registered identity commitments, SPKI fingerprint and validity interval.

It does **not** independently validate a manufacturer certificate chain, legal identity or accreditation of the authority, hardware secure-element custody, physical device authenticity, firmware integrity, GNSS receiver capture, tamper-resistant sensor logs, source rights, coordinate reference frame, survey measurement quality or physical checkpoint-to-building correspondence. Those require separately documented trust roots/protocols and independent technical review.

This increment is an offline evidence verifier only. It does not yet add enrollment documents to D3M review-package schema 1.6.0 or make enrollment evidence a publication gate. All publication/map-ready/automatic-approval flags remain false; no real enrollment evidence or production trust key is included in CI.

## Validation status

Local synthetic-key tests cover exact digest binding, canonical bytes, signature tampering, device/key/identity substitution, wrong/revoked/expired authority, malformed schemas, issuance windows, CLI success and symlink rejection. These tests prove software behavior only. Exact-head GitHub Full CI is required before this PR can be considered validated.
