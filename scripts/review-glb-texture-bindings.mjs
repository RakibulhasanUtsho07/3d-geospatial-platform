#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { reviewGlbTextureBindings } from "../src/core/building-generation/glb-texture-binding-qa.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readPngDimensions(bytes, label) {
  if (bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    throw new TypeError(label + " is not a PNG file");
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1) throw new TypeError(label + " has invalid PNG dimensions");
  return { width, height };
}

async function main() {
  const [glbArg, reportArg, atlasArg, manifestArg] = process.argv.slice(2);
  if (!glbArg || !reportArg || Boolean(atlasArg) !== Boolean(manifestArg)) {
    throw new Error("Usage: node scripts/review-glb-texture-bindings.mjs <model.glb> <report.json> [atlas.png atlas-manifest.json]");
  }
  const glbPath = path.resolve(glbArg), reportPath = path.resolve(reportArg);
  const inputs = [glbPath];
  let expectedAtlas;
  if (atlasArg && manifestArg) {
    const pngPath = path.resolve(atlasArg), manifestPath = path.resolve(manifestArg);
    inputs.push(pngPath, manifestPath);
    const png = await readFile(pngPath);
    const dimensions = readPngDimensions(png, pngPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.schemaVersion !== "1.0.0" || !manifest.atlas ||
      !Number.isSafeInteger(manifest.atlas.width) || !Number.isSafeInteger(manifest.atlas.height)) {
      throw new TypeError("atlas manifest schema or atlas dimensions are invalid");
    }
    if (manifest.atlas.width !== dimensions.width || manifest.atlas.height !== dimensions.height) {
      throw new Error("atlas PNG dimensions do not match the atlas manifest");
    }
    if (manifest.atlas.file && manifest.atlas.file !== path.basename(pngPath)) {
      throw new Error("atlas filename does not match the manifest atlas.file value");
    }
    expectedAtlas = { sha256:sha256(png), width:dimensions.width, height:dimensions.height };
  }
  if (new Set([...inputs,reportPath]).size !== inputs.length + 1) throw new Error("report output path must differ from all input paths");
  const glb = await readFile(glbPath);
  const report = reviewGlbTextureBindings(glb, { expectedAtlas });
  report.input = { glb:path.basename(glbPath), expectedAtlasChecked:Boolean(expectedAtlas) };
  await writeFile(reportPath, JSON.stringify(report,null,2) + "\n", { flag:"wx", mode:0o600 });
  console.log(JSON.stringify({
    report:reportPath,
    status:report.status,
    valid:report.valid,
    images:report.counts.imageCount,
    texturedPrimitives:report.counts.texturedPrimitiveCount,
    untexturedPrimitives:report.counts.untexturedPrimitiveCount,
    errors:report.errors.length,
    warnings:report.warnings.length,
    publicationEligible:report.publicationEligible,
  },null,2));
  if (!report.valid) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
