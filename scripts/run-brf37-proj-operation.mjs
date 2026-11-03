import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeBrf37PinnedProjOperation } from "../src/core/building-generation/brf37-proj-operation-executor.mjs";

function usage() {
  process.stdout.write(
    "Usage: node scripts/run-brf37-proj-operation.mjs <manifest.json> [--asset-root DIR] [--cct EXE] [--report FILE]\n" +
    "Executes only a reviewed, hash-pinned, local horizontal PROJ operation. Network access is disabled.\n" +
    "Exit code: 0 when all pinned control vectors meet their numeric tolerances; 2 when blocked.\n",
  );
}

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    throw new Error("Missing value for " + name + ".");
  }
  return args[index + 1];
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
} else {
  const manifestPath = args.find((arg) => !arg.startsWith("--"));
  if (!manifestPath) {
    usage();
    process.exitCode = 2;
  } else {
    try {
      const assetRoot = optionValue(args, "--asset-root", process.cwd());
      const cctExecutable = optionValue(args, "--cct", "cct");
      const reportPath = optionValue(args, "--report", null);
      const manifest = JSON.parse(await readFile(path.resolve(manifestPath), "utf8"));
      const report = await executeBrf37PinnedProjOperation(manifest, { assetRoot, cctExecutable });
      const output = JSON.stringify(report, null, 2) + "\n";
      if (reportPath) {
        const destination = path.resolve(reportPath);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, output, "utf8");
      }
      process.stdout.write(output);
      process.exitCode = report.status === "executed-within-tolerance" ? 0 : 2;
    } catch (error) {
      process.stderr.write("BRF-37 execution blocked: " +
        (error instanceof Error ? error.message : "unexpected local validation failure") + "\n");
      process.exitCode = 2;
    }
  }
}
