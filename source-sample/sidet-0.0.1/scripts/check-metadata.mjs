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
const manifest = await readJson("manifest.json");
const versions = await readJson("versions.json");

const issues = [];

if (pkg.name !== "sidet") {
  issues.push(`package name must be sidet, received ${String(pkg.name)}`);
}

if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version))) {
  issues.push(`package version is not valid semver: ${String(pkg.version)}`);
}

if (manifest.id !== pkg.name) {
  issues.push(
    `manifest id must match package name: ${String(manifest.id)} !== ${String(pkg.name)}`
  );
}

if (manifest.version !== pkg.version) {
  issues.push(
    `manifest version must match package version: ${String(manifest.version)} !== ${String(pkg.version)}`
  );
}

if (
  typeof versions[pkg.version] !== "string" ||
  !versions[pkg.version].trim()
) {
  issues.push(`versions.json is missing minAppVersion for ${pkg.version}`);
}

if (manifest.minAppVersion !== versions[pkg.version]) {
  issues.push(
    `manifest minAppVersion must match versions.json: ${String(manifest.minAppVersion)} !== ${String(versions[pkg.version])}`
  );
}

if (
  typeof manifest.description !== "string" ||
  !manifest.description.trim()
) {
  issues.push("manifest description must be a non-empty English sentence");
} else if (/\bobsidian\b/i.test(manifest.description)) {
  issues.push('manifest description must not include the word "Obsidian"');
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
console.log(`- minAppVersion: ${manifest.minAppVersion}`);
console.log(`- description: ${manifest.description}`);
