import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, "..");

const cesiumRoot = path.join(
  projectRoot,
  "node_modules",
  "cesium",
  "Build",
  "Cesium"
);

const publicCesium = path.join(
  projectRoot,
  "public",
  "cesium"
);

const directories = [
  "Workers",
  "ThirdParty",
  "Assets",
  "Widgets",
];

function copyDirectory(name) {
  const source = path.join(cesiumRoot, name);
  const destination = path.join(publicCesium, name);

  if (!fs.existsSync(source)) {
    throw new Error(`Cesium asset directory not found: ${source}`);
  }

  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
  });

  console.log(`✓ Copied ${name}`);
}

console.log("Preparing Cesium static assets...");

fs.mkdirSync(publicCesium, { recursive: true });

for (const directory of directories) {
  copyDirectory(directory);
}

console.log("✓ Cesium static assets ready");