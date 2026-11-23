import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-knowledge-command-"));
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

function assertConversationKnowledgeCommand(module) {
  assert.deepEqual(
    module.parseDirectConversationKnowledgeCommand("整理到知识库"),
    {},
    "exact knowledge command should still be routed by script"
  );
  assert.deepEqual(
    module.parseDirectConversationKnowledgeCommand("整理到知识库：只保留最终结论"),
    { boundary: "只保留最终结论" },
    "exact knowledge command with explicit boundary syntax should preserve the boundary"
  );
  assert.equal(
    module.parseDirectConversationKnowledgeCommand("帮我把这段对话整理到知识库"),
    null,
    "broad natural language wording should no longer be guessed as a direct script command"
  );
}

function assertPlanContinuationCommand(module) {
  assert.deepEqual(
    module.parseDirectWikiPlanContinuationCommand("继续执行"),
    { matched: true },
    "exact continuation command should still be routed by script"
  );
  assert.equal(
    module.parseDirectWikiPlanContinuationCommand("继续执行这个计划"),
    null,
    "broad continuation wording should no longer be guessed by regex"
  );
}

async function main() {
  try {
    const module = await loadBundledModule("src/workspace/knowledge-command-routing.ts");
    assertConversationKnowledgeCommand(module);
    assertPlanContinuationCommand(module);
    console.log("knowledge command routing logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
