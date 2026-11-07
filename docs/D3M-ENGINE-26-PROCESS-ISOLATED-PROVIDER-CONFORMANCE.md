# D3M-ENGINE-26 — process-isolated external provider conformance

## Purpose

D3M-24's reusable provider harness accepts a \`reopenProvider()\` callback, but a new JavaScript client object does not prove that the provider survives an OS process exit. D3M-25 requires evidence of state, provider-version and independent-anchor visibility across a genuine process restart.

D3M-26 adds a process-isolated adapter runner. Every provider API operation is executed by a newly spawned Node.js child process. The provider backend must therefore preserve state across process termination and independent client construction; concurrent initialization and CAS contenders run in distinct processes.

## Adapter contract

The operator supplies a trusted ESM module with:

\`\`\`js
export const syntheticOnly = false; // declaration only; not independent proof
export async function createProvider() {
  return {
    providerId: "operator-provider-id",
    async readState(identity) { /* return null or { version, state, anchor } */ },
    async initializeStateIfAbsent({ identity, state }) {
      /* return { created, version, state, anchor } */
    },
    async compareAndSetState({ identity, expectedVersion, expectedStateSha256, nextState }) {
      /* return { updated, version, state, anchor } */
    },
  };
}
\`\`\`

The runner imports the module from an explicit local file path. It checks that the entry file is a regular, non-symlink file, hashes the exact bytes, and verifies the same hash again inside each worker before import. Only the exported \`createProvider()\` factory is accepted.

## Run

\`\`\`bash
node scripts/run-trust-registry-governance-provider-process-conformance.mjs --help

node scripts/run-trust-registry-governance-provider-process-conformance.mjs \
  --provider-module /secure/path/provider-adapter.mjs \
  --allow-env PROVIDER_CONNECTION_STRING \
  --allow-env PROVIDER_CLIENT_CERT_PATH \
  --source-sha <40-character-commit-sha> \
  --report artifacts/provider-process-conformance.json
\`\`\`

The named environment variables must already be present in the runner environment. Only explicitly allowlisted values are inherited by provider workers, in addition to a small runtime baseline. Never put credentials or secret values in command-line arguments. The report is created once and refuses overwrite; it contains the adapter entry-file SHA-256 and provider ID, but no adapter path, endpoint, environment values or secret data.

Each operation has a bounded JSON request/response, a configurable worker timeout, an output-size limit and forced child cleanup on timeout/overflow. Worker stderr and arbitrary adapter stdout are not forwarded to the caller. Worker errors expose only a bounded error code, never the provider exception message.

## CI fixture and tests

CI uses \`tests/fixtures/trust-registry-governance-file-backed-provider.mjs\`. It stores test records in a temporary file and uses an inter-process lock plus atomic rename. It is intentionally declared synthetic. The full D3M-24 suite is executed through this fixture with each provider operation in a separate Node process. Tests also cover symlinked/invalid adapters, timeout cleanup, output limits, unsafe environment injection and secret-free error reporting.

## Security boundary

- This proves the tested software and adapter behavior across actual child-process boundaries. It does not certify a cloud provider or prove a provider operator's controls.
- The CI fixture stores the state and anchor in one local file. It is not an independently administered monotonic anchor, rollback-resistant hardware counter or production service.
- \`syntheticOnly\` is adapter metadata, not a trusted assertion. The module SHA binds the entry module bytes only; it does not attest its dependencies, deployment, identity, custody or endpoint.
- A real provider still needs a dedicated non-production namespace, independent anchor, real credentials and workload identity, authenticated TLS, least privilege, key custody/rotation, backup/restore and rollback challenge, audit retention, operational recovery, and independent security review.
- The D3M-25 qualification evaluator remains the final evidence gate. A successful process-isolated suite alone must never set production qualification, acceptance, publication, map-ready or automatic-approval flags.

No remote provider, credential, production endpoint, TPM/HSM counter or independently controlled anchor is provisioned by this increment.


## Exact-head CI validation — 2026-11-07

Implementation code SHA `28b5005c6bd46e7886ac5175469bfd63b32033e1` passed both Push Full CI [#42341553023](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/42341553023) and PR Full CI [#42341558156](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/42341558156). Each run completed successfully with 229/229 successful job steps and no failures or cancellations. The production viewport verification and six existing evidence uploads passed too.

The result is process-isolated **software validation only** using the synthetic file-backed fixture. It is not a real external provider deployment or evidence of independently protected anchor custody. No release or production qualification flag is enabled.
