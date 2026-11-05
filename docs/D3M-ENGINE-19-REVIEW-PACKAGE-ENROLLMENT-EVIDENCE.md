# D3M-ENGINE-19 — bind signed device enrollment evidence into review packages

**Tracking issue:** [#373](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/373)  
**Implementation branch:** `feat/d3m-engine19-review-package-enrollment-evidence-20261105`  
**Stack base:** D3M-ENGINE-18 PR [#372](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/372), exact base `f97d13dcd94dee73a0dacfb9a229bf27177e5ab1`.

## Purpose

D3M-ENGINE-17 (package schema 1.5.0) verifies surveyor and device signatures over each exact held-out observation. D3M-ENGINE-18 adds an offline verifier for the authority-signed enrollment statement referenced by each device registry entry. D3M-ENGINE-19 carries one copy of that evidence document for each distinct `(deviceId, keyId)` used by the package and makes the offline package verifier repeat the enrollment checks.

## Package schema 1.6.0

A package with D3M-17 device attestations and D3M-18 enrollment evidence uses `singleImageEvidence.schemaVersion = 1.6.0`. It includes:

- The existing D3M-17 record and device-attestation files (schema 1.5.0 semantics remain intact).
- Exactly one `single-image-survey-device-enrollment-evidence` artifact for each distinct device/key pair referenced by those device-attestation sidecars, at `evidence/device-enrollments/<deviceId>.<keyId>.enrollment.json`.
- Inventory count, total bytes, deterministic inventory SHA-256 and normalized entries (device/key/path/hash/size/authority identity), plus the trusted authority registry ID and `enrollment-authority-evidence-verified` status.

Duplicate pairs are deduplicated at preparation. Missing documents, extra/orphaned files, duplicate/unsafe paths, file drift, wrong device/key identity, stale D3M-17 digest, invalid authority signature, unknown/revoked/expired authority and authority-registry substitution fail closed. The package directory inventory independently rejects symlinks and non-regular files.

## Build a package

Provision the registries through the organization's secure operator process. They contain public keys only and must not be committed to Git or copied into the package.

```bash
export SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON="$(< /secure/operator-managed/trusted-surveyors.json)"
export SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON="$(< /secure/operator-managed/trusted-devices.json)"
export SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON="$(< /secure/operator-managed/trusted-enrollment-authorities.json)"

npm run package:building-review -- \
  <candidate.glb> <render-dir> <reference-dir> \
  <render-reference-review.json> <correction-tasks.json> \
  <correction-verification.json> <accuracy-evidence.json> \
  <release-readiness.json> <new-package-dir> \
  --single-image-smoke-workspace <private-smoke-workspace> \
  --single-image-smoke-job-id <job-id>

unset SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON
unset SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON
unset SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON
```

The private smoke workspace must contain one canonical enrollment evidence file at the deterministic path for every distinct device/key pair. Preparation uses bounded stable no-follow reads and rechecks the exact evidence bytes before completion.

## Offline verify

```bash
export SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON="$(< /secure/operator-managed/trusted-surveyors.json)"
export SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON="$(< /secure/operator-managed/trusted-devices.json)"
export SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON="$(< /secure/operator-managed/trusted-enrollment-authorities.json)"

npm run verify:building-review-package -- <review-package-directory>

unset SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON
unset SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON
unset SURVEY_DEVICE_ENROLLMENT_TRUSTED_AUTHORITIES_JSON
```

Offline verification independently reconstructs the unique device-key set from the packaged D3M-17 signed sidecars, locates one enrollment document for each pair, hashes the exact bytes, checks the current D3M-17 registry digest, and verifies the D3M-18 Ed25519 authority statement using the operator-provisioned authority registry. The package-manifest checksum alone is not treated as cryptographic enrollment proof.

## Compatibility and release boundary

Schemas 1.0.0–1.5.0 remain compatible and keep their previous meaning. Schema 1.5.0 is device-key-attested but is not retroactively considered enrollment-authority-verified. A schema 1.6.0 package requires both the current trusted-device registry and the separate trusted-enrollment-authority registry; missing trust configuration or attempted downgrade fails closed.

Enrollment evidence is an authenticity-association layer, not publication approval. A successful authority signature proves that an operator-trusted authority key signed the exact statement bytes matching the D3M-17 device registry. It does not prove legal manufacturer identity, certificate-chain validity, secure-element custody, hardware authenticity, firmware integrity, genuine GNSS receiver capture, source rights, CRS correctness, measurement accuracy or building correspondence. All map-ready/publication/automatic-approval flags remain false and a separate human release decision is required.

CI uses ephemeral synthetic keys only. Production registries, real enrollment documents, raw serials and private keys remain outside Git, review packages and CI.
