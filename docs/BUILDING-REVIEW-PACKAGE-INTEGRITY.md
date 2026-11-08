# Building review package integrity

Use this command after copying a review package to another folder or machine:

\`\`\`powershell
npm run test:building-review-package-integrity
npm run verify:building-review-package -- ".\\review-package" ".\\review-package-integrity.json"
\`\`\`

The verifier enumerates actual regular files on disk, refuses symbolic links, and compares every listed artifact path, byte count and SHA-256 with \`package-manifest.json\`. It also parses JSON content digests; checks the candidate hash against the release-readiness report; re-runs geometry and texture/UV QA from the bundled GLB; checks current render image hashes/dimensions against the render manifest; and cross-links reference hashes, reviewer-reported matches, rights metadata, correction backlog, verification report and readiness report.

Statuses:

- \`verified\`: all byte-integrity and cross-reference checks passed.
- \`verified-with-warnings\`: no integrity errors, but a warning remains.
- \`tampered-or-invalid\`: at least one file, digest, provenance link, required view or policy check failed. The command exits with code 2.

An optional integrity report is written outside the package directory and will not overwrite an existing file.

## Trust boundary

This checks integrity relative to the included package manifest. The manifest is not digitally signed; if an attacker replaces both the artifacts and manifest, this verifier cannot know which copy was trusted initially. For adversarial distribution, store the manifest SHA-256 in a separate trusted system or sign the packet externally. The check never authorizes publication; \`publicationEligible\` remains \`false\`.


## Shared filesystem-safe package snapshot (D3M-ENGINE-11)

The package integrity CLI, combined signed-package verifier and v2 signing CLI use the same directory inventory implementation in `building-review-package-directory.mjs`. It:
- requires the package root and every entry to be the expected directory/regular-file type;
- rejects symlinks, special files, unsafe relative paths and path traversal;
- opens regular files with no-follow semantics where the platform supports it;
- compares descriptor and path identity, byte length, size, modification time and change time before and after each read;
- hashes the bytes actually read and uses the same snapshot format for integrity verification and signing preflight.

The new v2 signer runs the complete offline package-integrity verifier before it signs. A missing required artifact, extra file, changed hash/size, invalid rights metadata, broken cross-reference or failed recomputed GLB/texture QA prevents signature creation. Warning-only packages can still be signed for final human review when the integrity report has zero errors; warning counts are printed and do not become acceptance.

After writing the detached signature exclusively, the signer takes a second full inventory and repeats integrity verification. It requires the package snapshot token to be unchanged. If the package changes during the signing window, it removes only the signature file this process created (and only if that file identity is still unchanged), then fails.

This narrows the signing-time TOCTOU window and ensures the signer and combined verifier consume the same inventory logic. It cannot prevent a writer with filesystem access from changing package files after signing; any later modification is detected by subsequent package integrity verification. Keep package directories under controlled, non-concurrent write access while reviewers sign them.
