import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-leaf-mode-"));
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

function baseState(overrides = {}) {
  return {
    conversationId: null,
    draft: "hello",
    modelConfigId: "model-1",
    knowledgeBaseIndexPath: null,
    webSearchEnabled: false,
    ...overrides
  };
}

async function main() {
  const module = await loadBundledModule("src/workspace/chat-leaf-mode-rules.ts");

  assert.equal(module.normalizeKnowledgeBaseIndexPath(null), null);
  assert.equal(module.normalizeKnowledgeBaseIndexPath(""), null);
  assert.equal(module.normalizeKnowledgeBaseIndexPath("   "), null);
  assert.equal(module.normalizeKnowledgeBaseIndexPath("  Sidet/Wiki/Index.md  "), "Sidet/Wiki/Index.md");

  const original = baseState({ webSearchEnabled: true });
  const selected = module.applyKnowledgeBaseSelection(original, "  Sidet/Wiki/Index.md ");
  assert.deepEqual(selected, {
    conversationId: null,
    draft: "hello",
    modelConfigId: "model-1",
    knowledgeBaseIndexPath: "Sidet/Wiki/Index.md",
    webSearchEnabled: false
  });
  assert.equal(original.webSearchEnabled, true, "selection must not mutate the input state");

  const cleared = module.applyKnowledgeBaseSelection(baseState({ webSearchEnabled: true }), null);
  assert.equal(cleared.knowledgeBaseIndexPath, null);
  assert.equal(cleared.webSearchEnabled, true);

  const webSearchOn = module.applyWebSearchEnabled(
    baseState({ knowledgeBaseIndexPath: "Sidet/Wiki/Index.md" }),
    true
  );
  assert.equal(webSearchOn.webSearchEnabled, true);
  assert.equal(webSearchOn.knowledgeBaseIndexPath, null);

  const webSearchOff = module.applyWebSearchEnabled(
    baseState({ knowledgeBaseIndexPath: "Sidet/Wiki/Index.md", webSearchEnabled: true }),
    false
  );
  assert.equal(webSearchOff.webSearchEnabled, false);
  assert.equal(webSearchOff.knowledgeBaseIndexPath, "Sidet/Wiki/Index.md");

  assert.deepEqual(module.resolveSelectedKnowledgeBaseState(null, () => null), {
    mode: "none",
    indexPath: null,
    displayName: null,
    knowledgeBase: null
  });

  const allSelection = "__sidet_all_knowledge_bases__";
  const all = module.resolveSelectedKnowledgeBaseState(allSelection, () => null);
  assert.equal(all.mode, "all");
  assert.equal(all.indexPath, allSelection);
  assert.equal(all.displayName, "全部知识库");
  assert.equal(all.knowledgeBase, null);

  let lookedUp = null;
  const single = module.resolveSelectedKnowledgeBaseState("  Sidet/Wiki/Index.md ", (indexPath) => {
    lookedUp = indexPath;
    return { indexPath, displayName: "Sidet Wiki" };
  });
  assert.equal(lookedUp, "Sidet/Wiki/Index.md");
  assert.equal(single.mode, "single");
  assert.equal(single.indexPath, "Sidet/Wiki/Index.md");
  assert.equal(single.displayName, "Sidet Wiki");
  assert.equal(single.knowledgeBase.displayName, "Sidet Wiki");

  assert.deepEqual(module.resolveSelectedKnowledgeBaseState("missing.md", () => null), {
    mode: "none",
    indexPath: null,
    displayName: null,
    knowledgeBase: null
  });

  let calledForBlank = false;
  assert.deepEqual(module.resolveSelectedKnowledgeBaseState("   ", () => {
    calledForBlank = true;
    return null;
  }), {
    mode: "none",
    indexPath: null,
    displayName: null,
    knowledgeBase: null
  });
  assert.equal(calledForBlank, false);

  console.log("chat leaf mode rules logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
