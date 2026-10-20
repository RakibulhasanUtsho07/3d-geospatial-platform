#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBuildingGenerationRequest } from "../src/core/building-generation/input-policy.mjs";
import { generateParametricBuildingGlb } from "../src/core/building-generation/procedural-builder.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readArgs(argv) {
  const result = { input: resolve(projectRoot, "data/building-generation/examples/dhaka-apartment.json"), output: resolve(projectRoot, "artifacts/generated-building-draft.glb"), force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(argument + " requires a path.");
      result[argument === "--input" ? "input" : "output"] = resolve(process.cwd(), value);
      index += 1;
    } else if (argument === "--force") {
      result.force = true;
    } else if (argument === "--help" || argument === "-h") {
      result.help = true;
    } else {
      throw new Error("Unknown argument: " + argument);
    }
  }
  return result;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Generate a procedural building GLB from a BuildingGenerationRequest JSON file.");
    console.log("Usage: npm run generate:building-model -- [--input file.json] [--output file.glb] [--force]");
    process.exitCode = 0;
    return;
  }
  if (extname(args.input).toLowerCase() !== ".json") throw new Error("Input must be a .json file.");
  if (extname(args.output).toLowerCase() !== ".glb") throw new Error("Output must use the .glb extension.");
  if (!args.force && await exists(args.output)) throw new Error("Output already exists. Choose another path or pass --force to overwrite it.");

  const raw = await readFile(args.input, "utf8");
  const parsed = JSON.parse(raw);
  const request = normalizeBuildingGenerationRequest(parsed);
  const result = generateParametricBuildingGlb(request);
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, result.glb, { flag: args.force ? "w" : "wx" });
  console.log(JSON.stringify({
    output: args.output,
    bytes: result.glb.length,
    contentType: "model/gltf-binary",
    metadata: result.metadata,
  }, null, 2));
}

main().catch((error) => {
  console.error("[Building Generation] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
