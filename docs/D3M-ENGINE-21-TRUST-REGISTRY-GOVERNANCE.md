# D3M-ENGINE-21 — Signed trust-registry governance and anti-rollback

**Tracking issue:** [#378](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/378)  
**Implementation branch:** `feat/d3m-engine21-signed-trust-registry-governance-20261105`  
**Stack base:** D3M-ENGINE-20 PR [#377](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/377).

## Problem

D3M-ENGINE-20 binds the exact UTF-8 bytes, IDs, types, sizes and digests for the surveyor, device and enrollment-authority registries. That proves which registry documents were supplied. It does not prove that an independently authorized registry-governance authority approved that exact set.

## Contract

A detached Ed25519 governance attestation signs the D3M-20 inventory with a dedicated domain-separation prefix. It binds the registry-set ID, positive sequence, canonical issue/expiry timestamps, governance key ID and SPKI-DER fingerprint, plus the D3M-20 snapshot schema, count, aggregate byte length, canonical digest and ordered registry IDs. Maximum statement lifetime is 30 days.

Package preparation and offline verification read three external operator inputs:

- `SURVEY_TRUST_REGISTRY_GOVERNANCE_ATTESTATION_JSON`: detached signed statement.
- `SURVEY_TRUST_REGISTRY_GOVERNANCE_PUBLIC_KEY_PEM`: independently pinned Ed25519 public key; a key embedded in the statement is never trusted.
- `SURVEY_TRUST_REGISTRY_MINIMUM_SEQUENCE`: separately persisted positive sequence floor. A statement below this floor fails closed.

Package schema 1.8.0 stores only the statement's exact-byte SHA-256 and public metadata. The statement, registry documents and key PEM remain external. Existing schema versions 1.0.0–1.7.0 keep their previous semantics.

## Operator responsibilities

The sequence floor must be persisted and advanced outside the attestation by an independently trusted operator/deployment process. Copying a value from the supplied statement does not provide anti-rollback protection. Key rotation and recovery require out-of-band trust-anchor changes; this increment does not build a certificate chain or prove key custody.

CI uses ephemeral synthetic Ed25519 keys and synthetic registry documents only. Never put a production private key, real registry document, enrollment document, raw serial or real-world identity in Git or CI artifacts.

Passing software verification does not prove the key holder's legal identity or authority, HSM custody, manufacturer certification, physical receiver authenticity, genuine capture, firmware integrity, CRS correctness or survey/building measurement accuracy. Ground-truth, acceptance, publication, map-ready and automatic-approval flags remain false. This PR provisions no production trust key or registry.
