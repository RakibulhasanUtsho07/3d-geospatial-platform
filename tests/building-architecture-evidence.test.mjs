import assert from "node:assert/strict";
import test from "node:test";

import {
  OVERTURE_BUILDINGS_SCHEMA_VERSION,
  auditBuildingPartComposition,
  resolveBuildingArchitectureEvidence,
  summarizeBuildingArchitectureEvidence,
} from "../src/core/buildings/building-architecture-evidence.mjs";

test("preserves valid Overture facade and roof fields without claiming geometry was generated", () => {
  const evidence = resolveBuildingArchitectureEvidence({
    type: "building",
    has_parts: false,
    facade_color: "#ABC",
    facade_material: "brick",
    roof_color: "#223344",
    roof_material: "roof_tiles",
    roof_shape: "gabled",
    roof_direction: 89.5,
    roof_orientation: "along",
    roof_height: 3.25,
  });

  assert.equal(OVERTURE_BUILDINGS_SCHEMA_VERSION, "2.0.0");
  assert.equal(evidence.sourceSchema, "overture-buildings-2.0.0");
  assert.deepEqual(evidence.featureType, { status: "source", value: "building" });
  assert.deepEqual(evidence.hasParts, { status: "source", value: false });
  assert.equal(evidence.compositionStatus, "parent-reports-no-associated-parts");
  assert.deepEqual(evidence.facade.color, { status: "source", value: "#aabbcc" });
  assert.deepEqual(evidence.facade.material, { status: "source", value: "brick" });
  assert.deepEqual(evidence.roof.color, { status: "source", value: "#223344" });
  assert.deepEqual(evidence.roof.material, { status: "source", value: "roof_tiles" });
  assert.deepEqual(evidence.roof.shape, { status: "source", value: "gabled" });
  assert.deepEqual(evidence.roof.directionDegrees, { status: "source", value: 89.5 });
  assert.deepEqual(evidence.roof.orientation, { status: "source", value: "along" });
  assert.deepEqual(evidence.roof.heightMeters, { status: "source", value: 3.25 });
  assert.equal(
    evidence.roof.geometryStatus,
    "source-roof-shape-and-positive-height-present-geometry-not-yet-generated",
  );
  assert.equal(
    evidence.facade.status,
    "source-facade-style-metadata-present-geometry-not-yet-generated",
  );
  assert.equal(evidence.geometryCompleteness, "footprint-extrusion-only");
  assert.equal(evidence.verificationStatus, "source-metadata-validated-not-human-verified");
});

test("distinguishes parent-declared building parts from a complete assembled model", () => {
  const parent = resolveBuildingArchitectureEvidence({ type: "building", has_parts: true });
  const part = resolveBuildingArchitectureEvidence({
    type: "building_part",
    building_id: "parent-123",
    roof_shape: "flat",
  });

  assert.equal(parent.compositionStatus, "parent-declares-associated-parts");
  assert.equal(part.compositionStatus, "building-part-parent-join-required");
  assert.deepEqual(part.buildingId, { status: "source", value: "parent-123" });
  assert.equal(part.geometryCompleteness, "footprint-extrusion-only");
  assert.notEqual(part.compositionStatus, "assembled-complete-building");
});

test("keeps missing architecture metadata explicitly absent and does not infer roof or facade details", () => {
  const evidence = resolveBuildingArchitectureEvidence({ class: "residential" });

  assert.deepEqual(evidence.facade.color, { status: "absent", value: null });
  assert.deepEqual(evidence.facade.material, { status: "absent", value: null });
  assert.deepEqual(evidence.roof.shape, { status: "absent", value: null });
  assert.deepEqual(evidence.roof.material, { status: "absent", value: null });
  assert.deepEqual(evidence.roof.heightMeters, { status: "absent", value: null });
  assert.equal(evidence.facade.status, "facade-style-not-sourced");
  assert.equal(evidence.roof.geometryStatus, "roof-shape-not-sourced");
  assert.equal(evidence.compositionStatus, "feature-type-unknown");
});

test("rejects schema-invalid enum, color and numeric roof values without coercion", () => {
  const evidence = resolveBuildingArchitectureEvidence({
    type: "Building",
    has_parts: "true",
    facade_color: "brick-red",
    facade_material: "masonry",
    roof_color: "#12",
    roof_material: "asphalt",
    roof_shape: "conical",
    roof_direction: "90",
    roof_orientation: "north",
    roof_height: "4",
  });

  assert.deepEqual(evidence.featureType, { status: "invalid", value: null });
  assert.deepEqual(evidence.hasParts, { status: "invalid", value: null });
  assert.deepEqual(evidence.facade.color, { status: "invalid", value: null });
  assert.deepEqual(evidence.facade.material, { status: "invalid", value: null });
  assert.deepEqual(evidence.roof.color, { status: "invalid", value: null });
  assert.deepEqual(evidence.roof.material, { status: "invalid", value: null });
  assert.deepEqual(evidence.roof.shape, { status: "invalid", value: null });
  assert.deepEqual(evidence.roof.directionDegrees, { status: "invalid", value: null });
  assert.deepEqual(evidence.roof.orientation, { status: "invalid", value: null });
  assert.deepEqual(evidence.roof.heightMeters, { status: "invalid", value: null });
  assert.equal(evidence.roof.geometryStatus, "invalid-roof-metadata");
  assert.equal(evidence.facade.status, "invalid-facade-metadata");
});

test("enforces roof direction range while preserving finite roof_height values as supplied", () => {
  for (const direction of [-0.1, 360]) {
    const evidence = resolveBuildingArchitectureEvidence({ roof_direction: direction });
    assert.equal(evidence.roof.directionDegrees.status, "invalid");
  }

  const zeroRoof = resolveBuildingArchitectureEvidence({
    roof_shape: "flat",
    roof_height: 0,
  });
  assert.deepEqual(zeroRoof.roof.heightMeters, { status: "source", value: 0 });
  assert.equal(zeroRoof.roof.geometryStatus, "source-roof-height-nonpositive-geometry-not-renderable");

  const negativeRoof = resolveBuildingArchitectureEvidence({ roof_height: -1 });
  assert.deepEqual(negativeRoof.roof.heightMeters, { status: "source", value: -1 });

  const nonNumericRoof = resolveBuildingArchitectureEvidence({ roof_height: "4" });
  assert.deepEqual(nonNumericRoof.roof.heightMeters, { status: "invalid", value: null });

  const nonFiniteRoof = resolveBuildingArchitectureEvidence({ roof_height: Infinity });
  assert.deepEqual(nonFiniteRoof.roof.heightMeters, { status: "invalid", value: null });
});

test("does not coerce enum casing or whitespace and requires string parent IDs", () => {
  const evidence = resolveBuildingArchitectureEvidence({
    type: "Building",
    facade_material: " brick",
    roof_shape: "GABLED",
    building_id: 42,
  });
  assert.deepEqual(evidence.featureType, { status: "invalid", value: null });
  assert.deepEqual(evidence.facade.material, { status: "invalid", value: null });
  assert.deepEqual(evidence.roof.shape, { status: "invalid", value: null });
  assert.deepEqual(evidence.buildingId, { status: "invalid", value: null });
});

test("rejects malformed feature properties and invalid parent identifiers", () => {
  assert.throws(
    () => resolveBuildingArchitectureEvidence(null),
    /must be an object/,
  );
  const evidence = resolveBuildingArchitectureEvidence({
    type: "building_part",
    building_id: "   ",
  });
  assert.equal(evidence.compositionStatus, "building-part-parent-id-missing");
  assert.deepEqual(evidence.buildingId, { status: "invalid", value: null });
});


test("resolves building_part parent references against the complete source extract and package subset", () => {
  const sourceFeatures = [
    { type: "Feature", id: "parent-a", properties: { type: "building", has_parts: true } },
    { type: "Feature", id: "part-a", properties: { type: "building_part", building_id: "parent-a" } },
    { type: "Feature", id: "parent-b", properties: { type: "building", has_parts: false } },
    { type: "Feature", id: "part-b", properties: { type: "building_part", building_id: "parent-b" } },
    { type: "Feature", id: "part-c", properties: { type: "building_part", building_id: "missing-parent" } },
    { type: "Feature", id: "part-d", properties: { type: "building_part" } },
  ];
  const audit = auditBuildingPartComposition(sourceFeatures, {
    selectedFeatureIds: new Set(["parent-a", "part-a", "part-b"]),
  });

  assert.equal(audit.summary.sourceFeatureCount, 6);
  assert.equal(audit.summary.buildingFeatureCount, 2);
  assert.equal(audit.summary.buildingPartFeatureCount, 4);
  assert.equal(audit.summary.linkedPartCount, 2);
  assert.equal(audit.summary.partStatusCounts["parent-feature-not-in-source-extract"], 1);
  assert.equal(audit.summary.partStatusCounts["missing-or-invalid-parent-id"], 1);
  assert.equal(audit.summary.parentStatusCounts["parts-found-and-declared"], 1);
  assert.equal(audit.summary.parentStatusCounts["parts-found-despite-false-has-parts-claim"], 1);

  assert.equal(audit.byFeatureId["parent-a"].associatedPartCount, 1);
  assert.equal(audit.byFeatureId["parent-a"].associatedPartsSelectedInPackageCount, 1);
  assert.equal(audit.byFeatureId["part-a"].status, "parent-feature-resolved");
  assert.equal(audit.byFeatureId["part-a"].parentSelectedInPackage, true);
  assert.equal(audit.byFeatureId["part-b"].parentSelectedInPackage, true);
  assert.equal(audit.byFeatureId["part-c"].status, "parent-feature-not-in-source-extract");
});

test("distinguishes duplicate parent IDs and parts whose parent is outside the package subset", () => {
  const sourceFeatures = [
    { type: "Feature", id: "duplicate-parent", properties: { type: "building", has_parts: true } },
    { type: "Feature", id: "duplicate-parent", properties: { type: "building", has_parts: true } },
    { type: "Feature", id: "child", properties: { type: "building_part", building_id: "duplicate-parent" } },
    { type: "Feature", id: "parent-outside", properties: { type: "building", has_parts: true } },
    { type: "Feature", id: "part-outside", properties: { type: "building_part", building_id: "parent-outside" } },
  ];
  const audit = auditBuildingPartComposition(sourceFeatures, {
    selectedFeatureIds: new Set(["part-outside"]),
  });

  assert.equal(audit.summary.duplicateParentIdCount, 1);
  assert.equal(audit.byFeatureId.child.status, "ambiguous-duplicate-parent-feature-id");
  assert.equal(audit.byFeatureId["part-outside"].status, "parent-feature-resolved");
  assert.equal(audit.byFeatureId["part-outside"].parentSelectedInPackage, false);
  assert.equal(audit.byFeatureId["part-outside"].partSelectedInPackage, true);
});

test("rejects invalid source feature arrays and package selections", () => {
  assert.throws(() => auditBuildingPartComposition(null), /source feature array/);
  assert.throws(
    () => auditBuildingPartComposition([], { selectedFeatureIds: [] }),
    /must be a Set or null/,
  );
});

test("aggregates schema-bound source coverage without converting missing fields into defaults", () => {
  const records = [
    resolveBuildingArchitectureEvidence({
      type: "building",
      has_parts: true,
      facade_material: "brick",
      roof_shape: "gabled",
      roof_height: 2.5,
    }),
    resolveBuildingArchitectureEvidence({
      type: "building_part",
      building_id: "parent-1",
      roof_shape: "flat",
    }),
  ];
  const summary = summarizeBuildingArchitectureEvidence(records);
  assert.equal(summary.schema, "overture-buildings-2.0.0");
  assert.equal(summary.tileCount, 2);
  assert.deepEqual(summary.featureTypeCounts, { building: 1, building_part: 1 });
  assert.equal(summary.compositionStatusCounts["parent-declares-associated-parts"], 1);
  assert.equal(summary.compositionStatusCounts["building-part-parent-join-required"], 1);
  assert.equal(summary.fieldAvailability["roof.shape"].source, 2);
  assert.equal(summary.fieldAvailability["roof.color"].absent, 2);
  assert.equal(summary.renderedArchitecturalDetailCount, 0);
  assert.equal(summary.geometryCompleteness, "footprint-extrusion-only");
});

test("refuses summaries with missing evidence records", () => {
  assert.throws(() => summarizeBuildingArchitectureEvidence([]), /non-empty evidence array/);
  assert.throws(() => summarizeBuildingArchitectureEvidence([{ schemaVersion: 1 }, null]), /non-empty evidence array/);
});
