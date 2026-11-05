# D3M-ENGINE-20 — Exact external trust-registry snapshot binding

**Tracking issue:** [#376](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/376)  
**Implementation branch:** `feat/d3m-engine20-exact-trust-registry-snapshot-binding-20261105`  
**Stack base:** D3M-ENGINE-19 PR [#374](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/374), exact starting head `b5f5f86f7efa6a3e31e3a8aad8a6281d3542ace1`.

## Problem closed

D3M-16/17/18 review-package verification already uses three external public-key-only registries. Before this increment, package metadata recorded their registry IDs and signature/evidence inventory, but not the exact raw registry document bytes used for the package review. An operator could reuse a registry ID with changed JSON content and the package would not itself say which exact trust-document bytes were used during verification.

## Schema 1.7.0 contract

When the complete D3M-16/17/18 evidence set is present and all three external registries are supplied and valid, single-image package metadata uses schema `1.7.0`.

It carries exactly three ordered trust snapshot entries:

| Role | Registry record type | Environment variable |
|---|---|---|
| `surveyor` | `trusted-surveyor-public-key-registry` | `SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON` |
| `device` | `trusted-survey-device-public-key-registry` | `SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON` |
| `enrollment-authority` | `trusted-survey-device-enrollment-authority-public-key-registry` | `SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON` |

Each entry contains only:
- role and exact expected record type;
- registry ID and registry schema version;
- SHA-256 and byte length of the exact raw UTF-8 JSON string supplied to the builder.

The enclosing metadata contains snapshot schema version, count (exactly 3), total raw bytes, canonical inventory SHA-256 and the three entries. Registry documents, public-key PEM values, private keys, raw identifiers, and enrollment documents are **not copied** into the snapshot inventory.

The schema is defined by [`trust-registry-snapshot-inventory.schema.json`](../trust-registry-snapshot-inventory.schema.json). The implementation is in [`trust-registry-snapshot.mjs`](../src/core/building-generation/trust-registry-snapshot.mjs).

## Exact-byte behavior

The builder hashes `Buffer.from(rawRegistryString, "utf8")` before parsing/re-serializing it. The byte count uses that same buffer. A whitespace-only change, line-ending change, or other UTF-8 byte change therefore produces a different snapshot SHA-256, even when JSON parsing produces an equivalent object and registry ID.

Limits:
- each registry snapshot: 1–64 KiB;
- all three snapshots combined: at most 192 KiB;
- exactly three roles, one occurrence per role;
- registry IDs must be syntactically safe and distinct across the three roles;
- each role must match its exact record type and schema version;
- unknown, missing, extra, reordered, duplicate or malformed inventory entries fail closed.

The snapshot registry IDs must also equal the registry IDs independently bound by the verified D3M-16 surveyor attestations, D3M-17 device attestations and D3M-18 enrollment-authority evidence.

## Package preparation and offline verification

The package builder already receives the three registry strings from the operator environment. When D3M-18 enrollment evidence is verified, it builds the raw-byte snapshot inventory and emits schema 1.7.0.

The offline directory verifier receives the same three external registry strings through the same environment variables. It independently:
1. re-verifies D3M-16 surveyor attribution signatures;
2. re-verifies D3M-17 device-key attestations;
3. re-verifies D3M-18 device-level enrollment evidence;
4. hashes the exact supplied registry strings again;
5. validates role/type/schema/registry IDs, byte sizes, per-registry hashes and canonical inventory digest;
6. cross-checks snapshot registry IDs against the registry IDs used by the individual evidence verifiers.

Missing or non-string registry inputs, malformed or oversized JSON, a changed raw-byte string (even with the same registry ID and same JSON meaning), role/type substitution, duplicate registry IDs, missing/extra/reordered/tampered entries, stale byte counts, forged digests or mismatched attestation registry IDs invalidate schema 1.7.0.

The registry documents remain outside the package. Keep them in the approved operator secret manager; do not commit them, paste them into GitHub issues/PRs/chat or make them CI secrets. CI uses synthetic registries and ephemeral keys only.

## Operator workflow

Set the three registry values from the approved secret manager into the process environment before package preparation:

```bash
# Append a sentinel before command substitution ends so trailing newlines in each
# registry file are preserved in the environment value and its exact-byte digest.
raw="$(cat /secure/operator-managed/trusted-surveyors.json; printf .)"
export SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON="${raw%.}"
raw="$(cat /secure/operator-managed/trusted-devices.json; printf .)"
export SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON="${raw%.}"
raw="$(cat /secure/operator-managed/trusted-enrollment-authorities.json; printf .)"
export SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON="${raw%.}"
unset raw

# Build the review package. With D3M-16/17/18 sidecars and device enrollment evidence,
# the builder verifies all evidence and records the exact raw trust-registry snapshots.
npm run package:building-review -- \
  <candidate.glb> <render-directory> <reference-image-directory> \
  <render-reference-review-report.json> <correction-tasks.json> \
  <correction-verification.json> <accuracy-evidence.json> \
  <release-readiness-report.json> <new-output-directory> \
  --single-image-smoke-workspace <private-smoke-workspace> \
  --single-image-smoke-job-id <job-id>

# Offline verification must use the current operator-approved registry bytes.
npm run verify:building-review-package -- <review-package-directory> [integrity-report.json]

unset SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON
unset SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON
unset SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON
```

For a schema 1.7.0 package, the recipient must have the exact registry JSON byte strings used during package preparation. If a registry is reissued with any raw-byte change, the old package fails current registry-snapshot verification; the package must be re-evaluated against the exact intended trust snapshot, not silently relabelled.

## Compatibility

- Schemas `1.0.0`–`1.6.0` retain their original behavior. They are not retroactively labelled snapshot-bound.
- Schema `1.6.0` continues to verify D3M-17 device attestations and one D3M-18 enrollment statement per distinct device identity; no snapshot inventory is required.
- Schema `1.7.0` requires all three external registry strings and the full exact-byte snapshot inventory. No automatic downgrade is allowed when the new inventory is missing or invalid.

## Trust boundary and non-goals

The snapshot proves which exact registry bytes were supplied to the verifier. It does not independently prove who authored those bytes, whether the operator's registry provisioning was lawful, who controls a listed private key, legal manufacturer identity, secure-element custody, firmware integrity, genuine receiver capture, CRS correctness or measurement accuracy. Those remain external trust-provisioning and human-review responsibilities.

All release flags remain false: `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval`. D3M-20 does not authorize publication or branch promotion.
