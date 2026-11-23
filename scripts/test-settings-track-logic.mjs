import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-settings-track-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, `${path.basename(relativePath, ".ts")}.mjs`);

  await build({
    entryPoints: [path.join(rootDir, relativePath)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function main() {
  const module = await loadBundledModule("src/settings/settings-track.ts");

  assert.equal(module.detectSettingsTrack(undefined), "legacy");
  assert.equal(module.detectSettingsTrack(null), "legacy");
  assert.equal(module.detectSettingsTrack({}), "legacy");
  assert.equal(module.detectSettingsTrack({ settingItems: [] }), "legacy");
  assert.equal(module.detectSettingsTrack({ settingItems: "not-an-array" }), "legacy");
  assert.equal(module.detectSettingsTrack({ settingItems: [{}] }), "declarative");

  assert.equal(module.resolveSettingsRerenderAction(undefined), "display");
  assert.equal(module.resolveSettingsRerenderAction({ settingItems: [] }), "display");
  assert.equal(module.resolveSettingsRerenderAction({ settingItems: [{}] }), "update");

  console.log("settings track logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
