# D3M-ENGINE-23 — external monotonic governance-state provider

## Purpose

D3M-22's local state file protects routine restarts and detects corruption, but a filesystem snapshot restore can replace the file with an older valid state. D3M-23 adds a consumer-side adapter for an operator-supplied external provider whose state payload is checked against a separately maintained monotonic anchor.

## Provider API contract

Implement an object with a stable providerId and three async methods:

- readState(identity) returns null or { version, state, anchor }.
- initializeStateIfAbsent({ identity, state }) atomically creates the first state only when no state exists and returns { created, version, state, anchor }.
- compareAndSetState({ identity, expectedVersion, expectedStateSha256, nextState }) atomically verifies the current version and digest before replacing the state; it returns { updated, version, state, anchor }.

identity contains exactly the registry-set ID and independently pinned governance-key fingerprint. version is an opaque, non-empty ASCII compare-and-set token and must change after every successful write.

anchor contains exactly:
- revision: the provider's monotonic revision,
- minimumAcceptedSequence: the provider's monotonic governance floor,
- stateSha256: the digest of the complete state envelope.

The adapter rejects a response when any anchor field differs from the supplied state. This detects a restored/substituted older state document when the independent anchor has not rolled back with it.

## Provider security requirements (not implemented by this PR)

A production provider must demonstrate all of the following through independent security review and operator evidence:

1. Linearizable, atomic initialize-if-absent and compare-and-set across concurrent clients.
2. The anchor is stored separately from the state payload in a rollback-resistant facility (for example, a TPM/HSM monotonic counter or an independently administered remote monotonic/append-only service). Restoring a database or object-store snapshot must not restore the anchor.
3. Reads are authenticated and strongly consistent. Writes require authenticated client identity, least-privilege access and auditable authorization.
4. Transport uses authenticated TLS; credentials are injected by the deployment secret manager and are never logged or placed in repository files.
5. Provider identity, operator authority, key custody, failure recovery, disaster-recovery behavior and audit retention are independently reviewed.
6. Backup/restore procedures preserve the monotonic anchor or fail closed. No rollback or reset-to-bootstrap recovery path is allowed without a separately authorized ceremony and a new trust identity.

A Boolean capability flag or a successful fake-provider test is not evidence that these properties exist. The D3M-23 consumer adapter cannot prove provider durability or legal authority.

## Application wiring

The package-directory API accepts a trustRegistryGovernanceStateStore dependency created with createExternalTrustRegistryGovernanceStateStore({ provider }). It is mutually exclusive with trustRegistryGovernanceStateFilePath. The local SURVEY_TRUST_REGISTRY_GOVERNANCE_STATE_FILE path remains a development/offline fallback; it is not a substitute for the external provider.

The verifier loads the anchored state, computes the effective floor as the maximum of the configured operator floor and persisted state floor, verifies the package/signature/snapshot, and only then calls provider CAS. Any provider error, stale version, anchor mismatch or CAS failure makes integrity invalid.

## Validation

Run:

    npm run test:trust-registry-governance-external-store
    npm run test:building-review-package-integrity
    npm run lint
    npm run build

Tests use synthetic in-memory state and anchor values only. They verify adapter behavior, including old-state substitution against a newer anchor; they do not establish a production provider.

## Current status

- Provider adapter contract and package verifier dependency injection are implemented in D3M-23.
- No real remote service, TPM, HSM, secure element, credential, endpoint or provider key is provisioned.
- D3M-21 signed governance, D3M-22 local persistence and D3M-23 adapter tests do not make a package publication-eligible or map-ready.
- Ground-truth, acceptance, publication, map-ready and automatic-approval flags remain false.
