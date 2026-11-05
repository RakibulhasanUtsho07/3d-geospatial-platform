# D3M-ENGINE-22 — Persisted governance sequence state

**Tracking issue:** [#380](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/380)  
**Implementation branch:** `feat/d3m-engine22-persisted-governance-state-20261105`  
**Stack base:** D3M-ENGINE-21 PR [#379](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/379), exact starting head `105900ba490931b8b571e5ebab378afd112278c8`.

## Purpose

D3M-ENGINE-21 verifies a signed registry governance statement against an independently pinned Ed25519 public key and an operator-supplied minimum sequence. D3M-22 adds a local persisted sequence floor so routine verifier restarts cannot silently forget the highest sequence already accepted.

## Operator configuration

Keep the D3M-21 inputs:

- `SURVEY_TRUST_REGISTRY_GOVERNANCE_ATTESTATION_JSON`
- `SURVEY_TRUST_REGISTRY_GOVERNANCE_PUBLIC_KEY_PEM`
- `SURVEY_TRUST_REGISTRY_MINIMUM_SEQUENCE`

Optionally set `SURVEY_TRUST_REGISTRY_GOVERNANCE_STATE_FILE` to a private state-file path on a durable local volume. On first use, the state file is created only when the explicit D3M-21 minimum sequence is supplied. Later runs load the same registry-set/key-bound state and use the maximum of the configured floor and persisted floor.

After the offline package integrity verification succeeds, the verifier atomically records the accepted sequence, attestation digest and snapshot digest. A lower sequence, reused sequence with different statement/snapshot, stale revision, competing lock, corrupted file, identity mismatch or symlinked state path fails closed. The update uses an exclusive lock, a private file, a bounded strict envelope, hash linkage, fsync and atomic rename.

## Local-store security boundary

The local state file supports routine persistence, crash-safe writes and detection of accidental corruption. Its hash chain is not an external trust anchor. An attacker who can replace the state file or restore an older filesystem snapshot can also restore an older valid state and its digest. Therefore this local file **does not provide adversarial rollback resistance**.

For a production deployment exposed to malicious storage rollback, the state adapter must be backed by a remotely anchored compare-and-set service or a hardware monotonic counter whose revision cannot be rolled back with the application volume. Do not describe the local-file mode as equivalent to TPM/HSM/remote monotonic state. This PR defines no cloud provider, TPM driver or production remote state service.

## State identity and recovery

State is bound to the registry-set ID and SHA-256 fingerprint of the independently pinned public key. A registry-set change or key rotation requires an explicit operator-approved new state bootstrap and out-of-band trust-anchor transition; do not delete/recreate state as an automatic recovery mechanism. Preserve the prior state file and audit record for manual review.

## CI and release boundary

CI uses only temporary synthetic state files, synthetic registries and ephemeral Ed25519 keys. Never commit production state, private keys, real registry documents, enrollment evidence, raw serials or real identities.

This is governance sequence persistence only. It does not establish legal identity, key-holder authority, HSM custody, hardware authenticity, genuine field capture, firmware integrity, CRS correctness or survey/building measurement accuracy. Ground truth, acceptance, publication, map readiness and automatic approval remain false.
