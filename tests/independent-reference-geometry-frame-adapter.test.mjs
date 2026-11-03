import assert from "node:assert/strict";
import test from "node:test";
import { adaptIndependentReferenceGeometry, validateSurveyFrameTransformMatrix4x4 } from "../src/core/building-generation/independent-reference-geometry-adapter.mjs";
import { surveyGeometryDocument } from "./fixtures/glb-geometry-fixture.mjs";

const translated = [1,0,0,0, 0,1,0,0, 0,0,1,0, 11,1,22,1];
const rotated90 = [0,0,-1,0, 0,1,0,0, 1,0,0,0, 11,1,22,1];

test("transforms survey footprint, mesh and independent checkpoints into the evaluation frame", () => {
  const source = surveyGeometryDocument({ coordinateFrameId: "survey-local-frame-v1", localCoordinates: true });
  const result = adaptIndependentReferenceGeometry(source, {
    sourceCoordinateFrameId: "survey-local-frame-v1",
    evaluationCoordinateFrameId: "test-building-frame-y-up-v1",
    sourceToEvaluationFrameMatrix4x4: translated,
  });
  assert.equal(result.coordinateFrameId, "test-building-frame-y-up-v1");
  assert.equal(result.units, "m");
  assert.deepEqual(result.footprint, [{x:11,z:22},{x:13,z:22},{x:13,z:26},{x:11,z:26}]);
  assert.deepEqual(result.dimensionsM, {widthM:2,depthM:4,heightM:3});
  assert.deepEqual(result.checkPoints[0], {id:"survey-check-01",x:11,y:1,z:22,independentOfFit:true});
  assert.deepEqual(result.surfaceMesh.vertices[6], [13,4,26]);
  assert.deepEqual(result.frameTransform.sourceToEvaluationFrameMatrix4x4, translated);
});

test("swaps width/depth when a 90-degree axis alignment maps source X to evaluation Z", () => {
  const source = surveyGeometryDocument({ coordinateFrameId: "survey-local-frame-v1", localCoordinates: true });
  const result = adaptIndependentReferenceGeometry(source, {
    sourceCoordinateFrameId: "survey-local-frame-v1",
    evaluationCoordinateFrameId: "site-building-frame-v1",
    sourceToEvaluationFrameMatrix4x4: rotated90,
  });
  assert.deepEqual(result.dimensionsM, {widthM:4,depthM:2,heightM:3});
  assert.deepEqual(result.footprint, [{x:11,z:22},{x:11,z:20},{x:15,z:20},{x:15,z:22}]);
});

test("rejects source-frame lies, non-metric scaling, arbitrary yaw and missing ground datum", () => {
  const source = surveyGeometryDocument({ coordinateFrameId: "survey-local-frame-v1", localCoordinates: true });
  assert.throws(() => adaptIndependentReferenceGeometry(source, {
    sourceCoordinateFrameId: "wrong-frame", evaluationCoordinateFrameId: "site-building-frame-v1",
    sourceToEvaluationFrameMatrix4x4: translated,
  }), /coordinateFrameId must match/);
  const scaled = [...translated]; scaled[0] = 2;
  assert.throws(() => validateSurveyFrameTransformMatrix4x4(scaled), /scale-preserving/);
  const arbitraryYaw = [...translated];
  const angle = Math.PI / 6; arbitraryYaw[0]=Math.cos(angle); arbitraryYaw[2]=-Math.sin(angle);
  arbitraryYaw[8]=Math.sin(angle); arbitraryYaw[10]=Math.cos(angle);
  assert.throws(() => validateSurveyFrameTransformMatrix4x4(arbitraryYaw), /scale-preserving/);
  delete source.footprintElevationM;
  assert.throws(() => adaptIndependentReferenceGeometry(source, {
    sourceCoordinateFrameId: "survey-local-frame-v1", evaluationCoordinateFrameId: "site-building-frame-v1",
    sourceToEvaluationFrameMatrix4x4: translated,
  }), /footprintElevationM/);
});
