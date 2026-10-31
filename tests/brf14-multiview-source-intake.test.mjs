import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyBrf14MultiviewSource } from "../scripts/verify-brf14-multiview-source.mjs";

const fixturePath = new URL("../benchmarks/building-reconstruction/brf-14-multiview-source.json", import.meta.url);
const DATA_REPOSITORY_REVISION = "fde325fbd1d3636ffcf5d48aedc24cdbfc9a630f";
const sourcePrefix = "https://huggingface.co/datasets/Matt1up/drone-building-scans/resolve/" + DATA_REPOSITORY_REVISION + "/flat-roof/images/";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function makeFixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "brf14-multiview-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const assetRoot = path.join(temp, "images");
  await mkdir(assetRoot);

  const manifest = JSON.parse(await readFile(fixturePath, "utf8"));
  const payloads = [
    Buffer.from("fixture-view-alpha"),
    Buffer.from("fixture-view-bravo"),
    Buffer.from("fixture-view-charlie")
  ];
  manifest.views = manifest.views.slice(0, 3).map((sourceView, index) => {
    const filename = "fixture-view-" + (index + 1) + ".JPG";
    return {
      ...sourceView,
      id: "fixture-view-" + (index + 1),
      filename,
      localPath: filename,
      sourceUrl: sourcePrefix + filename,
      expectedByteSize: payloads[index].length,
      expectedSha256: hash(payloads[index])
    };
  });
  manifest.selectionMethod.expectedViewCount = manifest.views.length;
  manifest.expectedTotalBytes = payloads.reduce((sum, bytes) => sum + bytes.length, 0);
  manifest.maximumImageBytes = 1024;
  manifest.maximumTotalBytes = 4096;

  for (let index = 0; index < manifest.views.length; index += 1) {
    await writeFile(path.join(assetRoot, manifest.views[index].filename), payloads[index]);
  }
  return { temp, assetRoot, manifest, payloads };
}

test("verifies actual bytes for the pinned multi-view manifest and keeps release flags disabled", async (t) => {
  const { assetRoot, manifest, payloads } = await makeFixture(t);
  const report = await verifyBrf14MultiviewSource(manifest, assetRoot);

  assert.equal(report.status, "views-byte-verified");
  assert.equal(report.selectedViewCount, 3);
  assert.equal(report.actualTotalBytes, payloads.reduce((sum, bytes) => sum + bytes.length, 0));
  assert.deepEqual(report.views.map((view) => view.status), ["passed", "passed", "passed"]);
  assert.equal(report.candidateGlbGenerated, false);
  assert.equal(report.independentReferenceVerified, false);
  assert.equal(report.acceptanceEligible, false);
  assert.equal(report.publicationEligible, false);
  assert.equal(report.mapReady, false);
  assert.equal(report.automaticApproval, false);
});

test("blocks a same-size content change because actual SHA-256 no longer matches", async (t) => {
  const { assetRoot, manifest } = await makeFixture(t);
  const target = manifest.views[1];
  const filePath = path.join(assetRoot, target.filename);
  await writeFile(filePath, Buffer.from("fixture-view-BRAVO"));

  const report = await verifyBrf14MultiviewSource(manifest, assetRoot);
  assert.equal(report.status, "blocked");
  assert.equal(report.views[1].sizeMatches, true);
  assert.equal(report.views[1].hashMatches, false);
  assert.ok(report.blockers.includes(target.id));
  assert.equal(report.acceptanceEligible, false);
});

test("blocks declared byte-size mismatch without accepting the sample", async (t) => {
  const { assetRoot, manifest, payloads } = await makeFixture(t);
  manifest.views[0].expectedByteSize += 1;
  manifest.expectedTotalBytes = payloads.reduce((sum, bytes) => sum + bytes.length, 0) + 1;

  const report = await verifyBrf14MultiviewSource(manifest, assetRoot);
  assert.equal(report.status, "blocked");
  assert.equal(report.views[0].sizeMatches, false);
  assert.equal(report.views[0].status, "blocked");
  assert.equal(report.mapReady, false);
});

test("blocks missing files and symbolic-link assets", async (t) => {
  const missing = await makeFixture(t);
  await rm(path.join(missing.assetRoot, missing.manifest.views[0].filename));
  const missingReport = await verifyBrf14MultiviewSource(missing.manifest, missing.assetRoot);
  assert.equal(missingReport.status, "blocked");
  assert.equal(missingReport.views[0].status, "blocked");

  const linked = await makeFixture(t);
  const view = linked.manifest.views[1];
  const filePath = path.join(linked.assetRoot, view.filename);
  const targetPath = path.join(linked.temp, "outside-image.bin");
  await writeFile(targetPath, linked.payloads[1]);
  await rm(filePath);
  await symlink(targetPath, filePath);
  const linkedReport = await verifyBrf14MultiviewSource(linked.manifest, linked.assetRoot);
  assert.equal(linkedReport.status, "blocked");
  assert.match(linkedReport.views[1].error, /non-symlink/);
});

test("rejects malformed manifests, duplicate IDs, unpinned source URLs and false release flags", async (t) => {
  const { assetRoot, manifest } = await makeFixture(t);

  await assert.rejects(() => verifyBrf14MultiviewSource([], assetRoot), /JSON object/);

  const duplicate = structuredClone(manifest);
  duplicate.views[1].id = duplicate.views[0].id;
  await assert.rejects(() => verifyBrf14MultiviewSource(duplicate, assetRoot), /must all be unique/);

  const wrongHost = structuredClone(manifest);
  wrongHost.views[0].sourceUrl = wrongHost.views[0].sourceUrl.replace("huggingface.co", "example.com");
  await assert.rejects(() => verifyBrf14MultiviewSource(wrongHost, assetRoot), /exact URL/);

  const falseReady = structuredClone(manifest);
  falseReady.mapReady = true;
  await assert.rejects(() => verifyBrf14MultiviewSource(falseReady, assetRoot), /flags false/);
});

test("rejects mutable or mismatched Hugging Face dataset revisions", async (t) => {
  const { assetRoot, manifest } = await makeFixture(t);

  const mutable = structuredClone(manifest);
  mutable.views[0].sourceUrl = mutable.views[0].sourceUrl.replace(DATA_REPOSITORY_REVISION, "main");
  await assert.rejects(() => verifyBrf14MultiviewSource(mutable, assetRoot), /exact URL/);

  const mismatchedDeclaration = structuredClone(manifest);
  mismatchedDeclaration.dataset.dataRepositoryRevision = "a".repeat(40);
  await assert.rejects(() => verifyBrf14MultiviewSource(mismatchedDeclaration, assetRoot), /Pinned dataset identity/);

  const mismatchedAsset = structuredClone(manifest);
  mismatchedAsset.views[0].sourceUrl = mismatchedAsset.views[0].sourceUrl.replace(DATA_REPOSITORY_REVISION, "b".repeat(40));
  await assert.rejects(() => verifyBrf14MultiviewSource(mismatchedAsset, assetRoot), /exact URL/);
});

test("rejects a symlinked asset root", async (t) => {
  const { temp, assetRoot, manifest } = await makeFixture(t);
  const rootLink = path.join(temp, "linked-root");
  await symlink(assetRoot, rootLink, "dir");
  await assert.rejects(() => verifyBrf14MultiviewSource(manifest, rootLink), /asset root/i);
});
