import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-context-bundles-"));
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

function assertTrimHelper(module) {
  assert.deepEqual(
    module.trimContextTextToBudget("abc", 10),
    { text: "abc", truncated: false }
  );
  assert.deepEqual(
    module.trimContextTextToBudget("abcdefgh", 4),
    { text: "abcd\n\n[已截断，库内候选上下文过长]", truncated: true }
  );
}

function assertRouterBundle(module) {
  const bundle = module.buildAgentRouterContextBundle({
    skillRouteLines: ["1. 技能A", "适用：测试"],
    knowledgeBaseRouteLines: ["1. [[Sidet/Wiki/Index.md]]"],
    selectedKnowledgeBaseNote: "1. 全部知识库；范围：仅在已识别知识库内做关键词检索。",
    wikiRouteLines: ["1. [[Sidet/Wiki/Test.md]]；类型：知识卡；匹配：test；读取：先看摘要"],
    wikiSections: [
      {
        heading: "1. Test",
        metadata: [{ label: "路径", value: "Sidet/Wiki/Test.md" }],
        content: "# Test"
      }
    ],
    truncated: true
  });
  assert.equal(bundle.kind, "agent-router-context");
  assert.equal(bundle.truncated, true);
  assert.ok(bundle.footer?.some((line) => line.includes("预览确认链")));
  assert.ok(bundle.footer?.some((line) => line.includes("全部知识库")));
}

async function main() {
  try {
    const contextBundleModule = await loadBundledModule("src/agent/context-bundle.ts");
    const routerModule = await loadBundledModule("src/agent/prompts/router-context-prompts.ts");
    assertTrimHelper(contextBundleModule);
    assertRouterBundle(routerModule);
    console.log("sidet context bundles logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
