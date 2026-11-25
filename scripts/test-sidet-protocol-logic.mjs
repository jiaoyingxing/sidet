import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-protocol-logic-"));
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

function assertParseResearchBlock(protocolModule) {
  const instruction = protocolModule.parseSidetResearchBlock(`\`\`\`sidet-research
question: 2026 年 GitHub 上最活跃的开源项目
reason: 需要先补最近一年的项目动态
\`\`\``);

  assert.ok(instruction, "research block should parse");
  assert.equal(instruction.question, "2026 年 GitHub 上最活跃的开源项目");
  assert.equal(instruction.reason, "需要先补最近一年的项目动态");

  const aliasInstruction = protocolModule.parseSidetResearchBlock(`\`\`\`sidet-research
query: 另一个研究问题
\`\`\``);
  assert.ok(aliasInstruction, "query alias should parse");
  assert.equal(aliasInstruction.question, "另一个研究问题");

  const missingQuestion = protocolModule.parseSidetResearchBlock(`\`\`\`sidet-research
reason: 没有研究问题
\`\`\``);
  assert.equal(missingQuestion, null, "missing question should be invalid");

  const resultBlock = protocolModule.parseSidetResearchBlock(`\`\`\`sidet-research-result
question: 这不是研究指令
\`\`\``);
  assert.equal(resultBlock, null, "research result block should not parse as a research instruction");
}

function assertStripProtocolBlocks(protocolModule) {
  const stripped = protocolModule.stripSidetProtocolBlocks([
    "先保留这句",
    "",
    "```sidet-direct",
    "reason: 不需要联网",
    "```",
    "",
    "```sidet-search",
    "intent: web_search",
    "round: 1",
    "query1: sidet",
    "```",
    "",
    "```sidet-research",
    "question: 还需要补什么",
    "```",
    "",
    "```sidet-research-result",
    "round: 1",
    "---",
    "证据",
    "```",
    "",
    "正文保留",
    "",
    "```sidet-fetch",
    "round: 1",
    "pick1: 1",
    "```"
  ].join("\n"));

  assert.equal(
    stripped,
    "先保留这句\n\n正文保留",
    "strip should remove new and historical internal protocol blocks only"
  );
}

function assertBuildResearchResultBlock(protocolModule) {
  const block = protocolModule.buildSidetResearchResultBlock({
    round: 2,
    question: "测试研究问题",
    queries: ["query one", "query two"],
    providerLabel: "Bing + 百度",
    searchResultCount: 7,
    sourceStart: 3,
    pages: [
      { sourceIndex: 3, title: "Page Three", url: "https://example.com/3" },
      { sourceIndex: 4, title: "Page Four", url: "https://example.com/4" }
    ],
    evidenceText: "这里有一段证据\n```js\nconst x = 1;\n```"
  });

  assert.match(block, /^```sidet-research-result/);
  assert.match(block, /round: 2/);
  assert.match(block, /question: 测试研究问题/);
  assert.match(block, /queries: query one \/ query two/);
  assert.match(block, /provider: Bing \+ 百度/);
  assert.match(block, /searchResultCount: 7/);
  assert.match(block, /sourceStart: 3/);
  assert.match(block, /sourceCount: 2/);
  assert.match(block, /\[3\] Page Three — https:\/\/example\.com\/3/);
  assert.match(block, /\[4\] Page Four — https:\/\/example\.com\/4/);
  assert.doesNotMatch(block, /```js/, "evidence fences should be neutralized");
  assert.match(block, /'''js/, "evidence fence should become a safe marker");
  assert.match(block, /这里有一段证据/);
}

function assertResearchPrompts(promptModule) {
  const decisionContext = promptModule.buildSidetResearchDecisionContext();
  assert.match(decisionContext, /sidet-research/);
  assert.match(decisionContext, /question: 更聚焦的研究问题/);
  assert.match(decisionContext, /只能有一个/);
  assert.match(decisionContext, /不要重复已经研究过的问题/);
  assert.match(decisionContext, /\[n\]/);
  assert.match(decisionContext, /来源列表/);
  assert.match(decisionContext, /reason 会直接显示给用户|会直接显示给用户/);

  const repairContext = promptModule.buildSidetResearchRepairContext();
  assert.match(repairContext, /补正/);
  assert.match(repairContext, /sidet-research/);
  assert.match(repairContext, /不要再输出旧协议块/);

  const queryContext = promptModule.buildSidetResearchQueryContext(
    "测试问题",
    new Date(2026, 10, 25, 12, 0, 0),
    4
  );
  assert.match(queryContext, /当前日期：2026年11月25日/);
  assert.match(queryContext, /2 到 4 组/);
  assert.match(queryContext, /每行一组/);
  assert.match(queryContext, /测试问题/);

  const evidenceContext = promptModule.buildSidetResearchEvidenceContext("测试问题", 4000);
  assert.match(evidenceContext, /只使用用户消息里提供的来源/);
  assert.match(evidenceContext, /\[n\]/);
  assert.match(evidenceContext, /已读网页/);
  assert.match(evidenceContext, /4000 字/);

  const finalContext = promptModule.buildSidetResearchFinalAnswerContext({
    hasEvidence: true,
    exhausted: true
  });
  assert.match(finalContext, /联网最终答复/);
  assert.match(finalContext, /sidet-research-result/);
  assert.match(finalContext, /预算/);
  assert.match(finalContext, /来源列表/);

  const emptyFinalContext = promptModule.buildSidetResearchFinalAnswerContext({
    hasEvidence: false,
    exhausted: false
  });
  assert.match(emptyFinalContext, /没有找到可用资料/);

  const finalRepairContext = promptModule.buildSidetResearchFinalAnswerRepairContext();
  assert.match(finalRepairContext, /最终答复修正/);
  assert.match(finalRepairContext, /\[n\]/);
  assert.match(finalRepairContext, /不要编造编号/);
}

async function main() {
  try {
    const protocolModule = await loadBundledModule("src/agent/web-search/sidet-protocol.ts");
    const promptModule = await loadBundledModule("src/agent/prompts/web-search-prompts.ts");
    assertParseResearchBlock(protocolModule);
    assertStripProtocolBlocks(protocolModule);
    assertBuildResearchResultBlock(protocolModule);
    assertResearchPrompts(promptModule);
    console.log("sidet protocol logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
