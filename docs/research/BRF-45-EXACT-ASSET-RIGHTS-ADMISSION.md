# BRF-45 — Exact-asset rights admission for multi-view reconstruction

**Status:** Validator, CLI, synthetic tests and a pinned 16-view admission register are implemented on the feature branch. The real sample intentionally remains blocked. A green validator test is not a grant of rights.

## Purpose

BRF-42 established that all 16 selected images could be hash-verified, privately ingested and quality-screened. Its report deliberately records the images as `usageStatus=unreviewed`, `rightsApproved=false` and `safeToSubmitToColmap=false`. That historical report must not be edited to imply permission.

BRF-45 adds an independent record for a human-reviewed, per-asset decision. Every row binds the source ID, filename, HTTPS source URL, upstream metadata commit, exact SHA-256, exact byte size and the scopes explicitly requested for private local reconstruction and validation.

## Requested scopes

The initial register requests only:

- `inspect-source`
- `use-for-validation`
- `derive-model`

It does **not** request source-byte redistribution, public display of a derived model, commercial distribution or production-map publication. Those scopes must not be inferred from public accessibility or a dataset/repository license label. They require their own explicit grant evidence if later needed.

## Evidence required for a reviewed row

An approved row must carry the rights holder/grantor and stated authority basis, license metadata, a precise scope description, attribution and restrictions, explicitly confirmed grant, unique decision identifier, reviewer identity and review timestamp, effective/expiry dates, revocation status, granted scopes, and one or more HTTPS-referenced evidence snapshots. Each evidence snapshot is locally re-hashed and must match its declared byte size and SHA-256. Symlinks and path traversal are rejected.

The validator checks completeness, exact-byte binding, source matching, required scopes, dates and integrity. It does **not** independently decide legal meaning or prove that a named grantor truly owns the rights. Human review and authority checking remain mandatory.

## Run

~~~bash
npm run test:brf45-rights-admission
npm run validate:brf45-rights-admission
~~~

The current real 16-view manifest has 16 pending rows and no acquired rights evidence snapshots. The CLI is therefore expected to exit with code 2 and report `blocked`, with zero admitted assets. That is the intended result until there is real, independently reviewed evidence.

To validate a separately prepared grant record, provide the exact source manifest and a local evidence directory that contains the declared rights snapshots:

~~~bash
node scripts/validate-brf45-exact-asset-rights-admission.mjs <rights-admission.json> \
  --source-manifest benchmarks/building-reconstruction/brf-14-multiview-source.json \
  --evidence-root <local-rights-evidence-directory> \
  --report <private-report.json>
~~~

Do not commit or upload confidential permission documents merely to make the CI job pass. CI validates synthetic grants and separately asserts that the actual unreviewed sample remains blocked.

## Integration and limits

BRF-44's final executor will bind the BRF-45 register separately into the BRF-23 preflight report and revalidate it immediately before any possible COLMAP call. A generic human-review `continue` decision, mutable media-registry status or old BRF-42 report cannot override an incomplete BRF-45 admission.

Even complete source-use permission is not independent geometry truth. All four flags—`acceptanceEligible`, `publicationEligible`, `mapReady`, and `automaticApproval`—stay false. Building identity, georeferencing, surveyed checkpoints, mesh/footprint accuracy and model publication require separate evidence and review.
