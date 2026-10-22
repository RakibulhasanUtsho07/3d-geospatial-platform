#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";
import { readRegularEvidenceFile } from "../src/core/building-generation/render-correction-artifact-evidence.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const [candidateArg, geometryOutputArg, textureOutputArg] = process.argv.slice(2);
  if (!candidateArg || !geometryOutputArg || !textureOutputArg || process.argv.length !== 5) {
    throw new Error("Usage: node scripts/create-render-correction-qa-evidence.mjs <candidate.glb> <geometry-qa-report.json> <texture-qa-report.json>");
  }
  const candidatePath = path.resolve(candidateArg);
  const geometryOutputPath = path.resolve(geometryOutputArg);
  const textureOutputPath = path.resolve(textureOutputArg);
  if (new Set([candidatePath, geometryOutputPath, textureOutputPath]).size !== 3) {
    throw new Error("Candidate and QA output paths must be distinct.");
  }
  const candidateBytes = await readRegularEvidenceFile(candidatePath, "candidate model");
  const geometryQa = analyzeGlbQuality(candidateBytes);
  const textureQa = reviewGlbTextureBindings(candidateBytes);
  const geometryBytes = Buffer.from(JSON.stringify(geometryQa, null, 2) + "\n");
  const textureBytes = Buffer.from(JSON.stringify(textureQa, null, 2) + "\n");

  // wx deliberately refuses to overwrite existing evidence.
  await writeFile(geometryOutputPath, geometryBytes, { flag: "wx", mode: 0o600 });
  try {
    await writeFile(textureOutputPath, textureBytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Do not leave a half-created artifact pair when the second output cannot be written.
    const { unlink } = await import("node:fs/promises");
    await unlink(geometryOutputPath).catch(() => {});
    throw error;
  }

  console.log(JSON.stringify({
    candidateGlbSha256: sha256(candidateBytes),
    geometryQa: { path: geometryOutputPath, sha256: sha256(geometryBytes), valid: geometryQa.valid, warnings: geometryQa.warnings.length },
    textureQa: { path: textureOutputPath, sha256: sha256(textureBytes), valid: textureQa.valid, errors: textureQa.errors.length, warnings: textureQa.warnings.length },
    note: "Record these exact report-file SHA-256 values in the correction checklist. The evidence files are immutable outputs; choose new paths for a new candidate.",
  }, null, 2));
}

main().catch((error) => {
  console.error("Could not create correction QA evidence:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
