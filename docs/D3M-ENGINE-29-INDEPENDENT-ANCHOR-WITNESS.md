# D3M-29 — independent-anchor challenge–response witness

## Purpose and trust boundary

D3M-23 through D3M-28 establish the external monotonic-state provider contract, concurrency/process conformance, exact source/provider report binding and trusted reviewer signature. Those controls still do not establish that the state anchor is independently operated or that a reported state was freshly observed for this exact provider deployment.

D3M-29 adds a fresh 256-bit challenge and a detached Ed25519 witness receipt. The receipt binds the exact challenge bytes, nonce, provider/source/adapter/deployment fingerprints, the SHA-256 of the D3M-26 process report, its final revision and minimum accepted sequence, anchor/key/registry identities, an independently pinned governance-key fingerprint, opaque provider version, positive monotonic sequence and authoritative-state digest.

A valid signature proves only that one active key in the operator-configured independent-anchor registry signed the exact challenge-bound statement. It does **not**, by itself, prove organizational independence, honest operation, physical isolation, provider-side rollback resistance or production qualification. Those facts still require out-of-band ownership validation, a real deployed anchor and independent security review.

## Components

- Challenge/verifier: `src/core/building-generation/trust-registry-governance-provider-anchor-witness.mjs`.
- Wire contract: `trust-registry-governance-provider-anchor-witness.schema.json`.
- Qualification binding: `src/core/building-generation/trust-registry-governance-provider-qualification.mjs`, D3M-25 schema 1.3.0.
- Challenge CLI: `scripts/create-trust-registry-governance-provider-anchor-challenge.mjs`.
- Verification CLI: `scripts/verify-trust-registry-governance-provider-anchor-witness.mjs`.
- Tests: `tests/trust-registry-governance-provider-anchor-witness.test.mjs` and the D3M-25 qualification integration tests.

## Preconditions

Challenge generation is refused unless all of these conditions are true:

1. The qualification manifest validates as schema 1.3.0 and has `independentAnchorWitness.status = not-run`.
2. The provider is `provisioned`, `syntheticOnly = false`, and has real provider, adapter, instance and namespace identity.
3. The separate provider integration run is `passed` and non-synthetic.
4. The operator has independently established that the anchor is administered outside the provider's trust/control boundary.

The checked-in current manifest intentionally does not satisfy these conditions. It remains `not-provisioned` / `not-run`; do not edit it to invent an endpoint, provider identity, evidence, registry or witness.

## Create and deliver a challenge

Run from the repository root after a real provider integration has been independently performed and recorded in a D3M-25 schema 1.3.0 manifest:

```bash
node scripts/create-trust-registry-governance-provider-anchor-challenge.mjs \
  path/to/provider-qualification.json \
  --output artifacts/d3m29-anchor-challenge.json \
  --ttl-seconds 300
```

The CLI uses a cryptographically random 32-byte nonce, a random challenge ID and an exact source/provider/adapter/instance/namespace context. TTL is bounded to 1–600 seconds (default 300). The output file is created exclusively with mode 0600; an existing file is never overwritten. The CLI does not contact the provider and does not sign anything.

Deliver the exact challenge file bytes to the independently operated anchor through the organization's authenticated out-of-band channel. Do not send private keys, account/tenant identifiers, endpoints or credentials in the challenge. The anchor must read its own authoritative monotonic state after receiving the fresh nonce and return the schema-defined witness. The challenge includes the exact SHA-256 and final revision/minimum accepted sequence from the already byte-verified and D3M-28-signed process report; the anchor must sign those same values into the witness. This prevents a witness from being replayed against a different report or quietly substituting another observed provider revision.

## Witness signing contract

The witness JSON has exactly the fields defined by the schema. The Ed25519 signing payload is:

```text
UTF8("3d-geospatial-platform/d3m29-independent-anchor-witness/v1\\0")
|| UTF8(canonicalJson(witness fields excluding signatureBase64))
|| UTF8("\\0")
|| exact challenge file bytes
```

The witness must include the challenge SHA-256, challenge ID and nonce; exact source/provider/adapter and instance/namespace fingerprints; the exact D3M-26 process-report SHA-256, final revision and final minimum accepted sequence; anchor ID, key ID and public-key fingerprint; registry ID and registry-set ID; independently pinned governance-key fingerprint; provider version; monotonic sequence; authoritative-state SHA-256; and observedAtUtc.

The anchor private key stays with the independent anchor operator or its HSM. No D3M-29 script accepts, stores or emits that private key. The repository does not fabricate a witness or provide a production signer.

## Configure the independent public-key registry

Set `D3M29_INDEPENDENT_ANCHOR_KEYS_JSON` in the verifier environment to the independently provisioned, versioned, public-key-only registry. Separately set `D3M29_INDEPENDENT_ANCHOR_GOVERNANCE_KEY_FINGERPRINT_SHA256` to the 64-character SHA-256 fingerprint provisioned out-of-band for the registry governance public key. The verifier compares this independent pin to the registry envelope and witness; the registry cannot establish its own root of trust. Its exact envelope fields are:

- `schemaVersion = 1.0.0`, `recordType = d3m29-independent-anchor-key-registry`.
- `registryId`, `registrySetId`, `governancePublicKeyFingerprintSha256`, Ed25519 `governancePublicKeyPem`, canonical `issuedAtUtc` / `expiresAtUtc`, and `governanceSignatureBase64`.
- One or more entries containing `anchorId`, `keyId`, `status`, Ed25519 `publicKeyPem`, key validity times, `revokedAtUtc` and `replacesKeyId`.

The registry is limited to 64 KiB, 100 entries and a 90-day maximum registry validity. It rejects private-key material, non-Ed25519 keys, duplicate IDs/fingerprints, ambiguous active keys, invalid replacement chains, revoked/expired keys and key windows outside the registry envelope. The operator-controlled environment is the trust source for this registry; do not assume a JSON value becomes independently trusted merely because it is checked into source control.

The registry governance signature is Ed25519 over domain-separated bytes: `UTF8("3d-geospatial-platform/d3m29-independent-anchor-key-registry/v1\\0") || UTF8(canonicalJson(registry fields excluding governanceSignatureBase64)) || UTF8("\\0")`. The verifier checks that signature using the registry's public governance key, recomputes the SPKI-DER SHA-256 fingerprint, and compares it with the separately operator-pinned environment value. Challenge and witness JSON artifacts must be canonical JSON followed by exactly one newline; registry JSON may be canonical JSON with zero or one trailing newline. Registry input supplied as a string rejects duplicate-key/pretty-printed variants because its bytes must equal the canonical re-serialization. The in-memory object form is intended for trusted test harnesses; production CLI reads the operator-controlled JSON environment value as a string.

The existing `RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON` remains separately required when verifying a passed D3M-28 process report. Do not substitute the reviewer registry for the independent-anchor registry.

## Bind challenge and witness into D3M-25

For schema 1.3.0, the manifest adds:

```json
{
  "independentAnchorWitness": {
    "status": "verified",
    "challengeArtifactId": "d3m29-anchor-challenge",
    "witnessArtifactId": "d3m29-anchor-witness"
  }
}
```

The artifacts array must contain:
- a present `anchor-witness-challenge` with the exact challenge bytes;
- a present `anchor-independence-review` with the exact detached witness bytes.

Both artifact records must use the qualified source commit and the exact provider-integration workflow run URL. The `evidence.independentAnchorCustody` item must be `verified`, use `verificationKind = independent-audit`, and reference only the exact witness artifact ID. The evaluator then checks challenge and witness byte counts/SHA-256, no-follow file access, challenge freshness, provider-context equality, active key identity/validity/revocation, registry IDs/pinned governance fingerprint and Ed25519 signature over the exact challenge bytes.

Legacy manifests 1.0.0–1.2.0 remain parseable. However, a legacy manifest claiming verified independent-anchor custody is blocked because it has no D3M-29 challenge/witness binding. Schema 1.3.0 with `not-run` remains valid but blocked.

## Verify

Place the challenge and witness under the artifact root with paths recorded in the manifest, configure both public-key registries in the verifier environment, and run:

```bash
node scripts/verify-trust-registry-governance-provider-anchor-witness.mjs \
  path/to/provider-qualification.json \
  --artifact-root path/to/artifacts
```

The CLI invokes the complete D3M-25 artifact verifier. A result of `anchor-witness-verified` means the exact witness was cryptographically verified; the qualification report can still be blocked by any of the other 12 evidence classes, provider integration, signer, governance, rollback, transport, recovery or independent review requirements. Production qualification and release flags remain hard-coded false.

## Tests and CI

```bash
npm run test:trust-registry-governance-provider-anchor-witness
node scripts/create-trust-registry-governance-provider-anchor-challenge.mjs --help
node scripts/verify-trust-registry-governance-provider-anchor-witness.mjs --help
npm run test:trust-registry-governance-provider-qualification
npm run lint
npm run build
```

The test suite uses ephemeral Ed25519 keys and synthetic provider context. It covers valid fresh challenge/receipt verification, 256-bit nonce uniqueness, TTL bounds, stale challenge, provider-context substitution, exact-byte/canonical-JSON tampering, process-report digest/final-revision substitution, wrong anchor-key identity, expired/revoked keys, duplicate-key registry JSON, substituted governance trust-root pin, tampered governance-registry signature, and witness-signature tampering. The D3M-25 integration test also verifies a fresh signed witness against the exact D3M-26 report bytes and state sequence, then mutates the witness signature to assert fail-closed qualification. These are software protocol tests only.

## Current operational state

- Real external provider: not provisioned.
- Independent monotonic anchor: not provisioned.
- Production anchor public-key registry: not configured.
- D3M-29 challenge/witness: not-run.
- The D3M-25 current manifest keeps all 13 evidence classes missing.
- Production qualification, acceptance, publication, map-ready and automatic-approval remain false.
- Keep D3M-29 and its D3M-25–28 parent PR stack Draft/open/unmerged; do not retarget or promote a branch.
