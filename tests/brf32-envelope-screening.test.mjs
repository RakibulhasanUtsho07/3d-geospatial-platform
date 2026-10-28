import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = new URL("../benchmarks/building-reconstruction/brf-31-citygml-envelope-screening.json", import.meta.url);
const report = JSON.parse(await readFile(source, "utf8"));

test("BRF-32 persisted metadata matches the pinned bounded CityGML probe", () => {
  assert.equal(report.source.commit, "e032a71fc9b3c9c3d4869e3aca9677d1234086aa");
  assert.equal(report.probePolicy.modelsProbed, 27);
  assert.equal(report.probePolicy.maxPrefixBytesPerModel, 131072);
  assert.equal(report.models.length, 27);
  assert.equal(report.summary.completeEnvelopesFound, 27);
  assert.deepEqual(report.summary.srsNameCounts, { "EPSG:25832": 27 });
  assert.equal(report.summary.overlappingBroadUlsBounds, 27);
  assert.equal(report.summary.containsGuidePointXY, 1);
  assert.equal(report.summary.containsGuidePointXYZ, 1);
  assert.equal(report.summary.earlyBuildingIdsHaveLod2SameSuffix, 26);
  assert.equal(report.summary.candidateInvestigationLead, "DEBY_LOD3_4959457.gml");
});

test("BRF-32 candidate lead is not promoted to selected identity or verified accuracy", () => {
  const candidate = report.models.find((item) => item.filename === report.summary.candidateInvestigationLead);
  assert.ok(candidate);
  assert.equal(candidate.containsGuidePointXYZ, true);
  assert.equal(candidate.earlyBuildingGmlIds[0], "DEBY_LOD2_4959457");
  assert.equal(candidate.sameBuildingVerified, false);
  assert.equal(candidate.assetRightsReviewed, false);
  assert.equal(candidate.coordinateTransformApplied, false);
  assert.equal(report.buildingSelection.status, "not-selected");
  assert.equal(report.buildingSelection.buildingId, "");
  assert.equal(report.buildingSelection.gmlId, "");
  assert.equal(report.summary.verticalWarning.interpretedAsAccuracyError, false);
  assert.equal(report.probePolicy.fullGmlPayloadDownloaded, false);
  assert.equal(report.probePolicy.fullObjectHashVerified, false);
});

test("BRF-32 never enables release flags from coarse metadata screening", () => {
  assert.deepEqual(report.releaseFlags, {
    acceptanceEligible: false,
    publicationEligible: false,
    mapReady: false,
    automaticApproval: false,
  });
  for (const item of report.models) {
    assert.equal(item.fullFileDownloaded, false);
    assert.equal(item.fullObjectHashVerified, false);
    assert.equal(item.coordinateTransformApplied, false);
    assert.equal(item.sameBuildingVerified, false);
    assert.equal(item.assetRightsReviewed, false);
    assert.equal(item.srsName, "EPSG:25832");
    assert.equal(item.prefixBytes, 131072);
    assert.match(item.repositoryBlobId, /^[0-9a-f]{40}$/);
    assert.match(item.prefixSha256, /^[0-9a-f]{64}$/);
    assert.match(item.lfsDeclaredSha256, /^[0-9a-f]{64}$/);
    assert.ok(item.lowerCorner.length === 3 && item.upperCorner.length === 3);
  }
});
