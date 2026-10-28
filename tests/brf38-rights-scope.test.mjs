import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyAndValidateBrf38RightsScope } from "../src/core/building-generation/brf38-rights-scope-gate.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const EVALUATED_AT = "2026-10-28T00:00:00.000Z";
const LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const SCOPES = [
  "inspect-source",
  "derive-model",
  "public-display-derived-model",
  "commercial-use-derived-model",
];

async function addFile(root, id, kind, role, relativePath, content, source, evidenceType = null) {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  const bytes = await readFile(absolute);
  return {
    id,
    kind,
    role,
    status: "pinned",
    localPath: relativePath,
    byteSize: bytes.length,
    sha256: sha256(bytes),
    ...(source ? { source: {
      recordUrl: source.recordUrl,
      version: source.version,
      fileName: source.fileName,
      ...(evidenceType ? { evidenceType } : {}),
    } } : {}),
  };
}

function baseRights(source, evidence) {
  return {
    status: "approved",
    assetSha256: source.sha256,
    sourceFileName: source.source.fileName,
    sourceVersion: source.source.version,
    sourceRecordUrl: source.source.recordUrl,
    license: {
      identifier: "CC-BY-4.0",
      name: "Creative Commons Attribution 4.0 International",
      url: LICENSE_URL,
    },
    evidenceUrl: evidence.source.recordUrl,
    evidenceRetrievedAt: EVALUATED_AT,
    evidenceContentSha256: evidence.sha256,
    evidenceAssetIds: [evidence.id],
    rightsHolderOrGrantor: "Synthetic fixture grantor; test only",
    scopeDescription: "Synthetic fixture only; exact input asset and uses named by test.",
    attributionText: "Synthetic test attribution; not a real dataset attribution.",
    restrictionsText: "Synthetic fixture restrictions; not a real permission statement.",
    grantedScopes: [...SCOPES],
    reviewedBy: "synthetic-test-reviewer",
    reviewedAt: EVALUATED_AT,
    decisionId: "test-decision-" + source.id,
    effectiveAt: EVALUATED_AT,
    expiresAt: null,
    revoked: false,
    explicitGrantConfirmed: true,
  };
}

async function createCompleteFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "brf38-rights-"));
  const assets = [];
  const sourceSpecs = [
    {
      id: "citygml-reference",
      role: "citygml-reference",
      fileName: "reference.gml",
      path: "sources/reference.gml",
      content: "<CityModel>synthetic reference</CityModel>\n",
      requestedScopes: ["inspect-source", "use-for-validation"],
      grantedScopes: ["inspect-source", "use-for-validation"],
    },
    {
      id: "matched-images",
      role: "image-frames",
      fileName: "frames.zip",
      path: "sources/frames.zip",
      content: Buffer.from("synthetic image bytes"),
      requestedScopes: SCOPES,
      grantedScopes: SCOPES,
    },
    {
      id: "matched-uls",
      role: "uls-crop",
      fileName: "building-crop.laz",
      path: "sources/building-crop.laz",
      content: Buffer.from("synthetic point cloud bytes"),
      requestedScopes: ["inspect-source", "use-for-validation", ...SCOPES.slice(1)],
      grantedScopes: ["inspect-source", "use-for-validation", ...SCOPES.slice(1)],
    },
  ];

  for (const spec of sourceSpecs) {
    const asset = await addFile(root, spec.id, "source", spec.role, spec.path, spec.content, {
      recordUrl: "https://data.example.test/record/" + spec.id,
      version: "immutable-test-version-1",
      fileName: spec.fileName,
    });
    asset.requestedScopes = [...spec.requestedScopes];
    const evidence = await addFile(root, "evidence-" + spec.id, "rights-evidence", "rights-evidence",
      "evidence/" + spec.id + ".html",
      "<html><body>synthetic grant evidence for " + spec.id + "</body></html>\n",
      {
        recordUrl: "https://rights.example.test/evidence/" + spec.id,
        version: "snapshot-1",
        fileName: spec.id + "-rights-evidence.html",
      },
      "license-and-asset-scope-snapshot");
    asset.rights = baseRights(asset, evidence);
    asset.rights.grantedScopes = [...spec.grantedScopes];
    assets.push(asset, evidence);
  }

  const candidate = await addFile(root, "candidate-glb-artifact", "derived-output",
    "platform-reconstruction-candidate", "generated/candidate.glb",
    Buffer.from("synthetic GLB fixture; byte validation only"), null);
  assets.push(candidate);

  const manifest = {
    schemaVersion: "1.0.0",
    evaluationId: "BRF38-SYNTHETIC-COMPLETE-FIXTURE",
    evaluatedAt: EVALUATED_AT,
    assets,
    derivedOutputs: [{
      id: "platform-candidate-glb",
      status: "generated",
      artifactAssetId: candidate.id,
      parentAssetIds: ["matched-images", "matched-uls"],
      requiredParentScopes: [
        "derive-model",
        "public-display-derived-model",
        "commercial-use-derived-model",
      ],
      requestedScopes: ["public-display-derived-model", "commercial-use-derived-model"],
    }],
    releaseFlags: {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    },
  };
  return { root, manifest };
}

async function evaluate(fixture) {
  return verifyAndValidateBrf38RightsScope(fixture.manifest, fixture.root);
}

test("complete synthetic exact-asset rights evidence passes only the completeness gate", async () => {
  const fixture = await createCompleteFixture();
  try {
    const report = await evaluate(fixture);
    assert.equal(report.status, "evidence-complete-human-review-required");
    assert.equal(report.rightsScope.status, "evidence-complete-human-review-required");
    assert.equal(report.rightsScope.rightsApprovedAssetCount, 3);
    assert.equal(report.rightsScope.byteVerifiedAssetCount, fixture.manifest.assets.length);
    assert.deepEqual(report.rightsScope.blockers, []);
    assert.deepEqual(report.rightsScope.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });
    assert.equal(report.rightsScope.derivedOutputs[0].status,
      "derived-output-scope-evidence-complete-human-review-required");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the real TUM manifest remains blocked and does not infer a license", async () => {
  const manifestPath = new URL("../benchmarks/building-reconstruction/brf-38-rights-scope.json", import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const root = await mkdtemp(path.join(os.tmpdir(), "brf38-real-pending-"));
  try {
    const report = await verifyAndValidateBrf38RightsScope(manifest, root);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("rights-evidence-assets-present"));
    assert.equal(report.rightsScope.rightsApprovedAssetCount, 0);
    assert.ok(Object.values(report.rightsScope.releaseFlags).every((value) => value === false));
    assert.ok(report.rightsScope.blockers.includes("asset-tum-citygml-4959323-human-rights-review"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an SPDX/license identifier alone cannot approve an asset", async () => {
  const fixture = await createCompleteFixture();
  try {
    const image = fixture.manifest.assets.find((asset) => asset.id === "matched-images");
    image.rights.evidenceAssetIds = [];
    image.rights.evidenceUrl = null;
    image.rights.evidenceContentSha256 = null;
    image.rights.explicitGrantConfirmed = false;
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("asset-matched-images-rights-evidence-bytes"));
    assert.ok(report.rightsScope.blockers.includes("asset-matched-images-human-rights-review"));
    assert.ok(report.rightsScope.rightsApprovedAssetCount < 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rights for a different asset hash cannot be reused", async () => {
  const fixture = await createCompleteFixture();
  try {
    fixture.manifest.assets.find((asset) => asset.id === "matched-images").rights.assetSha256 = "f".repeat(64);
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("asset-matched-images-rights-bound-to-source-hash"));
    assert.ok(report.rightsScope.rightsApprovedAssetCount < 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("license permission to display a derived model does not imply source-byte redistribution", async () => {
  const fixture = await createCompleteFixture();
  try {
    const images = fixture.manifest.assets.find((asset) => asset.id === "matched-images");
    images.requestedScopes = [...images.requestedScopes, "redistribute-source"];
    images.rights.grantedScopes = [...images.rights.grantedScopes, "redistribute-derived-model"];
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("asset-matched-images-requested-scopes-granted"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing commercial derived-use scope blocks candidate output", async () => {
  const fixture = await createCompleteFixture();
  try {
    const uls = fixture.manifest.assets.find((asset) => asset.id === "matched-uls");
    uls.rights.grantedScopes = uls.rights.grantedScopes.filter((scope) => scope !== "commercial-use-derived-model");
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("asset-matched-uls-requested-scopes-granted"));
    assert.ok(report.rightsScope.blockers.includes("derived-output-platform-candidate-glb-parent-permissions"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("changed local evidence snapshot fails the actual SHA-256 verifier", async () => {
  const fixture = await createCompleteFixture();
  try {
    const evidence = fixture.manifest.assets.find((asset) => asset.id === "evidence-matched-images");
    await writeFile(path.join(fixture.root, evidence.localPath), "<html>changed evidence</html>\n");
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.byteVerification.blockers.some((blocker) => blocker.includes("evidence-matched-images")));
    assert.ok(report.rightsScope.blockers.includes("asset-matched-images-rights-evidence-bytes"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("expired grant cannot satisfy the evaluation-time use scope", async () => {
  const fixture = await createCompleteFixture();
  try {
    fixture.manifest.assets.find((asset) => asset.id === "matched-images").rights.expiresAt = "2025-12-31T23:59:59.000Z";
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("asset-matched-images-human-rights-review"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP evidence links are not accepted as exact rights evidence", async () => {
  const fixture = await createCompleteFixture();
  try {
    fixture.manifest.assets.find((asset) => asset.id === "matched-images").rights.evidenceUrl =
      "http://rights.example.test/evidence/matched-images";
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("asset-matched-images-rights-evidence-bytes"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("source rights record cannot claim another filename or source version", async () => {
  const fixture = await createCompleteFixture();
  try {
    fixture.manifest.assets.find((asset) => asset.id === "matched-uls").rights.sourceFileName = "other.laz";
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("asset-matched-uls-rights-source-match"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("missing parent provenance blocks derivative output", async () => {
  const fixture = await createCompleteFixture();
  try {
    fixture.manifest.derivedOutputs[0].parentAssetIds = ["matched-images", "nonexistent-asset"];
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("derived-output-platform-candidate-glb-parents"));
    assert.equal(report.rightsScope.derivedOutputs[0].status, "blocked");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("attempted release flag promotion is rejected and output flags remain false", async () => {
  const fixture = await createCompleteFixture();
  try {
    fixture.manifest.releaseFlags.publicationEligible = true;
    const report = await evaluate(fixture);
    assert.equal(report.status, "blocked");
    assert.ok(report.rightsScope.blockers.includes("release-flags-false"));
    assert.deepEqual(report.rightsScope.releaseFlags, {
      acceptanceEligible: false,
      publicationEligible: false,
      mapReady: false,
      automaticApproval: false,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
