import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-agent-prompts-"));
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

function assertWikiMaintenancePrompts(module) {
  const executionContext = module.buildWikiExecutionDraftRequestContext();
  assert.match(executionContext, /不要重写维护计划/);
  assert.match(executionContext, /最多输出一个 sidet-action 块/);
  assert.match(executionContext, /如果这次更适合只补 Index/);

  const planPrompt = module.buildWikiMaintenancePlanPrompt([
    "来源：本条消息之前的当前 Sidet 对话。",
    "来源对话：测试对话"
  ]);
  assert.match(planPrompt, /你是 Sidet 的 Wiki 管家/);
  assert.match(planPrompt, /第一阶段只在已识别知识库自己的根目录内判断和检索，不跨目录聚合/);
  assert.match(planPrompt, /## 需要用户确认/);
}

function assertDraftGenerationPrompts(module) {
  const memoryBundle = module.buildMemoryCandidateBundle({
    conversationTitle: "测试对话",
    usefulMessageCount: 4,
    attachmentCount: 2
  });
  assert.equal(memoryBundle.kind, "memory-candidate");
  assert.ok(memoryBundle.footer?.some((line) => line.includes("本轮无记忆候选")));

  const skillPrompt = module.buildSkillGenerationPrompt();
  assert.match(skillPrompt, /完整 Skill 以 SKILL\.md 口径输出/);
  assert.match(skillPrompt, /## 不写入/);

  const draftBundle = module.buildDraftNotePreviewBundle({
    conversationTitle: "测试对话",
    usefulMessageCount: 3,
    attachmentCount: 0
  });
  assert.equal(draftBundle.kind, "draft-note-preview");
  assert.ok(draftBundle.footer?.some((line) => line.includes("建议保存位置")));
}

async function main() {
  try {
    const wikiModule = await loadBundledModule("src/agent/prompts/wiki-maintenance-prompts.ts");
    const draftModule = await loadBundledModule("src/agent/prompts/draft-generation-prompts.ts");
    assertWikiMaintenancePrompts(wikiModule);
    assertDraftGenerationPrompts(draftModule);
    console.log("sidet agent prompts logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
