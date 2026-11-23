import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-secret-storage-logic-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, `${path.basename(relativePath, ".ts")}.mjs`);

  await build({
    entryPoints: [path.join(rootDir, relativePath)],
    bundle: true,
    format: "esm",
    platform: "node",
    alias: {
      obsidian: path.join(rootDir, "scripts", "test-stubs", "obsidian.ts")
    },
    outfile,
    logLevel: "silent"
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function assertMissingStorageDoesNotThrow(module) {
  const service = new module.SecretStorageService({});

  assert.equal(service.getLegacyProviderApiKey("siliconflow"), null);
  assert.equal(service.getModelApiKey("model-default"), null);
  assert.doesNotThrow(() => service.setLegacyProviderApiKey("siliconflow", "test-key"));
  assert.doesNotThrow(() => service.setModelApiKey("model-default", "test-key"));
  assert.doesNotThrow(() => service.clearModelApiKey("model-default"));
  assert.doesNotThrow(() => service.migrateLegacyProviderApiKey("siliconflow", "model-default"));
}

function assertThrowingStorageDoesNotThrow(module) {
  const service = new module.SecretStorageService({
    secretStorage: {
      getSecret() {
        throw new Error("get failed");
      },
      setSecret() {
        throw new Error("set failed");
      }
    }
  });

  const originalWarn = console.warn;
  console.warn = () => undefined;

  try {
    assert.equal(service.getLegacyProviderApiKey("siliconflow"), null);
    assert.equal(service.getModelApiKey("model-default"), null);
    assert.doesNotThrow(() => service.setLegacyProviderApiKey("siliconflow", "test-key"));
    assert.doesNotThrow(() => service.setModelApiKey("model-default", "test-key"));
    assert.doesNotThrow(() => service.clearModelApiKey("model-default"));
    assert.doesNotThrow(() => service.migrateLegacyProviderApiKey("siliconflow", "model-default"));
  } finally {
    console.warn = originalWarn;
  }
}

function assertWorkingStorageRoundTrip(module) {
  const values = new Map();
  const service = new module.SecretStorageService({
    secretStorage: {
      getSecret(key) {
        return values.get(key) ?? null;
      },
      setSecret(key, value) {
        values.set(key, value);
      }
    }
  });

  service.setLegacyProviderApiKey("siliconflow", " legacy-key ");
  assert.equal(service.getLegacyProviderApiKey("siliconflow"), "legacy-key");

  service.migrateLegacyProviderApiKey("siliconflow", "model-default");
  assert.equal(service.getModelApiKey("model-default"), "legacy-key");

  service.setModelApiKey("model-default", "  next-key  ");
  assert.equal(service.getModelApiKey("model-default"), "next-key");

  service.clearModelApiKey("model-default");
  assert.equal(service.getModelApiKey("model-default"), null);
}

async function main() {
  try {
    const module = await loadBundledModule("src/settings/secret-storage.ts");
    assertMissingStorageDoesNotThrow(module);
    assertThrowingStorageDoesNotThrow(module);
    assertWorkingStorageRoundTrip(module);
    console.log("secret storage logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
