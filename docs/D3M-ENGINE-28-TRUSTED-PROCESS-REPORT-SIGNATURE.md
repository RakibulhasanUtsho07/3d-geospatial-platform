# D3M-28 — trusted signatures for provider process reports

## Purpose

D3M-26 runs each provider operation in a fresh Node child process and emits a sanitized report. D3M-27 binds that report's bytes and semantics to the D3M-25 qualification manifest. A hash proves byte identity; it does not authenticate the report author.

D3M-28 adds a detached Ed25519 attestation. The signature covers the exact report bytes plus a domain-separated context containing the source commit, provider ID, adapter hash, synthetic declaration, provider-instance/namespace fingerprints, trusted reviewer identity and key validity metadata.

This is a report-origin authentication layer. It is not provider qualification, independent security review or release approval.

## Trusted signer requirements

- Set `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON` from the deployment's server-controlled, versioned trusted-reviewer registry. The registry contains public keys only.
- The signer must be exactly one active reviewer entry. The registry and key validity windows are checked at signing and verification time. Revoked, expired, not-yet-valid, ambiguous, malformed or legacy-array registries fail closed.
- The Ed25519 private key must remain in protected operator-controlled storage. Never put it in an issue, workflow log, command-line argument, generated report, artifact or repository file.
- The signing CLI accepts a private-key file path, not a private-key value. The public registry is read from the environment and is never echoed.
- The signature envelope contains no endpoint, tenant/account identifier, secret, private key or local filesystem path.

## Sign a D3M-26 report

The D3M-26 CLI must first produce a valid process report. Then run:

```bash
node scripts/sign-trust-registry-governance-provider-process-report.mjs \
  artifacts/provider-process-conformance.json \
  /secure/keys/reviewer-ed25519-private.pem \
  --reviewer-id <registered-reviewer-id> \
  --signature artifacts/provider-process-conformance.json.sig.json
```

The input basename must be exactly `provider-process-conformance.json`; this canonical name is included in the signed envelope. The default output is `<report-path>.sig.json` when `--signature` is omitted. Existing signature files are never overwritten; choose a new path for a new signing operation.

Limits and filesystem controls:
- report: regular non-symlink file, 1 MiB maximum;
- private key: regular non-symlink file, 16 KiB maximum;
- trusted reviewer registry: versioned, public-key-only registry, 64 KiB maximum;
- signature envelope: 64 KiB maximum;
- output: exclusive create, mode `0600`, parent directory must be a real directory and not a symlink.

The signer validates the D3M-26 report schema before signing. The detached envelope binds `processReportSha256`, source/provider/adapter and instance/namespace fingerprints, trusted reviewer/key/registry metadata and key-validity timestamps; `productionQualificationEligible` is fixed to `false`. Signing does not make a synthetic report non-synthetic.

## D3M-25 schema 1.2.0 binding

A passed provider integration must include:
- `providerIntegration.processReportArtifactId` referencing a present `process-restart-report`;
- `providerIntegration.processReportSignatureArtifactId` referencing a present `process-report-signature`;
- both artifacts must use the exact provider-integration workflow run URL and qualified source commit;
- the process report must also be referenced by `evidence.processRestartVisibility`.

The D3M-25 evaluator verifies artifact paths, byte counts and SHA-256 values, validates D3M-27 report semantics against the qualification manifest, then verifies the detached signature using the active trusted reviewer registry key. An absent registry, invalid signature, revoked key, source/provider/context mismatch or signature artifact substitution remains blocked.

Schema 1.0.0 and 1.1.0 manifests remain parseable, but a passed integration cannot become `ready-for-independent-review` without the D3M-28 signature binding.

## Tests

```bash
node --test tests/trust-registry-governance-provider-process-report-signature.test.mjs
npm run test:trust-registry-governance-provider-qualification
npm run test:trust-registry-governance-provider-process-report
npm run lint
npm run build
```

Full CI also checks the D3M-28 signer CLI help, production viewport API verification and the existing map/performance evidence uploads.

## Trust boundary and current state

- The CI signature tests use ephemeral synthetic Ed25519 keypairs and a test-only trusted registry. Those keys do not represent a production reviewer.
- The repository's current D3M-25 manifest remains not-provisioned/not-run, with all 13 evidence classes missing.
- No external monotonic provider, production credential, independent anchor, TPM/HSM counter, production reviewer key or independent security review is provisioned by D3M-28.
- A valid signature authenticates signer key identity and exact report bytes only. It does not prove the truth of provider claims or independent anchor custody.
- Production qualification, acceptance, publication, map-ready and automatic-approval remain false.


## Exact-head validation record — 2026-11-07

Implementation/test head: `19254bdc1ed29aee4c952bdd8661aba3a49ead89`.

- Push Full CI: [run #42349916912](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/42349916912) — terminal success, 232/232 steps successful.
- PR Full CI: [run #42349920655](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/actions/runs/42349920655) — terminal success, 232/232 steps successful.
- Both runs had zero failed, cancelled, skipped or incomplete steps.
- Both include successful ESLint; D3M-26 report binding; D3M-28 signer/schema/adversarial/CLI tests; D3M-25 qualification, legacy-schema compatibility and current blocked-manifest checks; production build; Chromium setup; production viewport API/browser/performance suite; and six final evidence uploads.
- Each run produced seven non-expired artifacts: generated Ahsan Manzil GLB, P2.3 camera alignment, P2.4 render performance, P2.5 repeatability, P2.6 dynamic-map workload, multi-tile viewport/Playwright diagnostics and P3.4 map-panel visual evidence.
- PR #391 remains Draft/open/unmerged and stacked on D3M-27 PR #390. No merge or branch promotion was performed.
- CI uses a synthetic provider report and ephemeral test-only signer keys. No real provider, production reviewer key, independent monotonic anchor or operational credentials were provisioned. The production qualification manifest remains blocked; all 13 evidence classes are still missing and all release flags remain false.
