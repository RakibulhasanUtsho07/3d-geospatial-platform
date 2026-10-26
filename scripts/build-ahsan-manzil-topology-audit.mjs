import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tick = String.fromCharCode(96);
const CONTEXT = new Set([
  'Site_Ground', 'Site_River', 'Site_Approach', 'Site_Pond',
  'Site_Family_Mosque', 'Site_Stable', 'Site_Trees', 'Site_Context_Blocks',
]);
const ROLE = {
  Plinth: 'primary-building-base',
  Rangmahal_GF: 'primary-facade-ground-floor',
  Rangmahal_FF: 'primary-facade-first-floor',
  Portico_S: 'front-ceremonial-portico',
  Portico_N: 'rear-portico-and-arch-elements',
  Stair_S: 'front-ceremonial-stair',
  Veranda_S: 'front-veranda-and-balustrades',
  Veranda_N: 'rear-veranda-and-balustrades',
  RoofDeck: 'roof-planes-and-raised-central-platform',
  Parapet: 'roofline-parapet-and-pinnacles',
  Dome_Drum: 'octagonal-drum-and-open-arches',
  Dome: 'dome-shell-and-profile-ribs',
  Finial: 'dome-finial',
  Andarmahal: 'rear-west-wing-facade-and-roof-joinery',
  Site_Ground: 'illustrative-site-ground-plane',
  Site_River: 'illustrative-river-plane',
  Site_Approach: 'illustrative-approach-path',
  Site_Pond: 'illustrative-pond-plane',
  Site_Family_Mosque: 'illustrative-surrounding-mosque',
  Site_Stable: 'illustrative-service-building',
  Site_Trees: 'illustrative-tree-population',
  Site_Context_Blocks: 'illustrative-context-building-massing',
};
const NOTE = {
  Plinth: 'Current candidate uses one stepped L-footprint prism. QA reports one connected component and zero boundary/non-manifold edges; the long-edge warning remains and the provisional footprint still needs independent trace or survey.',
  Rangmahal_GF: 'Wall segments, piers, arched reveals, glazing and trims are combined as separate triangle-soup parts. Disconnected parts/open boundaries may be expected; non-manifold edges need overlap review.',
  Rangmahal_FF: 'First-floor arches, balustrades, pilasters and trims are separate parts. Disconnected parts/open boundaries may be expected; non-manifold edges need overlap review.',
  Portico_S: 'Distinct columns, arches, beams and small decorative parts are expected. The small detached component and long-edge warnings still need view-by-view inspection.',
  Portico_N: 'The rear portico similarly contains separate column/arch/trim elements. The reported small detached component still needs inspection.',
  Stair_S: 'Discrete risers, treads and nosing are expected separate components. Check the long-edge counts against the tread dimensions and side profile.',
  Veranda_S: 'Separate deck, rail, baluster and column members are expected. Check boundary warnings for actual gaps or intersections.',
  Veranda_N: 'Separate deck, rail, baluster and column members are expected. Non-manifold edges suggest rail/member intersections need review.',
  RoofDeck: 'Rangmahal and Andarmahal roof volumes plus the raised central platform are separate solids. Disconnected components are expected; inspect platform-to-deck joins and the overall roof silhouette.',
  Parapet: 'Contains long cornice/rail sections, repeated pinnacles and end rails. Check joins for intersecting rails or duplicated faces.',
  Dome_Drum: 'Open drum apertures are intentional. Non-manifold edges at columns, arch bands and drum walls still require inspection.',
  Dome: 'The shell/profile plus meridian ribs and rings create multiple components. Inspect silhouette breaks rather than suppressing the warning.',
  Finial: 'Small ornamental parts may be disconnected by design; check open boundaries against the rendered finial silhouette.',
  Andarmahal: 'Facade blocks, end openings, windows, floors and trim are combined. Non-manifold edges and boundaries remain release-blocking until reviewed.',
  Site_Ground: 'Illustrative site plane only; long spans/open surfaces must not count toward palace-body accuracy.',
  Site_River: 'Illustrative water plane only; open boundaries are expected for a plane and are not palace-body evidence.',
  Site_Approach: 'Illustrative approach-path surface only; score separately from palace-body geometry.',
  Site_Pond: 'Illustrative pond surface only; score separately from palace-body geometry.',
  Site_Family_Mosque: 'Illustrative surrounding context, not a surveyed heritage asset; do not treat its topology as palace-model evidence.',
  Site_Stable: 'Illustrative service-building context, not a surveyed heritage asset.',
  Site_Trees: 'Multiple separate tree elements are expected for illustrative context.',
  Site_Context_Blocks: 'Multiple contextual building blocks are expected illustrative massing, not Ahsan Manzil geometry.',
};
function parseGlbJson(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) throw new TypeError('Expected GLB 2.0 bytes');
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new TypeError('Invalid GLB version or declared total length');
  const length = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + length > bytes.length) throw new TypeError('Invalid GLB JSON chunk');
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8').replace(/[\u0000\u0020]+$/g, ''));
  if (!Array.isArray(gltf.nodes) || !Array.isArray(gltf.meshes)) throw new TypeError('GLB JSON has no nodes/meshes');
  return gltf;
}
export function buildTopologyAudit(glbBytes, geometryReport) {
  const gltf = parseGlbJson(glbBytes);
  if (!geometryReport || geometryReport.valid !== true || !Array.isArray(geometryReport.meshDetails)) throw new TypeError('Expected valid geometry QA report');
  if (geometryReport.counts?.meshCount !== gltf.meshes.length) throw new Error('Geometry report and GLB mesh counts differ');
  const namesByMesh = new Map();
  for (const node of gltf.nodes) {
    if (!Number.isSafeInteger(node.mesh)) continue;
    const names = namesByMesh.get(node.mesh) ?? [];
    names.push(node.name ?? ('node-' + node.mesh));
    namesByMesh.set(node.mesh, names);
  }
  const meshes = geometryReport.meshDetails.map((entry) => {
    const names = namesByMesh.get(entry.meshIndex) ?? [];
    if (names.length !== 1) throw new Error('Mesh ' + entry.meshIndex + ' must map to exactly one named node; found ' + names.length);
    const nodeName = names[0];
    const topology = entry.topology ?? {};
    const warnings = [...new Set(topology.warnings ?? [])].sort();
    const contextOnly = CONTEXT.has(nodeName);
    const priority = (topology.nonManifoldEdgeCount ?? 0) > 0 || (topology.smallDetachedComponentCount ?? 0) > 0
      ? 'high' : warnings.length ? 'medium' : 'none';
    return {
      meshIndex: entry.meshIndex,
      primitiveIndex: entry.primitiveIndex,
      nodeName,
      role: ROLE[nodeName] ?? 'unclassified-node',
      architecturalAccuracyRelevant: !contextOnly,
      vertices: entry.vertexCount,
      triangles: entry.triangleCount,
      degenerateTriangles: entry.degenerateTriangleCount,
      connectedComponents: topology.connectedComponentCount ?? null,
      smallDetachedComponents: topology.smallDetachedComponentCount ?? null,
      boundaryEdges: topology.boundaryEdgeCount ?? null,
      nonManifoldEdges: topology.nonManifoldEdgeCount ?? null,
      longEdgeTriangles: topology.longEdgeTriangleCount ?? null,
      longEdgeTriangleRatio: topology.longEdgeTriangleRatio ?? null,
      warnings,
      reviewPriority: priority,
      disposition: contextOnly
        ? (warnings.length ? 'context-only-exclude-from-building-score-but-retain-warning' : 'context-only-no-warning')
        : (warnings.length ? 'manual-review-required-no-auto-pass' : 'no-topology-warning'),
      designNote: NOTE[nodeName] ?? 'No semantic triage rule exists; manual review is required.',
    };
  });
  const building = meshes.filter((mesh) => mesh.architecturalAccuracyRelevant);
  const warningMeshCounts = {};
  for (const mesh of meshes) for (const warning of mesh.warnings) warningMeshCounts[warning] = (warningMeshCounts[warning] ?? 0) + 1;
  const globalWarnings = [...(geometryReport.warnings ?? [])];
  return {
    schemaVersion: '1.0.0',
    task: 'P3.3-topology-triage',
    candidate: {
      filename: 'ahsan-manzil-lod3.glb',
      sha256: hash(glbBytes),
      byteLength: glbBytes.length,
      geometryReportSha256: hash(Buffer.from(JSON.stringify(geometryReport))),
      status: geometryReport.status,
    },
    summary: {
      meshCount: meshes.length,
      buildingMeshCount: building.length,
      contextMeshCount: meshes.length - building.length,
      triangles: geometryReport.counts?.triangleCount ?? meshes.reduce((sum, mesh) => sum + mesh.triangles, 0),
      degenerateTriangles: geometryReport.counts?.degenerateTriangleCount ?? meshes.reduce((sum, mesh) => sum + mesh.degenerateTriangles, 0),
      meshWarnings: meshes.filter((mesh) => mesh.warnings.length).length,
      buildingMeshesWithWarnings: building.filter((mesh) => mesh.warnings.length).length,
      warningMeshCounts,
      globalWarnings,
      releaseGate: globalWarnings.length ? 'blocked-review-required' : 'topology-warning-free-basic-check-only',
    },
    warningPolicy: {
      'non-manifold-edges-present': 'High priority. Inspect intersecting/coincident faces and fix or justify the exact join; never suppress globally.',
      'small-detached-components-present': 'High priority. Inspect the actual mesh; do not assume a detached part is decorative from counts alone.',
      'open-boundary-edges-present': 'Can be intentional for apertures/open rails/planes; inspect by semantic node and retain the warning until reviewed.',
      'disconnected-mesh-components-present': 'Many box/rib/rail/shutter members are separate by design; this warning alone is neither a defect nor a pass.',
      'long-triangle-edges-present': 'A model-diagonal heuristic; large planar walls/decks can trigger it. Inspect feature-spanning faces and silhouettes, not dimensions.',
      'no-texture-atlas-embedded-or-declared': 'The GLB has no embedded images, texture bindings, or UV accessors; calibrated photo-texture/facade fidelity is not verified.',
    },
    limitations: [
      'This report maps geometry QA findings to semantic nodes; it does not repair meshes or certify architectural accuracy.',
      'Intentionality is a review hypothesis, not an exemption. High-priority warnings remain unresolved until the specific mesh is inspected and repaired or justified with evidence.',
      'Site_* context nodes are excluded from building-body scoring, but their warnings remain visible.',
      'No UV projection, texture, surveyed dimensions, rectified elevation or footprint control data are implied.',
    ],
    meshes,
  };
}
export function formatTopologyAuditMarkdown(audit) {
  const s = audit.summary;
  const lines = [
    '# P3.3 — Ahsan Manzil per-mesh topology triage',
    '',
    '**Decision:** ' + s.releaseGate + '. This is a triage report, not an automatic repair or accuracy certificate.',
    '',
    '## Candidate identity',
    '',
    '- GLB SHA-256: ' + tick + audit.candidate.sha256 + tick,
    '- GLB bytes: ' + audit.candidate.byteLength,
    '- Geometry-report SHA-256: ' + tick + audit.candidate.geometryReportSha256 + tick,
    '- Geometry QA status: ' + tick + audit.candidate.status + tick,
    '',
    '## Summary',
    '',
    '| Metric | Count |',
    '|---|---:|',
    '| Meshes | ' + s.meshCount + ' |',
    '| Building-semantic meshes | ' + s.buildingMeshCount + ' |',
    '| Illustrative context meshes | ' + s.contextMeshCount + ' |',
    '| Triangles | ' + s.triangles + ' |',
    '| Degenerate triangles | ' + s.degenerateTriangles + ' |',
    '| Meshes with topology warnings | ' + s.meshWarnings + ' |',
    '| Building meshes with warnings | ' + s.buildingMeshesWithWarnings + ' |',
    '',
    '## Global geometry QA warnings',
    '',
    ...(s.globalWarnings.length ? s.globalWarnings.map((warning) => '- ' + tick + warning + tick) : ['- None reported.']),
    '',
    '## Per-mesh findings',
    '',
    '| Index | Semantic node | Triangles | Components | Small detached | Boundary edges | Non-manifold edges | Long-edge triangles | Priority | Disposition | Warnings |',
    '|---:|---|---:|---:|---:|---:|---:|---:|---|---|---|',
  ];
  for (const mesh of audit.meshes) {
    const clean = (value) => String(value ?? 'n/a').replaceAll('|', '\\|');
    lines.push('| ' + mesh.meshIndex + ' | ' + tick + mesh.nodeName + tick + ' | ' + mesh.triangles + ' | ' + clean(mesh.connectedComponents) + ' | ' + mesh.smallDetachedComponents + ' | ' + mesh.boundaryEdges + ' | ' + mesh.nonManifoldEdges + ' | ' + mesh.longEdgeTriangles + ' | ' + mesh.reviewPriority + ' | ' + mesh.disposition + ' | ' + (mesh.warnings.length ? mesh.warnings.map((w) => tick + w + tick).join(', ') : 'none') + ' |');
  }
  lines.push('', '## Semantic triage notes', '');
  for (const mesh of audit.meshes) lines.push('### ' + mesh.nodeName, '', '- Role: ' + mesh.role, '- Building-accuracy relevant: ' + mesh.architecturalAccuracyRelevant, '- Triage note: ' + mesh.designNote, '');
  lines.push('## Warning policy', '');
  for (const [warning, policy] of Object.entries(audit.warningPolicy)) lines.push('- **' + tick + warning + tick + ':** ' + policy);
  lines.push('', '## Limitations', '');
  for (const limitation of audit.limitations) lines.push('- ' + limitation);
  lines.push('');
  return lines.join('\n');
}
async function main() {
  const args = process.argv.slice(2);
  const glbPath = args[0], geometryPath = args[1], jsonPath = args[2], markdownPath = args[3];
  if (!glbPath || !geometryPath || !jsonPath || !markdownPath) throw new Error('Usage: node scripts/build-ahsan-manzil-topology-audit.mjs <glb> <geometry-report.json> <audit.json> <audit.md>');
  const [glbBytes, reportBytes] = await Promise.all([readFile(glbPath), readFile(geometryPath)]);
  const report = JSON.parse(reportBytes.toString('utf8'));
  const audit = buildTopologyAudit(glbBytes, report);
  audit.candidate.geometryReportSha256 = hash(reportBytes);
  await Promise.all([mkdir(path.dirname(jsonPath), {recursive:true}), mkdir(path.dirname(markdownPath), {recursive:true})]);
  await Promise.all([
    writeFile(jsonPath, JSON.stringify(audit, null, 2) + '\n', {flag:'w'}),
    writeFile(markdownPath, formatTopologyAuditMarkdown(audit), {flag:'w'}),
  ]);
  console.log(JSON.stringify({candidateSha256:audit.candidate.sha256,summary:audit.summary,jsonPath,markdownPath}, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await main();
