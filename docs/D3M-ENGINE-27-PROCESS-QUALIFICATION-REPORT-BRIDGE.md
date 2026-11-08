# D3M-ENGINE-27 — process-isolated provider qualification report bridge

## Purpose

D3M-26 introduced a runner that executes every provider operation in a fresh Node child process and emits a sanitized, source-bound report. D3M-25 independently validates hash/byte-count-bound provider qualification artifacts. Before this increment, the D3M-25 evaluator treated a `process-restart-report` as opaque bytes: a report could have a correct file hash but describe a different source commit, provider, adapter, instance, namespace or process execution.

D3M-27 closes that semantic evidence gap. It validates the D3M-26 report before the linked artifact can count as byte-verified process-restart evidence.

This remains an evidence-integrity bridge, not a remote-provider implementation, an independent auditor, or production approval.

## Report schema 1.1.0

Schema: `trust-registry-governance-provider-process-report.schema.json`.

Validator: `src/core/building-generation/trust-registry-governance-provider-process-report.mjs`.

The report binds:

- the exact 40-character source commit;
- provider ID and exact adapter entry-file SHA-256;
- the adapter's `syntheticOnly` declaration (metadata only, not trusted proof);
- SHA-256 fingerprints of the provider instance and isolated namespace;
- fresh Node child-process execution mode, process isolation assertion, number of worker operations, unique worker-instance count and observed OS process-ID count;
- exact D3M-24 initialize/CAS one-winner outcomes, stale-write rejection, fresh-client restart visibility, ambiguous commit recovery, safe pre-commit timeout retry, competing-writer detection and identity isolation.

The report deliberately excludes adapter filesystem paths, provider endpoints, environment values, credentials, tokens, tenant identifiers and secret material. Use only privacy-safe one-way instance and namespace fingerprints.

For synthetic-only fixtures, the instance and namespace fingerprints may be null. For a non-synthetic adapter, the CLI requires both fingerprints and rejects missing/malformed values. This declaration does not authenticate an operator or prove the underlying service is real.

## Run

The local synthetic CI fixture may be exercised without deployment fingerprints:

```bash
npm run test:trust-registry-governance-provider-process-conformance
npm run test:trust-registry-governance-provider-process-report
node scripts/run-trust-registry-governance-provider-process-conformance.mjs --help
```

A provisioned non-synthetic provider must supply the same privacy-safe fingerprints that will be recorded in the D3M-25 qualification manifest:

```bash
node scripts/run-trust-registry-governance-provider-process-conformance.mjs \
  --provider-module /secure/path/provider-adapter.mjs \
  --allow-env PROVIDER_CONNECTION_STRING \
  --source-sha <40-character-source-commit> \
  --provider-instance-fingerprint-sha256 <64-character-instance-fingerprint> \
  --provider-namespace-fingerprint-sha256 <64-character-namespace-fingerprint> \
  --report artifacts/provider-process-conformance.json
```

Only environment-variable names are passed to the CLI. Secret values must already be supplied by the deployment secret manager and must never appear in command-line arguments or report files. The adapter runs with the explicitly allowlisted environment.

The CLI report is create-once. Re-running the suite must use a fresh report path. The report records the exact adapter hash and the two privacy-safe fingerprints, not source paths or endpoint data.

## D3M-25 qualification binding

Qualification manifest schema 1.1.0 adds:

- `provider.adapterModuleSha256`;
- `providerIntegration.processReportArtifactId`.

When the provider integration status is `passed`, that ID must reference one present `process-restart-report` artifact. The exact same artifact ID must appear in `evidence.processRestartVisibility.artifactIds`.
The artifact's `sourceUrl` must also equal the exact `providerIntegration.runUrl`, so a report file from another workflow run cannot be substituted even when its content and hash otherwise match.

The D3M-25 artifact verifier performs both checks:

1. Verify that the report file is a regular, non-symlink file within the configured artifact root and that its exact byte count and SHA-256 match the manifest.
2. Parse bounded UTF-8 JSON and validate schema/version, source commit, provider ID, adapter hash, synthetic declaration, provider instance/namespace fingerprints, execution mode, process counts and all required D3M-24 conformance outcomes against the qualification manifest.

A report with a valid hash but mismatched semantic claims is not added to the verified-artifact set. Diagnostics are bounded and do not reveal absolute paths or report contents.

Schema 1.0.0 manifests remain parseable for backward compatibility. However, a legacy manifest claiming a passed provider integration cannot reach `ready-for-independent-review` because it lacks the D3M-27 process-report binding. Schema 1.1.0 requires the explicit report link.

## Tests and CI

Run:

```bash
npm run test:trust-registry-governance-provider-process-conformance
npm run test:trust-registry-governance-provider-process-report
npm run test:trust-registry-governance-provider-qualification
npm run lint
npm run build
```

Full CI includes the bridge test on the D3M-27 push and pull-request branch filters. The qualification regression suite checks that the current unprovisioned-provider manifest remains blocked and every release flag remains false.

## Security boundary

- A correctly hashed report proves byte identity, not the truth of its claims or the identity of its author.
- A report is not a signed attestation; source/provider/fingerprint matching and structural checks reduce substitution risk but do not replace independent audit or a trusted report-signing identity.
- Process IDs and worker-instance nonces are evidence that the runner used separate child invocations in the measured run; they do not prove provider storage durability.
- The synthetic file-backed provider stores its state and anchor together and cannot prove independent anchor custody or resistance to hostile snapshot rollback.
- No remote provider, endpoint, credential, TPM/HSM counter, independently administered anchor or real provider-integration run is provisioned by D3M-27.
- D3M-25 remains blocked until a real provider integration and all required independently verified evidence classes exist.
- Production qualification, acceptance, publication, map-ready and automatic-approval flags remain false.

D3M-27 does not merge or promote D3M-26 or any parent branch.
