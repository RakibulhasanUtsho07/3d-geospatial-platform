import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { analyzeGlbQuality } from '../src/core/building-generation/glb-geometry-qa.mjs';
import { buildTopologyAudit, formatTopologyAuditMarkdown } from '../scripts/build-ahsan-manzil-topology-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('topology audit maps every generated GLB mesh to a named node without suppressing findings', async () => {
  const glb = await readFile(path.join(root, 'public/models/ahsan-manzil-lod3.glb'));
  const report = analyzeGlbQuality(glb);
  const audit = buildTopologyAudit(glb, report);
  const expectedSha = createHash('sha256').update(glb).digest('hex');
  assert.equal(audit.candidate.sha256, expectedSha);
  assert.equal(audit.summary.meshCount, report.counts.meshCount);
  assert.equal(audit.meshes.length, report.counts.meshCount);
  assert.equal(new Set(audit.meshes.map((mesh) => mesh.nodeName)).size, audit.meshes.length);
  assert.ok(audit.meshes.every((mesh) => mesh.role !== 'unclassified-node'));
  assert.equal(audit.summary.triangles, report.counts.triangleCount);
  assert.equal(audit.summary.degenerateTriangles, report.counts.degenerateTriangleCount);
  assert.equal(audit.candidate.status, report.status);
  assert.equal(audit.summary.releaseGate, 'blocked-review-required');
  const sourceWarnings = new Set(report.warnings);
  const auditWarnings = new Set([...audit.meshes.flatMap((mesh) => mesh.warnings), ...audit.summary.globalWarnings]);
  for (const warning of sourceWarnings) assert.ok(auditWarnings.has(warning), 'audit must preserve ' + warning);
  assert.equal(audit.summary.warningMeshCounts['non-manifold-edges-present'] ?? 0,
    audit.meshes.filter((mesh) => mesh.warnings.includes('non-manifold-edges-present')).length);
  const context = audit.meshes.filter((mesh) => !mesh.architecturalAccuracyRelevant);
  assert.equal(context.length, 8);
  assert.ok(context.every((mesh) => mesh.nodeName.startsWith('Site_')));
  assert.ok(context.some((mesh) => mesh.warnings.length > 0), 'context warnings stay visible although excluded from building scoring');
  assert.ok(audit.meshes.filter((mesh) => mesh.nodeName === 'Rangmahal_GF' || mesh.nodeName === 'Rangmahal_FF')
    .every((mesh) => mesh.architecturalAccuracyRelevant));
  assert.ok(audit.meshes.some((mesh) => mesh.nodeName === 'RoofDeck' && mesh.designNote.includes('raised central platform')));
  assert.ok(audit.limitations.some((limitation) => limitation.includes('does not repair meshes')));
  assert.ok(formatTopologyAuditMarkdown(audit).includes(expectedSha));
});
