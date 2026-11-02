import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMapGenerationBuildingSpec,
  buildMapGenerationJobInput,
} from "../src/core/building-generation/generation-map-intake.mjs";

const baseBuilding = {
  id: "map-demo-01",
  name: "Map intake test building",
  longitude: 90.406,
  latitude: 23.709,
  heightM: 4,
  widthM: 12,
  depthM: 9,
  floorCount: 5,
  floorHeightM: 3,
  headingDegrees: 25,
};

function source(sourceId, relativePath = ".building-engine/media/b1/assets/a.jpg") {
  return {
    sourceId,
    relativePath,
    kind: "image",
    licence: "CC BY 4.0",
  };
}

test("builds a valid WGS84 polygon from metric width, depth and heading", () => {
  const spec = buildMapGenerationBuildingSpec(baseBuilding);
  assert.equal(spec.id, baseBuilding.id);
  assert.equal(spec.location.longitude, baseBuilding.longitude);
  assert.equal(spec.location.latitude, baseBuilding.latitude);
  assert.equal(spec.dimensions.floorCount, 5);
  assert.equal(spec.footprint.type, "Polygon");
  assert.equal(spec.footprint.coordinates[0].length, 5);
  assert.ok(Math.abs(spec.footprint.areaM2 - 108) < 0.5);
  assert.match(spec.evidence[0].notes, /not surveyed geometry/);
});

test("rejects invalid identity, WGS84 coordinates and metric dimensions", () => {
  assert.throws(() => buildMapGenerationBuildingSpec({ ...baseBuilding, id: "../outside" }), /safe identifier/);
  assert.throws(() => buildMapGenerationBuildingSpec({ ...baseBuilding, longitude: 181 }), /Longitude/);
  assert.throws(() => buildMapGenerationBuildingSpec({ ...baseBuilding, latitude: 86 }), /Latitude/);
  assert.throws(() => buildMapGenerationBuildingSpec({ ...baseBuilding, widthM: 0.5 }), /Footprint width/);
  assert.throws(() => buildMapGenerationBuildingSpec({ ...baseBuilding, floorCount: 2.5 }), /integer/);
});

test("builds a procedural job while making source rights confirmation explicit", () => {
  const buildingSpec = buildMapGenerationBuildingSpec(baseBuilding);
  const request = buildMapGenerationJobInput({
    buildingSpec,
    strategy: "procedural",
    uploadedSources: [source("front-photo")],
    confirmRights: true,
  });
  assert.equal(request.strategy, "procedural");
  assert.equal(request.sources[0].relativePath, ".building-engine/media/b1/assets/a.jpg");
  assert.equal(request.confirmRights, true);
  assert.equal("viewSourceIds" in request, false);
});

test("requires exactly one selected view and opt-in for single-image inference", () => {
  const buildingSpec = buildMapGenerationBuildingSpec(baseBuilding);
  const uploadedSources = [source("front-photo"), source("side-photo", ".building-engine/media/b1/assets/b.jpg")];
  assert.throws(() => buildMapGenerationJobInput({
    buildingSpec, strategy: "single-image-ai", uploadedSources, confirmRights: true,
    selectedViewSourceIds: ["front-photo"], confirmSingleViewInference: false,
  }), /explicit single-view inference/);
  assert.throws(() => buildMapGenerationJobInput({
    buildingSpec, strategy: "single-image-ai", uploadedSources, confirmRights: true,
    selectedViewSourceIds: ["front-photo", "side-photo"], confirmSingleViewInference: true,
  }), /exactly one selected image/);
  const request = buildMapGenerationJobInput({
    buildingSpec, strategy: "single-image-ai", uploadedSources, confirmRights: true,
    selectedViewSourceIds: ["front-photo"], confirmSingleViewInference: true,
  });
  assert.deepEqual(request.viewSourceIds, ["front-photo"]);
  assert.equal(request.confirmSingleViewInference, true);
});

test("requires three views and all operator attestations for photogrammetry", () => {
  const buildingSpec = buildMapGenerationBuildingSpec(baseBuilding);
  const uploadedSources = [
    source("front", ".building-engine/media/b1/assets/front.jpg"),
    source("left", ".building-engine/media/b1/assets/left.jpg"),
    source("right", ".building-engine/media/b1/assets/right.jpg"),
  ];
  assert.throws(() => buildMapGenerationJobInput({
    buildingSpec, strategy: "photogrammetry", uploadedSources, confirmRights: true,
    selectedViewSourceIds: ["front", "left"],
    confirmSameBuilding: true, confirmOverlapReviewed: true, confirmUpAxisReviewed: true, upAxis: "Y",
  }), /at least three selected images/);
  assert.throws(() => buildMapGenerationJobInput({
    buildingSpec, strategy: "photogrammetry", uploadedSources, confirmRights: true,
    selectedViewSourceIds: ["front", "left", "right"],
    confirmSameBuilding: true, confirmOverlapReviewed: false, confirmUpAxisReviewed: true, upAxis: "Y",
  }), /explicit same-building, overlap and up-axis/);
  const request = buildMapGenerationJobInput({
    buildingSpec, strategy: "photogrammetry", uploadedSources, confirmRights: true,
    selectedViewSourceIds: ["front", "left", "right"],
    confirmSameBuilding: true, confirmOverlapReviewed: true, confirmUpAxisReviewed: true, upAxis: "Y",
  });
  assert.deepEqual(request.viewSourceIds, ["front", "left", "right"]);
  assert.equal(request.confirmOverlapReviewed, true);
});

test("rejects unverified licence, unsafe paths, duplicate source IDs and missing rights confirmation", () => {
  const buildingSpec = buildMapGenerationBuildingSpec(baseBuilding);
  assert.throws(() => buildMapGenerationJobInput({
    buildingSpec, strategy: "procedural", uploadedSources: [source("front-photo")], confirmRights: false,
  }), /Confirm source rights/);
  assert.throws(() => buildMapGenerationJobInput({
    buildingSpec, strategy: "procedural", uploadedSources: [{ ...source("front-photo"), licence: "unknown" }], confirmRights: true,
  }), /known licence/);
  assert.throws(() => buildMapGenerationJobInput({
    buildingSpec, strategy: "procedural", uploadedSources: [source("front-photo", "../escape.jpg")], confirmRights: true,
  }), /unsafe workspace-relative path/);
  assert.throws(() => buildMapGenerationJobInput({
    buildingSpec, strategy: "procedural", uploadedSources: [source("front-photo"), source("front-photo")], confirmRights: true,
  }), /unique/);
});
