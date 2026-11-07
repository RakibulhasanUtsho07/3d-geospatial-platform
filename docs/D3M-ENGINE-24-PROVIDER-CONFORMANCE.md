# D3M-ENGINE-24 — external governance provider conformance

## Purpose

D3M-23 defines the consumer adapter and the narrow external provider API. D3M-24 adds a reusable test harness for an implementation of that API. The goal is to make initialize-if-absent, compare-and-set, concurrent writer and ambiguous-response requirements executable before an actual remote or hardware-backed provider is selected.

This is a contract test, not a deployment, penetration test, cloud-service certification or proof of rollback-resistant physical storage.

## Run

    npm run test:trust-registry-governance-provider-conformance
    npm run test:trust-registry-governance-external-store
    npm run test:building-review-package-integrity
    npm run lint
    npm run build

Full CI runs the conformance suite on D3M-24 push and pull-request branches.

## What the reusable harness checks

`runTrustRegistryGovernanceProviderConformance({ provider, reopenProvider })` lives in `tests/helpers/trust-registry-governance-provider-conformance.mjs`. It uses a fresh registry-set identity containing a random UUID and a derived public-key fingerprint. It never targets a configured production registry identity. The required `reopenProvider()` callback must construct a fresh client against the same isolated backend; a provider-specific integration can implement it across an actual process boundary.

The suite requires the provider to implement:

- `readState(identity)`
- `initializeStateIfAbsent({ identity, state })`
- `compareAndSetState({ identity, expectedVersion, expectedStateSha256, nextState })`

The test verifies:

1. Eight concurrent initialize-if-absent requests produce exactly one creator and one identical state/version/anchor visible to every caller.
2. Eight writers using one expected version and state digest produce exactly one successful CAS. Every losing caller observes the winner's state and anchor.
3. A stale version cannot overwrite the winner.
4. A fresh read returns the exact committed state and anchor.
5. A simulated response loss after commit is recovered by reading and comparing the exact state digest; the client does not blindly replay the transition with a new version.
6. State and independent anchor fields agree exactly for revision, minimum accepted sequence and SHA-256 digest, including after a successful compare-and-set (a stale/rolled-back anchor is rejected).
7. Every successful compare-and-set advances the opaque provider version token, and no historical token may be reused (ABA); a provider that reports success with a repeated token is rejected.

The synthetic negative fixtures prove that the harness detects check-then-write races in initialize-if-absent, competing CAS writers that all pass the same precondition before any commit, version-token non-advancement, historical version-token reuse (ABA), and initial or post-write mismatched/rolled-back anchors. The race fixtures use an eight-party barrier so every contender observes the same pre-commit condition before any broken writer is allowed to commit; this validates that the harness detects these implementation defects, but is not itself a distributed-systems or real-provider test. The synthetic `reopenProvider` fixture returns a distinct client object over the same in-memory closure; it does not simulate a process restart or prove persistence after host failure.

## Integrating a real provider

A provider-specific integration suite should call the same reusable harness with a dedicated, isolated test namespace. Provision that namespace outside production identity and remove it only through an explicit provider-specific cleanup procedure. Do not run destructive conformance tests against a live governance registry.

Before production consideration, additionally collect independent evidence for:

- linearizable conditional writes and read-after-write consistency across regions/replicas;
- anchor storage physically/logically independent of the state document, with snapshot/restore and operator-level rollback testing;
- durable monotonic revision/floor behavior under backup restore, failover, region loss and disaster recovery;
- authenticated transport, workload identity, least-privilege access, key rotation, secret custody and audit retention;
- provider outage, timeout, throttling, network partition and ambiguous commit behavior;
- operational recovery, alerting, backup/restore and documented ownership.

The harness checks only the API behavior exposed to the consumer. It cannot establish that an anchor is truly independent, that the provider's backing store is linearizable, or that its operators cannot roll back both values together. A real provider must be exercised in its actual deployment environment and independently reviewed.

## Current status and trust boundary

- D3M-24's Full CI and unit tests use a deterministic in-memory synthetic provider.
- No cloud provider, remote endpoint, production credential, TPM/HSM monotonic counter or real independent anchor is provisioned.
- CI success establishes only that the implemented checks passed on the exact tested commit.
- The D3M-24 branch remains stacked on D3M-23 PR #383. Keep the stack Draft/open/unmerged until separately reviewed.
- Ground-truth, acceptance, publication, map-ready and automatic-approval flags remain false.
