#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";

function readGlbJson(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new TypeError("Candidate is not a valid GLB 2.0 container");
  }
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > bytes.length) throw new TypeError("Candidate GLB has an invalid JSON chunk");
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8").trim());
}
export function buildBangabhabanTopologyAudit(bytes, quality = analyzeGlbQuality(bytes)) {
  const candidateSha256 = createHash("sha256").update(bytes).digest("hex");
  const gltf = readGlbJson(bytes);
  const names = new Map();
  for (const node of gltf.nodes || []) {
    if (Number.isSafeInteger(node.mesh)) names.set(node.mesh, node.name || gltf.meshes?.[node.mesh]?.name || ("mesh-" + node.mesh));
  }
  const meshes = quality.meshDetails.map((detail) => {
    const nodeName = names.get(detail.meshIndex) || gltf.meshes?.[detail.meshIndex]?.name || ("mesh-" + detail.meshIndex);
    const topology = detail.topology || {};
    return {
      meshIndex: detail.meshIndex,
      primitiveIndex: detail.primitiveIndex,
      nodeName,
      triangles: detail.triangleCount,
      vertices: detail.vertexCount,
      degenerateTriangles: detail.degenerateTriangleCount,
      connectedComponentCount: topology.connectedComponentCount,
      smallDetachedComponentCount: topology.smallDetachedComponentCount,
      boundaryEdgeCount: topology.boundaryEdgeCount,
      nonManifoldEdgeCount: topology.nonManifoldEdgeCount,
      longEdgeTriangleCount: topology.longEdgeTriangleCount,
      topologyAnalyzed: topology.topologyAnalyzed,
      warnings: topology.warnings || [],
      disposition: "manual-review-required-no-auto-pass"
    };
  });
  const globalWarnings = [...quality.warnings].sort();
  const warningTypes = [...new Set(meshes.flatMap((mesh) => mesh.warnings))].sort();
  return {
    schemaVersion: "1.0.0",
    building: "Bangabhaban",
    candidate: { filename: "bangabhaban-lod3.glb", sha256: candidateSha256, byteLength: bytes.length, status: quality.status },
    summary: {
      meshCount: quality.counts.meshCount,
      primitiveCount: quality.counts.primitiveCount,
      triangles: quality.counts.triangleCount,
      degenerateTriangles: quality.counts.degenerateTriangleCount,
      meshesWithWarnings: meshes.filter(mesh => mesh.warnings.length).length,
      warningMeshCounts: Object.fromEntries(warningTypes.map(warning => [warning, meshes.filter(mesh => mesh.warnings.includes(warning)).length])),
      globalWarnings,
      releaseGate: "blocked-review-required"
    },
    limitations: [
      "This audit measures GLB structure and heuristic topology only; it does not establish architectural fidelity.",
      "Separate architectural parts may legitimately be disconnected, but every warning remains visible for manual review.",
      "All dimensions and the stepped footprint are estimates pending independent measurement or a traced plan.",
      "No images, texture atlas or UVs are embedded in this candidate."
    ],
    meshes
  };
}
export function formatBangabhabanTopologyMarkdown(audit) {
  const rows = audit.meshes.map(m => "| " + m.meshIndex + " | " + m.nodeName + " | " + m.triangles + " | " +
    m.connectedComponentCount + " | " + m.boundaryEdgeCount + " | " + m.nonManifoldEdgeCount + " | " +
    m.longEdgeTriangleCount + " | " + (m.warnings.length ? m.warnings.join(", ") : "none") + " |");
  return [
    "# Bangabhaban — candidate-specific topology audit", "",
    "Decision: blocked-review-required. This is a geometry triage report, not a historical accuracy certificate.", "",
    "## Candidate identity", "",
    "GLB SHA-256: " + audit.candidate.sha256,
    "GLB bytes: " + audit.candidate.byteLength,
    "Geometry QA status: " + audit.candidate.status,
    "Triangles: " + audit.summary.triangles,
    "Degenerate triangles: " + audit.summary.degenerateTriangles,
    "Meshes / primitives: " + audit.summary.meshCount + " / " + audit.summary.primitiveCount,
    "", "## Global warnings", "",
    ...(audit.summary.globalWarnings.length ? audit.summary.globalWarnings.map(w => "- " + w) : ["- none"]),
    "", "## Per-primitive findings", "",
    "| Mesh | Semantic node | Triangles | Components | Boundary edges | Non-manifold edges | Long-edge triangles | Warnings |",
    "|---:|---|---:|---:|---:|---:|---:|---|",
    ...rows,
    "", "## Review policy", "",
    "Warnings are preserved rather than suppressed. Inspect high-impact facade, dome, plinth, roof and wing primitives before accepting any warning.",
    "A valid GLB, a clean plinth or zero degenerate triangles does not prove architectural accuracy.", ""
  ].join("\n");
}
async function main() {
  const [modelArg, jsonArg, markdownArg] = process.argv.slice(2);
  if (!modelArg || !jsonArg || !markdownArg) {
    console.error("Usage: node scripts/build-bangabhaban-topology-audit.mjs <candidate.glb> <topology-audit.json> <topology-audit.md>");
    process.exit(2);
  }
  const bytes = await readFile(path.resolve(modelArg));
  const audit = buildBangabhabanTopologyAudit(bytes);
  const jsonPath = path.resolve(jsonArg), mdPath = path.resolve(markdownArg);
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await mkdir(path.dirname(mdPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(audit, null, 2) + "\n", { flag: "wx" });
  await writeFile(mdPath, formatBangabhabanTopologyMarkdown(audit));
  console.log(JSON.stringify({
    candidateSha256: audit.candidate.sha256,
    status: audit.candidate.status,
    meshCount: audit.summary.meshCount,
    triangles: audit.summary.triangles,
    degenerateTriangles: audit.summary.degenerateTriangles,
    releaseGate: audit.summary.releaseGate
  }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
}
