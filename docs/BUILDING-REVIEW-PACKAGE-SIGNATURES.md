# Signed building review package manifests

Integrity verification detects changes relative to an included package manifest, but an attacker who replaces both the files and that manifest can calculate new hashes. This optional Ed25519 detached signature binds the exact manifest bytes to an independently trusted public key.

## Create a key pair

Create the private key on a trusted/offline machine and keep it out of the repository and package directory:

\`\`\`sh
openssl genpkey -algorithm ED25519 -out review-package-private.pem
openssl pkey -in review-package-private.pem -pubout -out review-package-trusted-public.pem
\`\`\`

Distribute or pin \`review-package-trusted-public.pem\` through a trusted channel. The public-key fingerprint in the signature envelope is not itself a trust anchor; the verifier compares it to the key you explicitly supply.

## Sign and verify

\`\`\`powershell
npm run test:building-review-package-signature
npm run sign:building-review-package -- ".\\review-package" ".\\review-package-private.pem"
npm run verify:building-review-package-signature -- ".\\review-package" ".\\review-package-trusted-public.pem" ".\\signature-verification.json"
npm run verify:building-review-package -- ".\\review-package" ".\\integrity-report.json"
\`\`\`

Signing creates \`package-manifest.sig.json\` beside \`package-manifest.json\` and refuses to overwrite an existing signature. The signature covers the exact original manifest bytes. Verification checks the manifest hash, Ed25519 signature and fingerprint of the independently supplied trusted public key.

The normal package integrity command treats the detached signature as verification metadata, not as an unlisted model artifact. Verify the signature and package contents separately.

## Limits

The signature proves only that the exact manifest bytes were signed by the private key corresponding to the trusted public key. It does not itself prove that the references are accurate, that rights metadata is legally sufficient, or that a human approved public release. The package remains \`publicationEligible: false\`; never commit or distribute the private key with the package.
