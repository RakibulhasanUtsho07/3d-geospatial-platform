#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { packTextureAtlas, remapFacesToAtlas } from "../src/core/building-generation/texture-atlas.mjs";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function run(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw new Error(`Unable to start ${program}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${program} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  return result.stdout;
}

async function main() {
  const [inputArg, manifestArg, atlasArg, ...flags] = process.argv.slice(2);
  if (!inputArg || !manifestArg || !atlasArg) {
    throw new Error("Usage: node scripts/build-texture-atlas.mjs <texture-candidate.json> <atlas-manifest.json> <atlas.png> [--width=4096] [--height=4096] [--padding=4] [--no-downscale]");
  }
  const inputPath = path.resolve(inputArg);
  const manifestPath = path.resolve(manifestArg);
  const atlasPath = path.resolve(atlasArg);
  if (new Set([inputPath, manifestPath, atlasPath]).size !== 3) throw new Error("input, manifest and atlas paths must be different");
  for (const output of [manifestPath, atlasPath]) {
    try { await readFile(output); throw new Error(`Output already exists: ${output}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const options = {};
  for (const flag of flags) {
    const match = flag.match(/^--(width|height|padding)=(\d+)$/);
    if (flag === "--no-downscale") options.allowDownscale = false;
    else if (match) options[{ width: "width", height: "height", padding: "padding" }[match[1]]] = Number(match[2]);
    else throw new Error(`Unknown option: ${flag}`);
  }
  const candidate = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(candidate.images) || !Array.isArray(candidate.faces)) throw new Error("input must contain images and faces arrays");
  const baseDir = path.dirname(inputPath);
  const imageBytes = new Map();
  for (const image of candidate.images) {
    if (typeof image.path !== "string" || !image.path.trim()) throw new Error(`Image ${image.id} needs a local path`);
    const sourcePath = path.resolve(baseDir, image.path);
    const bytes = await readFile(sourcePath);
    if (sha256(bytes) !== image.sha256?.toLowerCase()) throw new Error(`SHA-256 mismatch for image ${image.id}`);
    if (image.verifiedSource !== true) throw new Error(`Image ${image.id} is not marked verifiedSource=true`);
    const probe = JSON.parse(run("ffprobe", ["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",sourcePath]));
    const stream = probe.streams?.[0];
    if (!stream || stream.width !== image.width || stream.height !== image.height) throw new Error(`Actual dimensions do not match manifest for image ${image.id}`);
    imageBytes.set(image.id, sourcePath);
  }
  const atlas = packTextureAtlas(candidate.images, options);
  const placementById = new Map(atlas.placements.map((p) => [p.id, p]));
  const filterParts = ["[0:v]format=rgba[base]"];
  const args = ["-hide_banner","-loglevel","error","-nostdin","-n","-f","lavfi","-i",`color=c=black@0.0:s=${atlas.width}x${atlas.height}:d=1,format=rgba`];
  for (const image of candidate.images) args.push("-loop","1","-i",imageBytes.get(image.id));
  let previous = "base";
  candidate.images.forEach((image, index) => {
    const p = placementById.get(image.id);
    const pad = p.padding;
    const label = `tex${index}`;
    const overlay = `atlas${index}`;
    const paddedWidth = p.width + pad * 2;
    const paddedHeight = p.height + pad * 2;
    filterParts.push(`[${index + 1}:v]scale=${p.width}:${p.height}:flags=lanczos,pad=${paddedWidth}:${paddedHeight}:${pad}:${pad}:color=black@0,fillborders=left=${pad}:right=${pad}:top=${pad}:bottom=${pad}:mode=smear,format=rgba[${label}]`);
    filterParts.push(`[${previous}][${label}]overlay=${p.outerX}:${p.outerY}:format=auto:shortest=1[${overlay}]`);
    previous = overlay;
  });
  filterParts[filterParts.length - 1] = filterParts[filterParts.length - 1].replace(/\[atlas\d+\]$/, "[outv]");
  const tempAtlas = `${atlasPath}.tmp-${process.pid}.png`;
  const tempManifest = `${manifestPath}.tmp-${process.pid}`;
  try {
    run("ffmpeg", [...args,"-filter_complex",filterParts.join(";"),"-map","[outv]","-frames:v","1","-c:v","png","-pix_fmt","rgba",tempAtlas]);
    const faces = remapFacesToAtlas(candidate.faces, atlas);
    const manifest = {
      schemaVersion: "1.0.0",
      atlas: { id: "main", file: path.basename(atlasPath), width: atlas.width, height: atlas.height, format: "png", alpha: true },
      packing: atlas,
      faces,
      sourceImageSha256: candidate.images.map(({ id, sha256: hash }) => ({ id, sha256: hash })),
      notes: [
        "Image aspect ratios are preserved; low-resolution atlases may require deterministic downscaling.",
        "UV convention is normalized bottom-left, matching common glTF workflows.",
        "Gutter pixels are extended from image borders to help reduce texture bleeding.",
        "This atlas build does not validate the correctness of camera projection or model geometry.",
      ],
      publicationEligible: false,
    };
    await writeFile(tempManifest, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(tempAtlas, atlasPath);
    await rename(tempManifest, manifestPath);
    console.log(JSON.stringify({ atlas: atlasPath, manifest: manifestPath, width: atlas.width, height: atlas.height, images: candidate.images.length, faces: faces.length, uniformScale: atlas.uniformScale, publicationEligible: false }, null, 2));
  } catch (error) {
    await rm(tempAtlas, { force: true });
    await rm(tempManifest, { force: true });
    throw error;
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
