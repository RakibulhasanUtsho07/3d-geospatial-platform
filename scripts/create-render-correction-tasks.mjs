import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRenderCorrectionTasks } from "../src/core/building-generation/render-correction-tasks.mjs";

const [, , inputArg, outputArg] = process.argv;

if (!inputArg || !outputArg || process.argv.length !== 4) {
  console.error("Usage: node scripts/create-render-correction-tasks.mjs <render-reference-review-report.json> <correction-tasks.json>");
  process.exit(2);
}

try {
  const inputPath = resolve(inputArg);
  const outputPath = resolve(outputArg);
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const backlog = createRenderCorrectionTasks(input);
  // wx prevents accidentally overwriting a prior review/task artifact.
  await writeFile(outputPath, JSON.stringify(backlog, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({
    output: outputPath,
    buildingId: backlog.buildingId,
    taskCount: backlog.counts.total,
    highPriority: backlog.counts.highPriority,
    mediumPriority: backlog.counts.mediumPriority,
    publicationEligible: backlog.automationPolicy.publicationEligible,
  }, null, 2));
} catch (error) {
  console.error("Could not create render correction tasks:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
