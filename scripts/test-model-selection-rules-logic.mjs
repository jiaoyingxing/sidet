import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-model-selection-"));
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

function modelConfigs() {
  return new Map([
    ["model-a", { id: "model-a", name: "Model A" }],
    ["model-b", { id: "model-b", name: "Model B" }]
  ]);
}

async function main() {
  const module = await loadBundledModule("src/workspace/model-selection-rules.ts");
  const configs = modelConfigs();

  assert.equal(
    module.resolveDefaultModelConfigId(
      { defaultModelConfigId: "model-b", modelConfigs: [{ id: "model-a" }, { id: "model-b" }] },
      configs
    ),
    "model-b"
  );
  assert.equal(
    module.resolveDefaultModelConfigId(
      { defaultModelConfigId: "missing", modelConfigs: [{ id: "model-a" }] },
      configs
    ),
    "model-a"
  );
  assert.equal(
    module.resolveDefaultModelConfigId(
      { defaultModelConfigId: null, modelConfigs: [] },
      configs
    ),
    null
  );

  assert.equal(module.resolveLeafModelConfigId("model-a", "model-b", configs, "model-b"), "model-a");
  assert.equal(module.resolveLeafModelConfigId("missing", "model-b", configs, "model-a"), "model-b");
  assert.equal(module.resolveLeafModelConfigId("missing", "missing", configs, "model-a"), "model-a");
  assert.equal(module.resolveLeafModelConfigId(null, null, configs, null), null);

  assert.equal(module.resolveConversationModelDisplayName("model-a", "model-b", configs), "Model A");
  assert.equal(module.resolveConversationModelDisplayName("missing", "model-b", configs), "未命名模型");
  assert.equal(module.resolveConversationModelDisplayName(null, "model-b", configs), "Model B");
  assert.equal(module.resolveConversationModelDisplayName(null, null, configs), "未命名模型");

  assert.equal(module.resolveReconciledConversationModelConfigId("model-b", configs, "model-a"), "model-b");
  assert.equal(module.resolveReconciledConversationModelConfigId("missing", configs, "model-a"), "model-a");
  assert.equal(module.resolveReconciledConversationModelConfigId(null, configs, "model-a"), "model-a");
  assert.equal(module.resolveReconciledConversationModelConfigId(null, configs, null), null);

  assert.equal(
    module.resolveReconciledLeafModelConfigId(
      { conversationId: "conversation-1", modelConfigId: "model-b" },
      "model-a",
      configs,
      "model-b"
    ),
    "model-a"
  );
  assert.equal(
    module.resolveReconciledLeafModelConfigId(
      { conversationId: "conversation-1", modelConfigId: "model-b" },
      "missing",
      configs,
      "model-a"
    ),
    "model-a"
  );
  assert.equal(
    module.resolveReconciledLeafModelConfigId(
      { conversationId: null, modelConfigId: "model-b" },
      null,
      configs,
      "model-a"
    ),
    "model-b"
  );
  assert.equal(
    module.resolveReconciledLeafModelConfigId(
      { conversationId: null, modelConfigId: "missing" },
      null,
      configs,
      "model-a"
    ),
    "model-a"
  );
  assert.equal(
    module.resolveReconciledLeafModelConfigId(
      { conversationId: null, modelConfigId: null },
      null,
      configs,
      "model-a"
    ),
    "model-a"
  );

  console.log("model selection rules logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
