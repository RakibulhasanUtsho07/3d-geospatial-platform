# D3M-ENGINE-10 — Registry-bound review-package signatures

**Tracking issue:** [#359](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/359)  
**Stack base:** D3M-ENGINE-09 PR [#358](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/358)  
**Signature contract:** `building-review-package-signature-v2.schema.json`  
**Signature envelope:** `2.0.0`

## Gap

D3M-ENGINE-09 binds the exact D3M-08 smoke/receipt/workflow/control-point evidence into the final review-package manifest. The existing detached signature primitive accepted an arbitrary separately supplied PEM public key and recorded only that key's fingerprint. It did not bind signer identity or key lifecycle to the repository's strict active reviewer registry.

## Implementation

D3M-ENGINE-10 adds a domain-separated Ed25519 envelope that signs both the exact `package-manifest.json` bytes and canonical signer context:

- `reviewerId`, `keyId`, `registryId` and public-key fingerprint;
- registry issue/expiry and active-key validity interval;
- exact manifest SHA-256 and package-manifest filename;
- purpose `package-integrity-attestation-not-release-approval`;
- canonical UTC signed-at time and `publicationEligible=false`.

Signing and verification reuse `parseTrustedReconstructionReviewerKeys` from `source-bound-authenticated-review.mjs`. No second registry parser or weaker registry schema is introduced. New signing requires a private key whose derived public-key fingerprint matches exactly one currently active registry entry for the requested reviewer. Verification resolves that same signer against the current registry and fails closed if the key is unknown, revoked, expired, not yet valid, replaced or associated with a different registry/key identity.

The strict registry JSON is read from `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON`; it is never accepted on the command line or emitted to logs. The existing 64 KiB environment registry limit is applied. The private key remains local to the signing reviewer and is never included in the registry or package.

## Commands

Configure the public-key-only registry through the approved secret manager before invoking these commands; do not paste the raw secret into a command or print it.

~~~powershell
npm run test:building-review-package-signature
npm run sign:building-review-package -- ".\\review-package" ".\\review-package-private.pem" --reviewer-id "operator-assigned-reviewer-id"
npm run verify:building-review-package-signature -- ".\\review-package" ".\\signature-verification.json"
npm run verify:signed-building-review-package -- ".\\review-package" ".\\combined-verification.json"
~~~

The combined verifier runs offline artifact/package-manifest integrity and detached signature checks and requires both to pass. It returns both detailed sub-results and exits non-zero if either fails.

Existing v1 signatures can still be verified, but only by explicitly supplying `--legacy-public-key <pem>`. New signing CLI invocations cannot silently downgrade to unregistered v1 signing.

## Tests added

- Active registry key signs/verifies exact manifest bytes and signer context.
- Wrong private key, unknown reviewer, malformed/legacy/oversized registry, revoked key, expired registry and expired active key are rejected.
- Reviewer/key/registry/fingerprint/validity/purpose metadata substitution, future timestamps, malformed/non-canonical base64, changed manifest bytes and altered signature bytes fail.
- CLI tests exercise registry-based signing/verification, combined verification, missing-registry fail-closed behavior, legacy verification explicitness, and ensure registry/private-key material is not written to output.
- The v2 JSON Schema itself is covered by a regression test.

## Trust and deployment boundary

The registry authenticates possession of the private key corresponding to an operator-provisioned public key. It does not prove civil identity, professional qualification, employment, legal authority or the correctness of a reviewer's survey. The organization must independently establish reviewer identity and authority before provisioning the registry.

A successful signature is **not** a release decision, survey certification, source-rights determination, georeference acceptance or model-accuracy result. It authenticates package-integrity evidence only. Keep `mapReady=false`, `publicationEligible=false` and `automaticApproval=false`.

No real production registry or reviewer has been provisioned as part of this code task. CI uses synthetic ephemeral keys only. The feature must pass exact-head tests, ESLint, production build and production viewport verification before it is considered software-validated.
