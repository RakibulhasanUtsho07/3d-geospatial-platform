# Signed building review package manifests

Review-package integrity checks detect changes relative to the included package manifest. A detached Ed25519 signature additionally authenticates the exact manifest bytes. New package signatures use **schema 2.0.0**, which binds the signer to the current versioned trusted-reviewer registry.

## Registry-bound v2 signing

The production signer reads the public-key-only registry from the server/deployment environment variable:

`RECONSTRUCTION_TRUSTED_REVIEWER_KEYS_JSON`

Do not pass registry JSON as a command-line argument, write it to shell history, print it, commit it, or attach it to a CI artifact. Configure it only using the deployment secret manager. The registry contains public keys, not private keys or personal identity records.

The signer must retain the reviewer's Ed25519 private key in an approved local secure environment. The CLI derives its public key and requires the fingerprint to match exactly one active entry for the supplied reviewer ID in the strict versioned registry. It rejects expired or not-yet-valid registries, unknown reviewers, revoked keys, invalid key windows, ambiguous identities and key mismatch.

~~~powershell
npm run test:building-review-package-signature
npm run sign:building-review-package -- ".\\review-package" ".\\review-package-private.pem" --reviewer-id "operator-assigned-reviewer-id"
npm run verify:building-review-package-signature -- ".\\review-package" ".\\signature-verification.json"
npm run verify:signed-building-review-package -- ".\\review-package" ".\\combined-verification.json"
~~~

The signing CLI requires both the private-key path and `--reviewer-id`. New CLI signing does not fall back to an unregistered PEM key. The registry secret must already be injected by the approved runtime/secret manager.

## What schema 2.0.0 signs

The v2 Ed25519 message is domain-separated and binds:
- the exact original `package-manifest.json` bytes and SHA-256;
- fixed purpose `package-integrity-attestation-not-release-approval`;
- `reviewerId`, `keyId`, `registryId` and public-key fingerprint;
- registry issue/expiry and key validity timestamps;
- canonical UTC `signedAt` timestamp and the fail-closed publication policy.

See `building-review-package-signature-v2.schema.json` for the envelope contract. The detached signature file is written exclusively and cannot overwrite an existing signature.

Verification resolves the signer only through the currently active registry. A revoked or expired key, expired registry, changed registry identity, substituted key or modified signer context fails closed. Key rotation/revocation therefore takes effect for current verification; re-sign a package with a newly provisioned active key when required.

## Combined package verification

`verify:signed-building-review-package` runs both offline package artifact integrity verification and detached signature verification. It returns both sub-results and exits non-zero unless both pass. It never modifies the candidate or changes `mapReady`, `publicationEligible` or `automaticApproval`.

Use the separate commands when diagnosing one layer:
- `verify:building-review-package` checks packaged files and cross-references.
- `verify:building-review-package-signature` checks the detached signer envelope and trusted key.

## Legacy v1 packages

Existing schema 1.0.0 signature envelopes remain verifiable, but they do not contain registry-backed reviewer identity or key-lifecycle metadata. Verification requires an explicit legacy key path:

~~~powershell
npm run verify:building-review-package-signature -- ".\\legacy-review-package" --legacy-public-key ".\\legacy-trusted-public-key.pem"
npm run verify:signed-building-review-package -- ".\\legacy-review-package" --legacy-public-key ".\\legacy-trusted-public-key.pem"
~~~

New CLI signing never creates a v1 envelope. Migrate legacy packages by verifying their old signature through the explicit legacy path, reviewing their contents, and re-signing the exact manifest with a currently trusted reviewer key in schema 2.0.0.

## Limits

A valid v2 signature establishes possession of the private key corresponding to a currently active, operator-provisioned registry entry. It does **not** prove civil identity, professional qualification, employment, legal authority, surveyor/device authenticity, source rights, survey accuracy, model quality or architectural correctness. The signer identity/authority must be independently verified by the organization that provisions the registry.

The signature purpose is a package-integrity attestation, not a human release decision. The package remains final-human-review-only; `publicationEligible`, `mapReady` and `automaticApproval` remain `false`. The repository contains no production reviewer identities, registry secrets or private keys. CI uses synthetic ephemeral keys only.


## Signing-time artifact integrity gate (D3M-ENGINE-11)

The v2 signing CLI now takes a filesystem-safe snapshot of the entire package and runs the same offline artifact-integrity verifier used by the combined verifier **before** creating the detached signature. It refuses to sign incomplete or tampered packages, invalid reference-rights metadata, extra/missing artifacts, broken cross-references or packages whose bundled GLB geometry/texture QA no longer recomputes successfully.

The signer then writes the signature with exclusive-create semantics, inventories the package again, and requires the manifest and every artifact path/hash/byte count to match the pre-signing snapshot. If the package changed during that window, the signer removes only its own unchanged signature file and exits with an error. A warning-only integrity report can still proceed to human review when there are zero integrity errors; the CLI prints the warning count but never turns it into acceptance.

The standalone integrity verifier, combined verifier and signer now share the filesystem-safe inventory reader. It rejects symlinks and special files, unsafe paths, and file identity/size/mtime/ctime drift during reads. This is a signing-time integrity check, not a lock against later filesystem modification: keep packages under controlled write access while signing, and rerun combined verification after transfer or storage.


## Stable detached-signature verification (D3M-ENGINE-12)

The combined verifier reads `package-manifest.sig.json` using the same descriptor-pinned, no-follow stable-file reader as package artifacts. After cryptographic verification it inventories the package again and requires the manifest/artifact snapshot token to remain unchanged. It also rereads the detached envelope and requires the exact bytes and file identity to remain unchanged.

This detects package or signature mutation during verification; it is not a filesystem lock and cannot prevent later writes. Re-run verification after transfer and store review packages under controlled write access.


### Verification-time stable snapshot (D3M-ENGINE-12 hardening)

The combined verifier now reads the detached signature through the no-follow stable-file reader, with a 64 KiB envelope limit. The review-package manifest is also reread after artifact enumeration so its exact bytes and descriptor identity must remain unchanged across the inventory.

After cryptographic verification, the verifier serially takes two additional package inventories and rereads the signature envelope after each. It requires both package snapshot tokens to match the originally verified inventory and requires the detached signature bytes plus full file identity (device, inode, size, modification/change timestamps and mode) to remain identical across reads. This detects observed mutation during verification; it is not an OS-level lock and cannot prevent writes after the final read. Rerun verification after transfer or archive extraction.
