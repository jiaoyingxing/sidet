import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  const filePath = path.join(rootDir, relativePath);
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

const pkg = await readJson("package.json");
const versions = await readJson("versions.json");

const issues = [];

if (pkg.name !== "sidet") {
  issues.push(`package name must be sidet, received ${String(pkg.name)}`);
}

if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version))) {
  issues.push(`package version is not valid semver: ${String(pkg.version)}`);
}

if (typeof versions[pkg.version] !== "string" || !versions[pkg.version].trim()) {
  issues.push(`versions.json is missing minAppVersion for ${pkg.version}`);
}

if (issues.length) {
  console.error("Sidet source sample metadata check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log("Sidet source sample metadata check passed.");
console.log(`- package: ${pkg.name}`);
console.log(`- version: ${pkg.version}`);
console.log(`- minAppVersion: ${versions[pkg.version]}`);
