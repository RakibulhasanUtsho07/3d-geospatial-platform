# D3M-ENGINE-25 — external provider qualification evidence

## Purpose

D3M-23 defines the consumer-side external monotonic-store adapter. D3M-24 supplies reusable provider API conformance tests, but its checked-in fixture is synthetic and in-memory. D3M-25 adds an explicit evidence gate so a successful synthetic test cannot be mistaken for a real provider deployment, independently anchored storage, or production security qualification.

The evaluator is deliberately fail-closed. It can report `blocked` or `ready-for-independent-review`; it never grants production qualification, publication, map readiness, or automatic approval.

## Run

    npm run test:trust-registry-governance-provider-qualification
    npm run validate:trust-registry-governance-provider-qualification -- benchmarks/trust-registry-governance/provider-qualification-current.json

The validator accepts a manifest path, an optional `--artifact-root DIR`, and an optional write-once `--report FILE`. A structurally valid manifest may correctly return exit code 0 while its assessment remains `blocked`. Malformed metadata or an artifact path/byte/hash failure returns exit code 2.

## Evidence contract

Schema: `trust-registry-governance-provider-qualification.schema.json`.

Evaluator: `src/core/building-generation/trust-registry-governance-provider-qualification.mjs`.

The manifest binds:

- provider ID, implementation/version, staging/production environment, a one-way instance fingerprint, a one-way isolated namespace fingerprint, and an HTTPS origin only;
- the provider-specific integration run is bound to both the exact instance fingerprint and isolated namespace fingerprint, preventing evidence from a different tenant/cluster from being substituted;
- source repository, branch and full 40-character commit SHA;
- exact D3M-24 Push and PR workflow run IDs/URLs, event types, head SHAs, full-run conclusions and conformance-step conclusions;
- a separate provider-integration run against the same source SHA and the exact provisioned instance/namespace fingerprints, explicitly marked real or synthetic; it must use a distinct workflow run rather than reusing either D3M-24 synthetic conformance run;
- evidence artifacts identified by unique ID, type, project-relative path, SHA-256, byte count, HTTPS source URL and source commit;
- one evidence record for every required deployment/security property.

The provider integration evidence must come from a separate actual provider-specific integration run with a run ID different from both D3M-24 synthetic conformance workflows, and must bind the exact instance and isolated namespace fingerprints. The D3M-24 harness currently tests a synthetic in-memory provider; its successful conformance step is useful software validation but is not a real-provider integration result.

## Required evidence classes

1. Atomic initialize-if-absent and compare-and-set under concurrent writers.
2. Multi-client linearizability and exact winner visibility.
3. State/version/anchor visibility across a genuine process restart.
4. Ambiguous commit recovery, including response loss and competing writers.
5. Independent custody and rollback protection of the monotonic anchor.
6. Backup/restore, failover and snapshot rollback challenge results.
7. Authenticated workload/client identity.
8. Authenticated TLS transport configuration and verification.
9. Least-privilege authorization and separation of operator roles.
10. Key custody, rotation and revocation procedures.
11. Audit retention, integrity and access evidence.
12. Operational recovery, alerting, ownership and incident procedures.
13. An independent security-review artifact.

A capability Boolean, provider marketing statement or synthetic-only test does not satisfy an evidence class. Each `verified` record must reference a present artifact of the correct type and use `provider-test` or `independent-audit` provenance. The evaluator verifies local artifact paths, regular-file status, byte count and SHA-256. The programmatic assessment API accepts only an immutable verifier-minted result bound to the exact normalized manifest; caller-supplied artifact-ID sets are rejected, and a verification result cannot be replayed against a modified manifest. It rejects path traversal, file or parent-directory symlinks, localhost/loopback provider endpoints, query-string/fragment URLs and artifact collections above the aggregate size limit. Filesystem diagnostics are normalized so report output does not disclose absolute machine paths. The CLI also caps the manifest input at 1 MiB and records the manifest, schema, validator and report hashes. Hash verification establishes byte integrity only; it does not prove an auditor's identity, the truth of a report, or the provider's actual security properties.

## Assessment semantics

- `blocked`: provider, exact CI, real integration run, one or more evidence classes, or artifact bytes are missing/failed/synthetic/mismatched.
- `ready-for-independent-review`: all required evidence and exact-run/artifact checks are present. This is only a hand-off state for a human security review; it is not production qualification.
- `productionQualificationEligible` is always `false` in this increment.
- `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` are always `false`.

The manifest intentionally stores no credentials, access tokens, secret values, account IDs or provider tenant names. Use only privacy-safe fingerprints and an HTTPS origin; put detailed secret/tenant data in the provider's external secret manager, not the repository.

## Current checked-in state

`benchmarks/trust-registry-governance/provider-qualification-current.json` is a valid, hash-bound snapshot of the current qualification position:

- provider: not provisioned;
- D3M-24 PR Full CI: success on the exact source SHA;
- D3M-24 Push Full CI: still in progress at the snapshot time; the focused conformance step had passed;
- provider-specific integration run: not run;
- all 13 required evidence classes: missing.

The validator must therefore report `blocked`. Both D3M-24 Push Full CI [#42337017403](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/42337017403) and PR Full CI [#42337019776](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/42337019776) subsequently completed successfully on that exact SHA, with 225/225 successful steps each and the focused D3M-24 conformance step passed. Full CI asserts that this checked-in fixture remains blocked and that every release flag stays false. Update this snapshot only from fresh, exact-head workflow/provider evidence; do not infer success from stale run IDs or a synthetic fixture.

## Provider onboarding checklist

When a real provider is selected and provisioned:

1. Create a dedicated non-production namespace, separate from any live trust registry.
2. Run the D3M-24 conformance harness against the actual adapter and provider endpoint; retain the exact commit/run/artifact links.
3. Exercise real concurrent clients and a true process restart, not just a new client object over one in-memory closure.
4. Exercise provider-side snapshot restore, failover and anchor rollback with an independently controlled anchor.
5. Collect the remaining transport, identity, authorization, custody, audit and recovery evidence.
6. Hash every evidence file, bind it to the exact implementation commit, and validate the manifest.
7. Submit the bundle for independent review. No manifest field can self-approve production use.

No real provider, credential, endpoint, TPM/HSM monotonic counter or independently administered anchor is provisioned by D3M-25.