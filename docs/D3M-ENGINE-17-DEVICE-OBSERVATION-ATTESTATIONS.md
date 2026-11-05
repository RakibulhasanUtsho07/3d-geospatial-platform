# D3M-ENGINE-17 — trusted device-key attestation for held-out survey observations

**Tracking issue:** [#369](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/issues/369)  
**Implementation branch:** \`feat/d3m-engine17-device-record-attestations-20261105\`  
**Dependency:** D3M-ENGINE-16 PR [#368](https://github.com/RakibulhasanUtsho07/3d-geospatial-platform/pull/368), exact base \`99863add8b32a70d693930afa3195d256b4b4e21\`.

## Gap

D3M-15 binds original observation bytes into review packages. D3M-16 adds a separate surveyor-key signature associating those bytes with a held-out checkpoint. A surveyor signature does not prove that a declared device key signed the same record. D3M-17 adds an independent device-key association.

## Registry and signed context

The public-key-only registry is \`trusted-survey-device-public-key-registry.schema.json\`; it is external to Git and CI and supplied only through \`SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON\`. It contains opaque device ID, manufacturer/model identifiers, a SHA-256 digest of the serial via an organization-keyed HMAC-SHA-256 commitment (never the raw serial or HMAC key), an enrollment-evidence digest, Ed25519 public key, validity/revocation and linear rotation history. Registry input is capped at 64 KiB and 100 key records; lifetime is at most 90 days.

The detached envelope uses domain separator \`3d-geospatial-platform/survey-observation-device-attestation/v1\\0\`. It binds exact observation/checkpoint/building IDs, record hash/length, exact control-point manifest hash, device/manufacturer/model identifiers, serial/enrollment digests, key fingerprint, registry/key validity and signing time. Sidecars use \`evidence/survey-observations/<observationId>.device-attestation.json\`.

## Operator workflow

Provision the device registry through the organization's approved secret manager. Never invent device identities/enrollment evidence or place production registries/private keys in Git, CI, chat or package artifacts.

\`\`\`bash
export SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON="$(< /secure/operator-managed/trusted-devices.json)"
npm run sign:survey-observation-device-attestation -- \\
  <private-smoke-workspace> <job-id> <device-private-key.pem> \\
  --device-id <registered-device-id>
unset SURVEY_OBSERVATION_TRUSTED_DEVICES_JSON
\`\`\`

The CLI requires a verified D3M-14 smoke, exact manifest and 6–100 held-out records. It verifies every original record hash, writes each sidecar once, self-verifies and rereads the source evidence. Private keys remain local.

## Package hand-off

When both D3M-16 surveyor and D3M-17 device registries are supplied, the review-package builder emits schema 1.5.0 and one device-attestation artifact per held-out observation. Offline verification checks both signatures against exact record/manifest/checkpoint bytes and the complete inventories. Schemas 1.0.0–1.4.0 remain legacy and are not silently upgraded. Existing device sidecars without the registry must fail closed.

## Trust boundary

A valid device-key attestation proves that the private key corresponding to one currently active external registry entry signed the exact declared record/checkpoint statement. The enrollment-evidence digest references external evidence; it is not an automatically validated manufacturer certificate. This software does not prove civil identity, manufacturer certification, secure-element custody, firmware integrity, genuine receiver capture, direct receiver origin, data rights, CRS/frame/epoch correctness, measurement accuracy or physical checkpoint-to-GLB correspondence. Those require an independent enrollment authority, hardware protocol and human/technical review. All release flags remain false; no map publication is authorized.
