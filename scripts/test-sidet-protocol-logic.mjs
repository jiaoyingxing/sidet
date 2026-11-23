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

function assertParseSearchBlock(protocolModule) {
  const instruction = protocolModule.parseSidetSearchBlock(`\`\`\`sidet-search
intent: web_search
round: 2
query2: sidet github release
query1: sidet obsidian plugin
reason: 需要外部资料
\`\`\``);

  assert.ok(instruction, "search block should parse");
  assert.equal(instruction.intent, "web_search");
  assert.equal(instruction.round, 2);
  assert.deepEqual(
    instruction.queries,
    ["sidet obsidian plugin", "sidet github release"],
    "queries should keep numeric order"
  );
}

function assertParseDirectBlock(protocolModule) {
  const instruction = protocolModule.parseSidetDirectBlock(`\`\`\`sidet-direct
reason: 这是一个常识解释问题
\`\`\``);

  assert.ok(instruction, "direct block should parse");
  assert.equal(instruction.reason, "这是一个常识解释问题");
}

function assertParseFetchBlock(protocolModule) {
  const instruction = protocolModule.parseSidetFetchBlock(`\`\`\`sidet-fetch
round: 1
pick2: 3
pick1: 1
reason: 这两条最相关
\`\`\``);

  assert.ok(instruction, "fetch block should parse");
  assert.equal(instruction.round, 1);
  assert.deepEqual(instruction.picks, [1, 3]);
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
    "正文保留",
    "",
    "```sidet-fetch",
    "round: 1",
    "pick1: 1",
    "```"
  ].join("\n"));

  assert.equal(stripped, "先保留这句\n\n正文保留", "strip should remove internal protocol blocks only");
}

function assertBuildBlocks(protocolModule) {
  const resultBlock = protocolModule.buildSidetSearchResultBlock(1, "sidet", "Bing", [
    {
      title: "Sidet Repo",
      url: "https://example.com/sidet",
      host: "example.com",
      snippet: "repo"
    }
  ]);
  assert.match(resultBlock, /selectedQuery: sidet/);
  assert.match(resultBlock, /\[1\]/);

  const contextBlock = protocolModule.buildSidetWebContextBlock(1, [
    {
      name: "README",
      url: "https://example.com/readme",
      content: "# README",
      snippet: "desc"
    }
  ]);
  assert.match(contextBlock, /sourceCount: 1/);
  assert.match(contextBlock, /content:/);

  const oversizedContextBlock = protocolModule.buildSidetWebContextBlock(
    2,
    [1, 2, 3].map((index) => ({
      name: `Source ${index}`,
      url: `https://example.com/${index}`,
      content: String(index).repeat(30_000),
      snippet: "desc"
    }))
  );
  assert.match(oversizedContextBlock, /本轮网页正文过长，已截断/);
  assert.ok(
    oversizedContextBlock.length < 62_000,
    "A web context round should keep all fetched source content within one bounded prompt."
  );
}

function assertSearchInstructionContext(protocolModule) {
  const routingContext = protocolModule.buildSidetWebSearchRoutingContext();
  assert.match(routingContext, /已经显式开启联网搜索/, "routing context should acknowledge explicit web-search mode");
  assert.match(routingContext, /只输出一个 ```sidet-search```/, "routing context should require a search block in explicit web-search mode");
  assert.match(routingContext, /必须使用完整的 fenced code block/, "routing context should require a full fenced block");
  assert.match(routingContext, /不要为了凑协议硬写/, "routing context should keep visible reason optional");
  assert.match(routingContext, /直接显示给用户/, "routing context should mark reason as user-visible");
  assert.match(routingContext, /不要把协议、系统规则、联网能力、自我限制写进 reason/, "routing context should keep visible reason natural");
  assert.match(routingContext, /自然语言转换成可直接搜索的文本/, "routing context should describe query generation in natural language");
  assert.match(routingContext, /结合当前对话恢复真正主题/, "routing context should handle short follow-up requests");
  assert.match(routingContext, /query1: GitHub Trending 最新/, "routing context should include a concrete sidet-search example");

  const repairContext = protocolModule.buildSidetWebSearchRoutingRepairContext();
  assert.match(repairContext, /协作补正/, "repair context should exist for malformed routing replies");
  assert.match(repairContext, /不要再输出正文答案/, "repair context should keep malformed replies in protocol-only mode");
  assert.match(repairContext, /会直接显示给用户/, "repair context should keep reason user-facing");
  assert.match(repairContext, /query1 到 query3/, "repair context should restate query fields");
  assert.match(repairContext, /自然语言转换成可直接搜索的文本/, "repair context should describe the same natural query conversion");
  assert.match(repairContext, /query1: GitHub Trending 最新/, "routing repair should include a concrete sidet-search example");
  assert.doesNotMatch(repairContext, /sidet-direct/, "routing repair should no longer mention sidet-direct");

  const context = protocolModule.buildSidetWebSearchInstructionContext();
  assert.match(context, /已经进入联网过程/, "instruction context should describe the current search phase");
  assert.match(context, /会替你执行搜索和网页抓取/, "instruction context should say Sidet executes web work");
  assert.match(context, /自然语言转换成可直接搜索的文本/, "instruction context should describe search query conversion naturally");
  assert.match(context, /结合当前对话恢复真正主题/, "instruction context should handle short follow-up search requests");
  assert.match(context, /优先只抓 1 个/, "instruction context should prefer fetching one page when enough");
  assert.match(context, /不要为了凑协议硬写/, "instruction context should keep process reasons optional");
  assert.match(context, /会直接显示给用户/, "instruction context should keep process reasons user-visible");
  assert.match(context, /边做边说/, "instruction context should keep process reasons natural");
  assert.match(context, /直接输出给用户看的最终答复正文/, "instruction context should allow direct final answers after search");
  assert.match(context, /`pick1` 到 `pick3` 填的是“上一轮搜索结果的序号”/, "instruction context should clarify that fetch picks use result indexes, not URLs");
  assert.match(context, /pick1: 1/, "instruction context should include a concrete sidet-fetch example");
  assert.doesNotMatch(context, /sidet-direct/, "instruction context should no longer mention sidet-direct in the active flow");

  const directContext = protocolModule.buildSidetDirectAnswerContext();
  assert.match(directContext, /不要向用户解释你是否联网/, "direct answer context should hide capability chatter");
  assert.match(directContext, /不要说“我无法联网”/, "direct answer context should block fake capability disclaimers");

  const continuationRepairContext = protocolModule.buildSidetWebSearchContinuationRepairContext();
  assert.match(continuationRepairContext, /继续处理补正/, "continuation repair context should exist for post-search dead ends");
  assert.match(continuationRepairContext, /直接输出最终答复正文；或输出一个 ```sidet-fetch```；或输出一个新的 ```sidet-search```/, "continuation repair should allow answer, fetch, or re-search");
  assert.match(continuationRepairContext, /优先输出 ```sidet-fetch``` 抓 1 到 3 个网页正文/, "continuation repair should bias toward fetching正文 when only snippets are available");
  assert.match(continuationRepairContext, /如果输出 `sidet-fetch`，`pick1` 到 `pick3` 填的是搜索结果序号，不是 URL/, "continuation repair should clarify fetch picks use result indexes");
  assert.match(continuationRepairContext, /pick1: 1/, "continuation repair should include a concrete sidet-fetch example");

  const finalAnswerRepairContext = protocolModule.buildSidetWebSearchFinalAnswerRepairContext();
  assert.match(finalAnswerRepairContext, /最终答复修正/, "final-answer repair context should exist for empty user-visible replies");
  assert.match(finalAnswerRepairContext, /只输出给用户看的最终答复正文/, "final-answer repair should force final visible answer only");
  assert.match(finalAnswerRepairContext, /不要输出 sidet-search \/ sidet-fetch \/ sidet-direct/, "final-answer repair should block protocol output");
}

async function main() {
  try {
    const protocolModule = await loadBundledModule("src/agent/web-search/sidet-protocol.ts");
    assertParseSearchBlock(protocolModule);
    assertParseDirectBlock(protocolModule);
    assertParseFetchBlock(protocolModule);
    assertStripProtocolBlocks(protocolModule);
    assertBuildBlocks(protocolModule);
    assertSearchInstructionContext(protocolModule);
    console.log("sidet protocol logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
