# D3M-ENGINE-15 — Byte-verified held-out survey observation records

## Purpose

D3M-ENGINE-14 records an `observationRecordSha256` for every held-out 3D checkpoint, but that value was only a declaration in the control-point manifest. D3M-ENGINE-15 makes the original observation bytes part of the review-package evidence and verifies that their bytes match the declaration.

This does not change the D3M-14 transform or checkpoint calculation. It closes the file-byte binding gap only.

## Workspace input contract

For every point in a schema `1.2.0` control manifest's `heldOutCheckpoints.points`, place the exact original observation record at:

```text
evidence/survey-observations/<observationId>.record
```

The filename is derived from the already-validated observation ID. The manifest cannot provide an arbitrary path. The file contents are opaque bytes: the workflow does not transcode, normalize, reserialize or interpret CSV, PDF, RINEX, NMEA, RTCM, or receiver-native files.

The bytes must hash to that checkpoint's existing `observationRecordSha256`. A missing file, hash mismatch, symbolic link, unsafe path, non-regular file, empty file, unstable read or size-limit breach blocks package preparation.

Limits:

- 6–100 checkpoint records per package;
- 16 MiB maximum per record;
- 128 MiB maximum aggregate record bytes.

The workspace reader uses a no-follow, descriptor-pinned stable read and rechecks the original bytes after the other smoke evidence is reverified.

## Review-package hand-off schema 1.3.0

The package contains one `single-image-survey-observation-record` artifact per held-out observation under `evidence/survey-observations/`. The top-level package manifest binds each relative path, byte count and SHA-256.

The `singleImageEvidence` metadata advances to `1.3.0` and carries:

- `surveyObservationRecordCount`;
- `surveyObservationRecordBytes`;
- `surveyObservationRecordsSha256`, a canonical inventory digest over sorted observation ID, package-relative path, SHA-256 and byte count.

The offline integrity verifier parses the exact packaged D3M-14 control manifest, derives each expected record path, checks one-to-one observation/artifact mapping, hashes the actual packaged bytes again, enforces per-file and aggregate limits, and recomputes the inventory digest. Missing, extra, orphaned, renamed, altered or metadata-drifted records fail the single-image evidence integrity check.

Older package metadata versions `1.0.0`, `1.1.0` and `1.2.0` remain verifiable without record artifacts. The detached package signature naturally covers the new artifact entries because they are part of the exact package-manifest bytes.

## Validation

Focused coverage exercises complete byte-backed package verification, missing records, tampered record bytes, inventory metadata drift, deterministic inventory ordering, unsafe IDs/paths and size/count limits. The same fixture also downgrades to a legacy D3M-14 `1.2.0` package to prove backward verification.

Synthetic record bytes in tests are software fixtures only; they are not GNSS observations and are not field accuracy evidence.

## Trust boundary

A matching SHA-256 proves that the package contains the exact bytes named by the manifest declaration. It does not prove who created the file, whether a receiver log or field book is authentic, whether a surveyor is qualified, whether the selected CRS/frame/epoch is correct, or whether the measured physical feature corresponds to the GLB coordinate. Hashes also do not prevent an attacker from replacing both the manifest and every file before a trusted external signature is applied.

Human review remains mandatory. Keep `groundTruth`, `acceptanceEligible`, `publicationEligible`, `mapReady` and `automaticApproval` false. No map publication or branch promotion is authorized by this increment.
