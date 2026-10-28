import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const registryUrl = new URL("../benchmarks/building-reconstruction/brf-29-rights-and-building-mapping.json", import.meta.url);
const registry = JSON.parse(await readFile(registryUrl, "utf8"));

test("BRF-29 source-rights matrix separates repository licence claims from selected assets", () => {
  assert.equal(registry.schemaVersion, "1.0.0");
  assert.equal(registry.status, "blocked");
  assert.equal(registry.buildingSelection.status, "not-selected");
  assert.equal(registry.buildingSelection.buildingId, "");
  assert.equal(registry.buildingSelection.gmlId, "");
  assert.deepEqual(registry.buildingSelection.imageAssetIds, []);
  assert.deepEqual(registry.buildingSelection.independentSurfaceAssetIds, []);
  assert.deepEqual(registry.buildingSelection.referenceModelAssetIds, []);

  const zenodo = registry.licenseEvidence.find((item) => item.id === "zenodo-tum-downtown-source-record");
  assert.ok(zenodo);
  assert.equal(zenodo.licenseName, null);
  assert.equal(zenodo.status, "license-unresolved");

  const gtLod3 = registry.licenseEvidence.find((item) => item.id === "gt-lod3-benchmark-reference-dataset");
  assert.ok(gtLod3);
  assert.equal(gtLod3.licenseName, "CC BY 4.0");
  assert.equal(gtLod3.status, "source-declared-file-not-selected");
  assert.equal(gtLod3.selectedFilePath, "");
  assert.equal(gtLod3.selectedBuildingGmlId, "");
  assert.equal(gtLod3.reviewedBy, "");
  assert.equal(gtLod3.reviewedAt, "");

  const tum2twin = registry.licenseEvidence.find((item) => item.id === "tum2twin-github-project-license");
  assert.ok(tum2twin);
  assert.equal(tum2twin.licenseName, "CC BY 4.0");
  assert.equal(tum2twin.status, "repository-license-file-verified-scope-review-pending");
  assert.equal(tum2twin.repositoryCommitSha, "e032a71fc9b3c9c3d4869e3aca9677d1234086aa");
  assert.equal(tum2twin.licenseFileSha256, "9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411");
  assert.equal(registry.catalogInventory.gmlFileCount, 27);
  assert.equal(registry.catalogInventory.snapshotPath, "benchmarks/building-reconstruction/brf-30-tum-lod3-catalog-snapshot.json");
  assert.deepEqual(registry.catalogInventory.filenamePrefixCounts, { DEBY: 27 });
  assert.equal(tum2twin.externalAssetRepositoryUrl, "https://gitlab.lrz.de/tum-gis/tum2twin-datasets");

  assert.equal(registry.sourceProvenance.selectedImagesByteVerified, false);
  assert.equal(registry.sourceProvenance.selectedUlsCropByteVerified, false);
  assert.equal(registry.sourceProvenance.selectedReferenceModelByteVerified, false);
  assert.equal(registry.sourceProvenance.fullUlsChecksumVerified, false);
  assert.equal(registry.sourceProvenance.namedVerticalDatumVerified, false);
  assert.equal(registry.sourceProvenance.localToProjectedTransformVerified, false);
  assert.equal(registry.sourceProvenance.sourceToEvaluationTransformVerified, false);
});

test("BRF-29 cannot promote any release flag while rights and building identity remain blocked", () => {
  assert.deepEqual(registry.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
  assert.ok(registry.blockers.includes("zenodo-images-license-unresolved"));
  assert.ok(registry.blockers.includes("zenodo-uls-license-unresolved"));
  assert.ok(registry.blockers.includes("building-gml-id-not-selected"));
  assert.ok(registry.blockers.includes("cross-modal-same-building-mapping-missing"));
  assert.ok(registry.blockers.includes("named-vertical-datum-unresolved"));
  assert.ok(registry.blockers.includes("platform-generated-candidate-glb-missing"));
  assert.ok(registry.blockers.includes("independent-held-out-controls-missing"));
});

test("no asset-level rights review is falsely recorded as approved", () => {
  for (const item of registry.licenseEvidence) {
    assert.notEqual(item.status, "approved");
    assert.equal(item.exactAssetSelectionStatus, "not-selected");
  }
});
