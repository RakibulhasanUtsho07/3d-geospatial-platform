import assert from "node:assert/strict";
import test from "node:test";

import {
  OVERTURE_BUILDINGS_SCHEMA_VERSION,
  resolveBuildingArchitectureEvidence,
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
    "source-roof-shape-and-height-present-geometry-not-yet-generated",
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

test("rejects roof direction outside [0, 360) and non-positive roof height", () => {
  for (const properties of [
    { roof_direction: -0.1, roof_height: 2 },
    { roof_direction: 360, roof_height: 2 },
    { roof_direction: 20, roof_height: 0 },
    { roof_direction: 20, roof_height: -1 },
    { roof_direction: 20, roof_height: Infinity },
  ]) {
    const evidence = resolveBuildingArchitectureEvidence(properties);
    if (Object.hasOwn(properties, "roof_direction")) {
      assert.equal(evidence.roof.directionDegrees.status, "invalid");
    }
    if (Object.hasOwn(properties, "roof_height")) {
      assert.equal(evidence.roof.heightMeters.status, "invalid");
    }
  }
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
