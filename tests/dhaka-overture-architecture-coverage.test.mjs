import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import testCase from "node:test";
import { buildDhakaOvertureArchitectureCoverage } from "../scripts/audit-dhaka-overture-architecture-coverage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts/audit-dhaka-overture-architecture-coverage.mjs");

function polygon(id, properties) {
  return {
    type: "Feature",
    id,
    properties,
    geometry: {
      type: "Polygon",
      coordinates: [[[90.4, 23.7], [90.401, 23.7], [90.401, 23.701], [90.4, 23.701], [90.4, 23.7]]],
    },
  };
}

function fixture() {
  return {
    type: "FeatureCollection",
    features: [
      polygon("parent-a", {
        _renderRole: "building_parent",
        has_parts: true,
        facade_material: "brick",
        facade_color: "#ABC",
        roof_shape: "gabled",
        roof_height: 3,
      }),
      polygon("building-a", {
        _renderRole: "building",
        has_parts: false,
        roof_shape: "flat",
        roof_height: 0,
      }),
      polygon("part-a", {
        _renderRole: "building_part",
        building_id: "parent-a",
        _parentBuildingId: "parent-a",
        roof_shape: "dome",
        roof_height: 4,
        roof_material: "glass",
      }),
    ],
  };
}

testCase("reports Overture fields separately from extractor-derived render roles", () => {
  const bytes = Buffer.from(JSON.stringify(fixture()));
  const report = buildDhakaOvertureArchitectureCoverage(fixture(), {
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    inputBytes: bytes.length,
  });

  assert.equal(report.source.featureCount, 3);
  assert.deepEqual(report.featureRoleEvidence.normalizedRoleCounts, {
    building: 1,
    building_parent: 1,
    building_part: 1,
    unknown: 0,
  });
  assert.equal(report.featureRoleEvidence.rawOvertureTypeFieldPresentCount, 0);
  assert.equal(report.fieldCoverage.byNormalizedRole.building_part.compositionRole["extractor-derived"], 1);
  assert.equal(report.fieldCoverage.byNormalizedRole.building_part.buildingId.source, 1);
  assert.equal(report.composition.linkedPartCount, 1);
  assert.equal(report.composition.partStatusCounts["parent-feature-resolved"], 1);
  assert.equal(report.architectureAvailability.facadeStyleFeatureCount, 1);
  assert.equal(report.architectureAvailability.roofShapeAndPositiveHeightFeatureCount, 2);
  assert.equal(report.architectureAvailability.renderedArchitecturalDetailCount, 0);
  assert.equal(report.architectureAvailability.geometryCompleteness, "footprint-extrusion-only");
  assert.ok(Object.values(report.releaseFlags).every((value) => value === false));
});

testCase("counts absent and invalid field states without coercion", () => {
  const source = fixture();
  source.features[0].properties.roof_height = "3m";
  source.features[2].properties.building_id = "parent a";
  source.features[2].properties._parentBuildingId = "parent a";
  const report = buildDhakaOvertureArchitectureCoverage(source);

  assert.equal(report.fieldCoverage.byNormalizedRole.building_parent.roofHeight.invalid, 1);
  assert.equal(report.fieldCoverage.byNormalizedRole.building_part.buildingId.invalid, 1);
  assert.equal(report.architectureAvailability.roofShapeAndPositiveHeightFeatureCount, 0);
  assert.equal(report.composition.partStatusCounts["missing-or-invalid-parent-id"], 1);
});

testCase("rejects malformed collections and malformed source hash/byte metadata", () => {
  assert.throws(() => buildDhakaOvertureArchitectureCoverage(null), /FeatureCollection/);
  assert.throws(() => buildDhakaOvertureArchitectureCoverage({ type: "FeatureCollection", features: [] }), /non-empty/);
  assert.throws(() => buildDhakaOvertureArchitectureCoverage(fixture(), { sourceSha256: "bad" }), /SHA-256/);
  assert.throws(() => buildDhakaOvertureArchitectureCoverage(fixture(), { inputBytes: -1 }), /inputBytes/);
});

testCase("CLI writes a deterministic, source-hash-bound report", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dhaka-architecture-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "fixture.geojson");
  const outputPath = path.join(directory, "report.json");
  const bytes = Buffer.from(JSON.stringify(fixture()) + "\n");
  await writeFile(sourcePath, bytes);

  const result = spawnSync(process.execPath, [CLI, "--source", sourcePath, "--output", outputPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(report.source.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(report.reportSha256, summary.reportSha256);
  assert.equal(summary.status, "audit-complete");
  assert.equal(summary.featureCount, 3);
});
