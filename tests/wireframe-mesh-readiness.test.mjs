import assert from "node:assert/strict";
import test from "node:test";
import { assessWireframeMeshReadiness } from "../src/core/building-generation/wireframe-mesh-readiness.mjs";

const tetra = {
  vertices:[
    {id:"a",point:[0,0,0],reviewState:"accepted"},
    {id:"b",point:[1,0,0],reviewState:"accepted"},
    {id:"c",point:[0,1,0],reviewState:"accepted"},
    {id:"d",point:[0,0,1],reviewState:"accepted"},
  ],
  edges:[
    {id:"ab",from:"a",to:"b",reviewState:"accepted"},
    {id:"ac",from:"a",to:"c",reviewState:"accepted"},
    {id:"ad",from:"a",to:"d",reviewState:"accepted"},
    {id:"bc",from:"b",to:"c",reviewState:"accepted"},
    {id:"bd",from:"b",to:"d",reviewState:"accepted"},
    {id:"cd",from:"c",to:"d",reviewState:"accepted"},
  ],
  faces:[["a","c","b"],["a","b","d"],["a","d","c"],["b","c","d"]],
  facades:[{id:"front",status:"observed"},{id:"rear",status:"observed"}],
  publicationEligible:false,
  policy:{publicationEligible:false},
};

test("allows explicit reviewed closed connected candidate topology but never publication",()=>{
  const report=assessWireframeMeshReadiness(tetra);
  assert.equal(report.status,"mesh-candidate-ready-for-construction");
  assert.equal(report.readyForMeshConstruction,true);
  assert.equal(report.topology.boundaryEdgeCount,0);
  assert.equal(report.topology.nonManifoldEdges.length,0);
  assert.equal(report.topology.faceComponentCount,1);
  assert.equal(report.publicationEligible,false);
});

test("sparse M11 wireframe with no explicit faces is blocked, not auto-meshed",()=>{
  const graph={...structuredClone(tetra),faces:[]};
  const report=assessWireframeMeshReadiness(graph);
  assert.equal(report.readyForMeshConstruction,false);
  assert.ok(report.blockers.some(b=>b.code==="no-explicit-faces"));
});

test("rejects face boundaries that are not present in the reviewed wireframe",()=>{
  const graph=structuredClone(tetra);
  graph.edges=graph.edges.filter(e=>e.id!=="ab");
  const report=assessWireframeMeshReadiness(graph);
  assert.ok(report.blockers.some(b=>b.code==="face-edge-not-in-wireframe"));
});

test("rejects non-manifold edges used by three faces",()=>{
  const graph=structuredClone(tetra);
  graph.faces.push(["a","b","c"]);
  const report=assessWireframeMeshReadiness(graph);
  assert.ok(report.blockers.some(b=>b.code==="non-manifold-edge"));
});

test("rejects inconsistent winding across shared edges",()=>{
  const graph=structuredClone(tetra);
  graph.faces=[["a","c","b"],["a","c","d"],["a","d","b"],["b","c","d"]];
  const report=assessWireframeMeshReadiness(graph);
  assert.ok(report.blockers.some(b=>b.code==="inconsistent-face-winding"));
});

test("rejects disconnected face components",()=>{
  const graph={
    vertices:[...tetra.vertices,{id:"e",point:[5,0,0],reviewState:"accepted"},{id:"f",point:[6,0,0],reviewState:"accepted"},{id:"g",point:[5,1,0],reviewState:"accepted"}],
    edges:[...tetra.edges,{id:"ef",from:"e",to:"f",reviewState:"accepted"},{id:"fg",from:"f",to:"g",reviewState:"accepted"},{id:"ge",from:"g",to:"e",reviewState:"accepted"}],
    faces:[["a","c","b"],["e","f","g"]],
    facades:tetra.facades,publicationEligible:false,policy:{publicationEligible:false}
  };
  const report=assessWireframeMeshReadiness(graph,{maxBoundaryEdges:6});
  assert.ok(report.blockers.some(b=>b.code==="disconnected-face-components"));
});

test("requires explicit facade coverage and warns when a facade is inferred",()=>{
  const graph=structuredClone(tetra);
  graph.facades=[{id:"front",status:"observed"},{id:"roof",status:"inferred"},{id:"rear",status:"unknown"}];
  const report=assessWireframeMeshReadiness(graph);
  assert.ok(report.blockers.some(b=>b.code==="facade-coverage-incomplete"&&b.facadeIds.includes("rear")));
  assert.ok(report.warnings.some(w=>w.code==="inferred-facades-present"));
});

test("rejects vertices or edges that are not reviewed and accepted",()=>{
  const graph=structuredClone(tetra);
  graph.vertices[0].reviewState="review-required";
  graph.edges[0].reviewState="review-required";
  const report=assessWireframeMeshReadiness(graph);
  assert.ok(report.blockers.some(b=>b.code==="vertex-not-accepted"));
  assert.ok(report.blockers.some(b=>b.code==="edge-not-accepted"));
});

test("rejects unsafe publication policy and degenerate triangles",()=>{
  const graph=structuredClone(tetra);
  graph.publicationEligible=true;
  graph.faces[0]=["a","b","a"];
  const report=assessWireframeMeshReadiness(graph);
  assert.ok(report.blockers.some(b=>b.code==="unsafe-publication-policy"));
  assert.ok(report.blockers.some(b=>b.code==="invalid-face-reference"));
});

test("validates readiness options",()=>{
  assert.throws(()=>assessWireframeMeshReadiness(tetra,{maxBoundaryEdges:-1}),/maxBoundaryEdges/);
  assert.throws(()=>assessWireframeMeshReadiness(tetra,{minTriangleArea:NaN}),/minTriangleArea/);
});
