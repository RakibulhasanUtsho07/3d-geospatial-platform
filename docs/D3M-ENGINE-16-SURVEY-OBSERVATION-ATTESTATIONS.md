# D3M-ENGINE-16 — Registry-bound survey observation record attestations

**Tracking issue:** [#367](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/367)  
**Draft implementation PR:** [#368](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/368)  
**Dependency:** D3M-ENGINE-15 PR [#366](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/366), exact base `4fa635adc3db4c44903bbbc78c896216a27f8b92`  
**Implementation:** software slice implemented; exact-head Push/PR Full CI is the remaining software validation gate.  
**Production trust provisioning:** not done; requires the platform operator/organization.

## Gap after D3M-15

D3M-15 packages the original opaque observation bytes and re-hashes them against `observationRecordSha256` from the held-out checkpoint manifest. This detects byte substitution relative to the manifest. It does not establish which signing key approved the record/checkpoint association.

D3M-16 adds detached, domain-separated Ed25519 attribution signatures and an independent public-key-only trusted-surveyor registry. It does not reinterpret or rewrite the original receiver/field-book bytes.

## Implemented contract

The signed statement binds:

- exact observation ID, held-out checkpoint ID and building ID;
- SHA-256 and byte length of the original opaque observation record;
- SHA-256 of the exact packaged D3M-14 control-point manifest bytes;
- purpose, canonical UTC attestation time, and `publicationEligible: false`;
- opaque surveyor ID, key ID, registry ID, public-key fingerprint, registry issue/expiry and key validity windows.

The signed payload uses the fixed domain separator
`3d-geospatial-platform/survey-observation-attribution/v1\0`
and deterministic JSON canonicalization. Observation/checkpoint IDs preserve existing case; sidecar path generation rejects unsafe IDs, Windows reserved device names and trailing dots.

### Trusted-surveyor registry

The dedicated registry schema is [`trusted-surveyor-public-key-registry.schema.json`](../trusted-surveyor-public-key-registry.schema.json). Attestation sidecars follow [`survey-observation-attribution-attestation.schema.json`](../survey-observation-attribution-attestation.schema.json).

The registry is deliberately separate from the reconstruction reviewer registry. It accepts public keys only, is capped at 64 KiB / 100 historical key records, and enforces canonical UTC timestamps, a registry lifetime of at most 90 days, unique surveyor/key IDs and public-key fingerprints, at most one active key per surveyor, explicit revocation and one linear key-replacement chain. An all-revoked registry is an emergency lockout that authorizes no signatures.

The registry must be provisioned outside GitHub source and CI through the operator's approved secret manager as `SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON`. Never commit a production registry, store private keys in the registry/package, print the secret, or invent surveyor identities. The organization must establish identity, qualification and authority independently before trusting a surveyor ID/key.

## Review-package schema 1.4.0

When the external trusted-surveyor registry is supplied, review-package preparation requires one sidecar per held-out observation at:

```text
evidence/survey-observations/<observationId>.attestation.json
```

The original `.record` remains byte-identical. The package includes each sidecar as a `single-image-survey-observation-attestation` artifact and records the attestation count, total bytes, canonical inventory SHA-256, attribution status and registry ID in `singleImageEvidence` schema `1.4.0`.

Offline verification:

1. parses the exact packaged D3M-14 manifest and derives the required record/sidecar paths;
2. re-hashes record and sidecar bytes from the package itself;
3. verifies each signature against the supplied current trusted-surveyor registry and exact observation/checkpoint/building/manifest context;
4. checks the complete one-to-one attestation inventory;
5. rejects missing, extra, orphaned, renamed, substituted, malformed, wrong-key, revoked-key or tampered evidence.

The trusted-surveyor registry itself is not embedded in the package. The verifier receives it externally through `SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON`. A revoked key is no longer accepted by the current-registry verifier, including for older signatures.

D3M-15 schema `1.3.0` remains byte-integrity-only and backward compatible. If the registry is not supplied and no sidecars exist, preparation keeps the schema `1.3.0` path. If sidecars exist without the registry, preparation fails closed instead of silently downgrading. Legacy schemas `1.0.0`–`1.3.0` are not relabelled as signer-authenticated.

## Operator workflow

The signer CLI validates the D3M-14 runtime smoke, exact control manifest and 6–100 held-out records before creating sidecars. It reads the private key from a local regular file with no-follow/stability checks, never writes the private key to the package, creates write-once sidecars, self-verifies them, and rechecks the smoke/report/manifest/record bytes after signing.

```bash
# Load this from the approved secret manager into the process environment.
# Do not paste the registry into chat, Git, an issue, terminal output or CI logs.
export SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON="$(< /secure/operator-managed/trusted-surveyors.json)"

# Create detached sidecars for a verified D3M-14 smoke workspace.
npm run sign:survey-observation-attribution -- \
  <private-smoke-workspace> <job-id> <surveyor-private-key.pem> \
  --surveyor-id <registered-surveyor-id>

# Build the immutable review package. The builder reads the registry from the environment
# and includes schema 1.4.0 sidecars only after successful verification.
npm run package:building-review -- \
  <candidate.glb> <render-directory> <reference-image-directory> \
  <render-reference-review-report.json> <correction-tasks.json> \
  <correction-verification.json> <accuracy-evidence.json> \
  <release-readiness-report.json> <new-output-directory> \
  --single-image-smoke-workspace <private-smoke-workspace> \
  --single-image-smoke-job-id <job-id>

# Verify an existing package against the current external trusted-surveyor registry.
npm run verify:building-review-package -- <review-package-directory> [integrity-report.json]

unset SURVEY_OBSERVATION_TRUSTED_SURVEYORS_JSON
```

The registry environment variable is not a CLI argument and is not echoed by these commands. Keep the private key on the surveyor/operator-controlled signing machine; do not upload it to the platform, CI or repository. The CLI's `--help` can be checked without a registry or private key.

## Tests and validation

Added the focused `npm run test:survey-observation-attribution` suite and CI validation of the CLI help. Tests use ephemeral synthetic Ed25519 keys and cover exact record/manifest binding, context substitution, unknown/wrong/revoked/expired keys, registry expiry, all-revoked lockout, rotation lineage, duplicate IDs/fingerprints, malformed envelopes, canonical signatures, size limits and schema contracts.

The end-to-end review-package integrity fixture constructs six synthetic observations, signs each exact record/checkpoint association, builds and verifies a schema 1.4.0 package, and rejects missing sidecars, tampered sidecars, wrong signer registries and verification without the external registry. It also retains D3M-15 schema 1.3.0 legacy verification coverage. These fixtures are software tests only, never field observations.

**Current CI:** exact-head Push Full CI [#41993606995](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41993606995) and PR Full CI [#41993614343](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/41993614343) are running on `abb058b36a33e1badd89d1ee1f133922f5e019c9`. The PR run has passed ESLint, offline package integrity, D3M-16 registry/signature tests and CLI help validation; Full CI has not yet reached a terminal result.

## Trust boundaries and remaining blockers

A valid signature establishes that the private key corresponding to a currently active operator-provisioned public key signed the exact attribution statement. It does **not** prove civil identity, professional qualification, employment, legal authority, receiver hardware authenticity, direct receiver origin, data-use rights, CRS/frame/epoch correctness, measurement accuracy, or physical checkpoint-to-GLB correspondence.

A surveyor signature is not a manufacturer/device signature. Hardware authenticity requires a separate independently verified device-signature protocol and trust chain. Raw record bytes remain opaque.

No production surveyor identity/key has been onboarded and no genuine surveyor-signed field record has been supplied. Organizational identity/qualification verification and production registry deployment remain external blockers. All release flags remain false: `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval`. No map publication or branch promotion is authorized by D3M-16.
