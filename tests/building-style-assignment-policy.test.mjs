import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  areBuildingVisualStylesEqual,
  indexBuildingStyleAssignments,
  isValidBuildingStyleAssignment,
  resolveBuildingStyleBaseline,
  resolvePreviewGeometryStyle,
  shouldReapplyBuildingStyle,
  shouldRenderDetailedForBuildingStyle,
} from "../src/core/map-engine/building-style-assignment-policy.mjs";

const baseline = {
  id: "baseline",
  facadeColor: "#d9cbb9",
  roofColor: "#978a7e",
  accentColor: "#b78967",
  pattern: "urban-grid",
  roofDetail: "none",
  repeatWidthMeters: 6,
};
const saved = { ...baseline, id: "saved", reportedFloorCount: 6 };
const assignment = (featureId, style = saved) => ({
  featureId,
  referenceId: "ref-1",
  referenceTitle: "Reference",
  sourceUrl: "https://example.test/ref",
  usageStatus: "reviewed",
  assignedAt: "2026-01-01T00:00:00.000Z",
  style,
});

test("assignment validation rejects empty IDs and malformed core colors", () => {
  assert.equal(isValidBuildingStyleAssignment(assignment("building-1")), true);
  assert.equal(isValidBuildingStyleAssignment(null), false);
  assert.equal(isValidBuildingStyleAssignment(assignment("  ")), false);
  assert.equal(isValidBuildingStyleAssignment(assignment("building-1", {
    ...saved,
    facadeColor: "red",
  })), false);
  assert.equal(isValidBuildingStyleAssignment(assignment("building-1", {
    ...saved,
    roofColor: "#123",
  })), false);
  assert.equal(isValidBuildingStyleAssignment(assignment("building-1", {
    ...saved,
    accentColor: null,
  })), false);
});

test("assignment indexing ignores invalid entries and preserves last valid exact-key assignment", () => {
  const later = { ...saved, id: "later" };
  const indexed = indexBuildingStyleAssignments([
    assignment("building-1"),
    assignment(" ", saved),
    assignment("building-1", later),
    assignment(" building-1 "),
  ]);

  assert.equal(indexed.size, 2);
  assert.equal(indexed.get("building-1")?.style.id, "later");
  assert.equal(indexed.has("building-1 "), true);
  assert.equal(resolveBuildingStyleBaseline(undefined, baseline), baseline);
  assert.equal(resolveBuildingStyleBaseline(indexed.get("building-1"), baseline), later);
});

test("style equality retains stable adapter semantics and detects baseline changes", () => {
  assert.equal(areBuildingVisualStylesEqual(baseline, { ...baseline }), true);
  assert.equal(areBuildingVisualStylesEqual(baseline, saved), false);
  assert.equal(shouldReapplyBuildingStyle({
    baselineChanged: false,
    previewWasActive: false,
    heightChanged: false,
  }), false);
  for (const key of ["baselineChanged", "previewWasActive", "heightChanged"]) {
    assert.equal(shouldReapplyBuildingStyle({
      baselineChanged: key === "baselineChanged",
      previewWasActive: key === "previewWasActive",
      heightChanged: key === "heightChanged",
    }), true);
  }
});

test("preview changes geometry only when it explicitly supplies height or floor count", () => {
  const patternOnly = { ...baseline, pattern: "balcony" };
  const heightPreview = { ...patternOnly, reportedHeightMeters: 24 };
  const floorPreview = { ...patternOnly, reportedFloorCount: 8 };

  assert.equal(resolvePreviewGeometryStyle(null, baseline), baseline);
  assert.equal(resolvePreviewGeometryStyle(patternOnly, baseline), baseline);
  assert.equal(resolvePreviewGeometryStyle(heightPreview, baseline), heightPreview);
  assert.equal(resolvePreviewGeometryStyle(floorPreview, baseline), floorPreview);
});

test("saved style updates preserve detail for the selected or already detailed building", () => {
  assert.equal(shouldRenderDetailedForBuildingStyle({ isSelected: true, isDetailed: false }), true);
  assert.equal(shouldRenderDetailedForBuildingStyle({ isSelected: false, isDetailed: true }), true);
  assert.equal(shouldRenderDetailedForBuildingStyle({ isSelected: false, isDetailed: false }), false);
});

test("CesiumAdapter delegates assignment and preview decisions to the tested policy", async () => {
  const adapter = await readFile(new URL("../src/core/map-engine/cesium-adapter.ts", import.meta.url), "utf8");
  assert.match(adapter, /indexBuildingStyleAssignments\(assignments\)/);
  assert.match(adapter, /resolveBuildingStyleBaseline\(assignment, record\.sourceVisualStyle\)/);
  assert.match(adapter, /areBuildingVisualStylesEqual\(/);
  assert.match(adapter, /shouldReapplyBuildingStyle\(/);
  assert.match(adapter, /resolvePreviewGeometryStyle\(style, record\.baseVisualStyle\)/);
  assert.match(adapter, /shouldRenderDetailedForBuildingStyle\(/);
});
