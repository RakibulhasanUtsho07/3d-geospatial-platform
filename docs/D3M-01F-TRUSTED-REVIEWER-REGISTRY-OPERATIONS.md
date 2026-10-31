# D3M-01.F — Trusted reviewer registry operations

**Status:** implementation in stacked Draft PR #290; real production provisioning is not complete.  
**Issue:** [#289](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/289)  
**Code PR:** [#290](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/290)  
**Schema:** \`building-generation-trusted-reviewer-registry.schema.json\`

## Purpose and trust boundary

The D3M-01.D/E review flow verifies Ed25519 signatures against the server-controlled \`RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON\` value. The registry is an allow-list of **public keys only**. A successful signature establishes possession of the private key corresponding to a currently trusted reviewer key; it does not prove civil identity, employment, professional qualification, legal authority, source rights, survey accuracy or model correctness.

Reviewer identity and authority must be established outside this software by the organization that operates the platform. The repository must not invent reviewer identities or contain private signing keys, identity documents, personal contact data or production credentials.

## Production registry contract

Production (\`NODE_ENV=production\`) accepts only the versioned registry envelope defined by the JSON Schema. The legacy array form containing only \`reviewerId\` and \`publicKeyPem\` is for local development and tests; production rejects it.

The registry envelope contains:
- \`schemaVersion\` and \`recordType\`: explicit contract identity;
- \`registryId\`: operator-assigned stable identifier;
- \`issuedAtUtc\` and \`expiresAtUtc\`: canonical UTC timestamps with milliseconds and a trailing \`Z\`;
- \`entries\`: bounded key lifecycle records.

Each entry contains \`reviewerId\`, globally unique \`keyId\`, \`status\` (\`active\` or \`revoked\`), Ed25519 \`publicKeyPem\`, \`validFromUtc\`, \`validUntilUtc\`, \`revokedAtUtc\` and nullable \`replacesKeyId\`.

Runtime checks enforce a maximum 90-day registry lifetime, registry validity at the current server time, key validity windows, public-key-only PEM, unique key IDs and SHA-256 fingerprints, and at most one active key for a reviewer. Active key validity cannot extend beyond registry expiry. A replacement must point to an earlier revoked key belonging to the same reviewer, and its activation cannot precede that key's revocation.

Revoked entries remain in the operator-maintained registry for audit, but only currently active keys are passed to signature verification. An all-revoked registry is a valid emergency lockout: it yields zero verifier keys, so signing and verification fail closed. A signature's \`reviewedAtUtc\` must also fall inside that key's validity window.

## Operator lifecycle

### Reviewer onboarding

1. The organization independently verifies the person's identity, role and authority; keep those records in the organization's approved identity/governance system, not in this repository.
2. Assign an opaque stable \`reviewerId\` and a unique \`keyId\` through the operator's change-control process.
3. The reviewer generates an Ed25519 key pair in an approved secure environment and retains the private key. The private key must never be sent to the platform operator, committed to Git, placed in CI variables or included in an API request.
4. Obtain and verify only the public-key PEM through the organization's approved onboarding channel. Check the algorithm and fingerprint out of band.
5. Add an \`active\` entry with an explicit validity interval and publish the complete registry atomically through the deployment secret manager.

### Key rotation

1. Generate and verify the successor public key with the reviewer.
2. In one registry revision, change the old entry to \`revoked\`, set \`revokedAtUtc\`, add a new \`active\` entry with a new globally unique \`keyId\`, and set \`replacesKeyId\` to the old key ID.
3. Set the new key's \`validFromUtc\` no earlier than the revocation time. Ensure exactly one active key remains for that reviewer.
4. Atomically replace the runtime secret and verify the deployment revision without printing the secret.

Because D3M-01.E deliberately re-verifies receipts against the current registry, revoking/replacing a key makes old receipts signed by that key fail current authorization. Re-review affected candidates with the replacement key before independent geometry evaluation is resumed. Do not work around this by retaining a revoked key as active.

### Emergency revocation

Revoke a compromised or lost key immediately in the deployment registry and publish the update. If it is the only trusted key, an all-revoked registry locks out all reviewer signing and receipt verification until a replacement is safely onboarded. Keep the revoked record and change-control evidence. Never silently delete a compromised key record or reuse its key ID.

### Registry renewal

Renew before \`expiresAtUtc\`. Issue a new registry with a new \`issuedAtUtc\` and expiry no more than 90 days later. Revalidate every active reviewer/key, maintain the same public-key fingerprint where no rotation is required, and ensure active key validity does not outlive the new registry expiry. If renewal is missed, the expired registry is rejected and review authorization stops.

## Deployment-secret handling

- Store the entire JSON registry only in the production deployment platform's secret manager as \`RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON\`.
- Set \`NODE_ENV=production\` in the production runtime so the strict envelope is required.
- Do not commit a production registry to this repository, add it to \`.env.example\`, place it in workflow output, upload it as an artifact, or paste it into issue/PR comments.
- Restrict secret read/write permission to designated deployment operators; require approval and audit logging for onboarding, rotation, revocation and renewal.
- Deploy the registry atomically with rollback to the last approved, non-revoked version only. A rollback must never restore a key that has been compromised or revoked.
- Verify deployments using non-secret metadata (registry ID, active key IDs and public-key fingerprints) through a controlled administrative process. Do not print raw PEM or the full environment variable in logs.

## Fail-closed behavior and evidence

Malformed JSON/schema, unknown fields, invalid timestamps, expired registry, future registry, invalid/expired/not-yet-valid key, duplicate IDs/fingerprints, multiple active keys for one reviewer and invalid rotation lineage are rejected. An unknown, revoked or expired reviewer key cannot authorize a review.

Dedicated tests cover positive registry parsing, legacy-production rejection, validity bounds, revocation, rotation lineage, duplicate keys, malformed/private-key material, all-revoked emergency lockout, and review timestamps outside the key validity period. The full CI suite must pass on the exact PR head before the contract can be considered software-validated.

## Not yet provisioned / not proven

No real reviewer or identity has been onboarded; no production secret has been created or verified; no private signing key has been received (nor should it be); no production deployment operator has confirmed configuration. CI fixtures use ephemeral synthetic keys only. All geometry, truth, held-out accuracy, acceptance, publication, map-ready, automatic approval and dispatch flags remain false.


## Secret-safe deployment preflight diagnostics (D3M-01.G)

The read-only `scripts/validate-trusted-reviewer-registry.mjs` command validates the registry already injected into the process environment. It never accepts registry JSON as a command-line argument and never prints registry JSON, PEM values, reviewer personal details or parser exception text.

### Bash

Run this inside the deployment environment after the secret manager has injected the variable:

```bash
NODE_ENV=production npm run validate:trusted-reviewer-registry
```

### PowerShell

```powershell
$env:NODE_ENV = "production"
npm run validate:trusted-reviewer-registry
```

Do not paste the secret into a command, shell history, issue, PR, CI variable output or terminal echo. Configure it only through the approved deployment secret manager.

The command reports the registry ID, schema version, issue/expiry timestamps, active/revoked record counts, active key IDs, public-key SHA-256 fingerprints and key validity windows. It intentionally omits reviewer IDs and all PEM material.

Exit codes:
- `0`: versioned registry is valid and has at least one active reviewer key.
- `2`: missing secret, non-production mode, malformed/oversized data, legacy format or invalid registry.
- `3`: registry is structurally valid but all keys are revoked; this is an emergency lockout, not signing readiness.

The input is capped at 64 KiB to keep environment-based deployment configuration within common process-environment limits. This is only a configuration preflight; it does not verify the live deployment has loaded the same revision after restart, prove reviewer identity/authority, or authorize any building. Deployment operators must separately verify their release revision and onboarding records without exposing the secret.
