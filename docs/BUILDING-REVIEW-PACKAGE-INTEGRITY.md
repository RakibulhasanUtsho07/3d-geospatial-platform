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
