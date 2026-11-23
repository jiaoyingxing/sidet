import { readFile } from "node:fs/promises";
import path from "node:path";

const issues = [];
const warnings = [];

const argv = process.argv.slice(2);
const projectFlag = argv.indexOf("--project");
const project = path.resolve(
  projectFlag !== -1 && argv[projectFlag + 1] ? argv[projectFlag + 1] : "."
);

async function readJson(name, { required = true } = {}) {
  try {
    return JSON.parse(await readFile(path.join(project, name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      if (!required) return null;
      issues.push(`${name} is missing in ${project}`);
      return null;
    }
    issues.push(`${name} is not valid JSON: ${error.message}`);
    return null;
  }
}

const pkg = await readJson("package.json");
const manifest = await readJson("manifest.json");
const versions = await readJson("versions.json");
const packageLock = await readJson("package-lock.json", { required: false });

if (pkg && !packageLock) {
  warnings.push("package-lock.json is missing");
}

if (pkg && manifest && pkg.version !== manifest.version) {
  issues.push(
    `version mismatch: package.json=${pkg.version}, manifest.json=${manifest.version}`
  );
}

if (pkg && packageLock) {
  if (packageLock.version !== pkg.version) {
    issues.push(
      `version mismatch: package-lock.json=${packageLock.version}, package.json=${pkg.version}`
    );
  }
  if (packageLock.packages?.[""]?.version !== pkg.version) {
    issues.push(
      `version mismatch: package-lock.json root=${packageLock.packages?.[""]?.version}, package.json=${pkg.version}`
    );
  }
}

const semver = /^\d+\.\d+\.\d+$/;

if (manifest) {
  if (!semver.test(String(manifest.version ?? ""))) {
    issues.push(
      `manifest.json version is not semver x.y.z: ${manifest.version}`
    );
  }
  if (!semver.test(String(manifest.minAppVersion ?? ""))) {
    issues.push(
      `manifest.json minAppVersion is not semver x.y.z: ${manifest.minAppVersion}`
    );
  }
  if (!manifest.id || !manifest.name) {
    issues.push("manifest.json is missing required identity fields (id / name)");
  }

  const description = String(manifest.description ?? "").trim();
  if (!description) {
    issues.push("manifest.json is missing description");
  } else {
    if (description.length > 250) {
      issues.push(
        `manifest.json description exceeds 250 characters (${description.length})`
      );
    }
    if (!description.endsWith(".")) {
      issues.push("manifest.json description must end with a period");
    }
    if (/\bObsidian\b/i.test(description)) {
      warnings.push('manifest.json description contains the word "Obsidian"');
    }
  }
}

if (
  manifest &&
  versions &&
  typeof versions === "object" &&
  !Array.isArray(versions)
) {
  const pluginVersion = manifest.version;
  const minAppVersion = manifest.minAppVersion;

  if (
    semver.test(String(pluginVersion ?? "")) &&
    semver.test(String(minAppVersion ?? ""))
  ) {
    const entry = versions[pluginVersion];
    if (typeof entry !== "string") {
      if (typeof versions[minAppVersion] === "string") {
        issues.push(
          `versions.json mapping direction looks inverted: found key "${minAppVersion}", expected key "${pluginVersion}" (versions.json maps plugin version -> minAppVersion)`
        );
      } else {
        issues.push(`versions.json is missing entry for ${pluginVersion}`);
      }
    } else if (entry !== minAppVersion) {
      issues.push(
        `minAppVersion mismatch for ${pluginVersion}: versions.json=${entry}, manifest.json=${minAppVersion}`
      );
    }

    for (const [key, value] of Object.entries(versions)) {
      if (!semver.test(key) || !semver.test(String(value))) {
        issues.push(
          `versions.json entry "${key}": "${value}" is not a plugin version -> minAppVersion semver pair`
        );
      }
    }
  }
}

if (issues.length) {
  console.error("Metadata check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  for (const warning of warnings) {
    console.error(`warn: ${warning}`);
  }
  process.exit(1);
}

console.log("Metadata check passed.");
console.log(`- project: ${project}`);
if (manifest) {
  console.log(`- id: ${manifest.id} / name: ${manifest.name}`);
  console.log(
    `- version: ${manifest.version} (minAppVersion: ${manifest.minAppVersion})`
  );
}
for (const warning of warnings) {
  console.log(`warn: ${warning}`);
}
