# D3M-ENGINE-15 — Byte-verified held-out survey observation records

## Purpose

D3M-ENGINE-14 binds each held-out checkpoint to a declared `observationRecordSha256`, but the final review package did not contain the corresponding source record bytes. D3M-ENGINE-15 closes that package hand-off gap without interpreting, rewriting or fabricating the source record.

## Deterministic workspace contract

For every schema 1.2.0 held-out checkpoint, place the original opaque record bytes at:

```text
evidence/survey-observations/<observationId>.record
```

The directory and file must be real, non-symlink paths under the private smoke workspace. The filename is derived from the manifest's validated observation ID; callers cannot supply arbitrary record paths.

Each file is read through a stable file descriptor and checked for path/file identity before and after reading. The SHA-256 must match the checkpoint's existing `observationRecordSha256`. A file must contain 1 byte–8 MiB; all records together must not exceed 64 MiB. The exact bytes are not parsed or normalized, so the package preserves the original export rather than inventing a JSON/CSV interpretation.

## Review-package hand-off

When D3M-14 held-out checkpoints are present, review-package metadata advances to schema `1.3.0` and requires:

- one `single-image-survey-observation-record` artifact per held-out observation ID;
- exact record count and aggregate byte count;
- a canonical inventory SHA-256 over sorted `observationId`, package-relative path, byte length and record SHA-256 entries.

The package builder copies the verified bytes without rewriting them. It re-reads the workspace records before finishing and rejects missing files, digest mismatches or changes during package preparation.

The offline package verifier independently reconstructs each deterministic path from the packaged control-point manifest, requires a one-to-one match with record artifacts, re-hashes the exact package bytes, enforces per-record/aggregate limits and recomputes the canonical inventory digest. Extra/orphan records, substitutions, missing artifacts and metadata drift fail verification.

## Compatibility and trust boundary

- Review-package metadata schemas `1.0.0`–`1.2.0` remain compatible and do not claim observation-record byte verification.
- Schema `1.3.0` cannot omit raw record artifacts.
- Detached package signatures cover these artifacts because the signed package manifest includes their exact paths, sizes and SHA-256 digests.
- Record contents remain opaque. No proprietary survey parser, receiver-signature verification or coordinate interpretation is introduced.

A matching hash proves only that packaged bytes equal the bytes declared by the checkpoint manifest. It does not prove surveyor identity, professional qualification, GNSS receiver authenticity, direct receiver origin, legal rights, datum correctness or physical feature correspondence. Human survey review remains mandatory. No sample/synthetic record is valid field evidence.

All release flags remain false: `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval`.
