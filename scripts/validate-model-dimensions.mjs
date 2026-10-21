import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeGlbQuality } from "../src/core/building-generation/glb-geometry-qa.mjs";
import { validateReferenceDimensions } from "../src/core/building-generation/reference-dimension-validation.mjs";

function usage() {
  console.error("Usage: node scripts/validate-model-dimensions.mjs <model.glb> <reference.json> [report.json]");
  console.error("reference.json must include measured-independent referenceDimensionsM {x,y,z}, metresPerModelUnit, and optional tolerancePercent/axisMapping.");
  process.exitCode = 2;
}

const [, , glbArg, referenceArg, reportArg] = process.argv;
if (!glbArg || !referenceArg) {
  usage();
} else {
  try {
    const glbPath = path.resolve(glbArg);
    const referencePath = path.resolve(referenceArg);
    const [glb, referenceText] = await Promise.all([readFile(glbPath), readFile(referencePath)]);
    const reference = JSON.parse(referenceText.toString("utf8"));
    const quality = analyzeGlbQuality(glb);
    const dimensions = validateReferenceDimensions({
      measuredModelDimensions: {
        x: quality.bounds.dimensions[0],
        y: quality.bounds.dimensions[1],
        z: quality.bounds.dimensions[2],
      },
      referenceDimensionsM: reference.referenceDimensionsM,
      metresPerModelUnit: reference.metresPerModelUnit,
      tolerancePercent: reference.tolerancePercent,
      axisMapping: reference.axisMapping,
    });
    const report = {
      ...dimensions,
      input: {
        modelFile: path.basename(glbPath),
        referenceFile: path.basename(referencePath),
        glbBytes: glb.length,
        glbGeometryQaStatus: quality.status,
        glbBoundsModelUnits: quality.bounds,
      },
    };
    const serialized = JSON.stringify(report, null, 2) + "\n";
    if (reportArg) await writeFile(path.resolve(reportArg), serialized, "utf8");
    else process.stdout.write(serialized);
    if (report.status !== "dimension-check-passed-review-required") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
