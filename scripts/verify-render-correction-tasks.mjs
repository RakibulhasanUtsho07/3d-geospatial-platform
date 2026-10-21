import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyRenderCorrectionTasks } from "../src/core/building-generation/render-correction-verification.mjs";

const [, , backlogArg, reviewArg, outputArg] = process.argv;

if (!backlogArg || !reviewArg || !outputArg || process.argv.length !== 5) {
  console.error("Usage: node scripts/verify-render-correction-tasks.mjs <correction-tasks.json> <new-render-reference-review-report.json> <verification-output.json>");
  process.exit(2);
}

try {
  const backlog = JSON.parse(await readFile(resolve(backlogArg), "utf8"));
  const report = JSON.parse(await readFile(resolve(reviewArg), "utf8"));
  const verification = verifyRenderCorrectionTasks(backlog, report);
  const outputPath = resolve(outputArg);
  // wx avoids silently replacing a prior verification snapshot.
  await writeFile(outputPath, JSON.stringify(verification, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({
    output: outputPath,
    buildingId: verification.buildingId,
    taskCount: verification.counts.total,
    verified: verification.counts.verified,
    needsMoreWork: verification.counts.needsMoreWork,
    publicationEligible: verification.automationPolicy.publicationEligible,
  }, null, 2));
} catch (error) {
  console.error("Could not verify render correction tasks:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
