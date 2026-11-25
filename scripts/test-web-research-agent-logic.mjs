import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-web-research-agent-"));
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

function makeResult(url, title = url, snippet = "摘要") {
  try {
    return {
      title,
      url,
      host: new URL(url).hostname,
      snippet
    };
  } catch {
    return { title, url, host: "", snippet };
  }
}

function assertBudget(agent) {
  let now = 1_000;
  const budget = agent.createResearchBudget({
    maxRounds: 3,
    maxQueries: 12,
    maxPages: 9,
    maxWallClockMs: 120_000,
    maxModelCalls: 11
  }, () => now);

  assert.equal(budget.chargeQueries(4), 4);
  assert.equal(budget.chargeQueries(10), 8, "query budget should cap the requested count");
  assert.equal(budget.remainingQueries(), 0);
  assert.equal(budget.chargePages(3), 3);
  assert.equal(budget.chargePages(10), 6, "page budget should cap the requested count");
  assert.equal(budget.remainingPages(), 0);

  const roundBudget = agent.createResearchBudget({
    maxRounds: 2,
    maxQueries: 10,
    maxPages: 10,
    maxWallClockMs: 1_000,
    maxModelCalls: 10
  }, () => 0);
  assert.equal(roundBudget.chargeRound(), true);
  assert.equal(roundBudget.chargeRound(), true);
  assert.equal(roundBudget.chargeRound(), false, "round budget should stop after maxRounds");
  assert.match(roundBudget.exhaustedReason(), /2 轮/);

  const modelBudget = agent.createResearchBudget({ maxModelCalls: 2 }, () => 0);
  assert.equal(modelBudget.chargeModelCall(), true);
  assert.equal(modelBudget.chargeModelCall(), true);
  assert.equal(modelBudget.chargeModelCall(), false, "model call budget should be a hard guard");

  let clock = 0;
  const timeBudget = agent.createResearchBudget({ maxWallClockMs: 100 }, () => clock);
  assert.equal(timeBudget.isExpired(), false);
  clock = 150;
  assert.equal(timeBudget.isExpired(), true);
  assert.match(timeBudget.exhaustedReason(), /秒/);
}

function assertParseQueries(agent) {
  assert.deepEqual(
    agent.parseResearchQueries("query1: alpha\nquery2: beta\nquery3: alpha", 4),
    ["alpha", "beta"],
    "query prefixes and duplicates should be removed"
  );
  assert.deepEqual(
    agent.parseResearchQueries("- one\n2. two\n* three", 4),
    ["one", "two", "three"],
    "bullets and numbering should be removed"
  );
  assert.deepEqual(
    agent.parseResearchQueries('["alpha", "beta", "alpha"]', 4),
    ["alpha", "beta"],
    "JSON arrays should be supported"
  );
  assert.deepEqual(agent.parseResearchQueries("1. a\n2. b\n3. c", 2), ["a", "b"]);
  assert.deepEqual(agent.parseResearchQueries("", 4), []);
  assert.deepEqual(agent.parseResearchQueries("搜索词：\n查询：\n", 4), []);
}

function assertSelectPages(agent) {
  const results = [
    makeResult("https://a.com/1", "A1"),
    makeResult("https://a.com/2", "A2"),
    makeResult("https://b.com/1", "B1"),
    makeResult("https://c.com/file.pdf", "PDF"),
    makeResult("https://c.com/1", "C1"),
    makeResult("ftp://d.com/1", "FTP")
  ];

  const selected = agent.selectResearchPages(
    results,
    new Set(["https://a.com/1"]),
    3
  );
  assert.deepEqual(
    selected.map((item) => item.url),
    ["https://b.com/1", "https://c.com/1", "https://a.com/2"],
    "already fetched, binary and non-http results should be skipped; distinct hosts should come first"
  );

  const limited = agent.selectResearchPages(results, new Set(), 1);
  assert.deepEqual(limited.map((item) => item.url), ["https://a.com/1"]);

  const hashDuplicate = agent.selectResearchPages(
    [makeResult("https://a.com/1"), makeResult("https://a.com/1#section")],
    new Set(["https://a.com/1"]),
    3
  );
  assert.deepEqual(hashDuplicate, [], "URL hashes should not bypass already-fetched checks");
}

async function assertHappyRound(agent) {
  const budget = agent.createResearchBudget({
    maxRounds: 1,
    maxQueries: 4,
    maxPages: 3,
    maxModelCalls: 4,
    maxSourceInputChars: 10_000,
    maxPageContentChars: 5_000
  }, () => 0);
  const progress = [];
  const searchCalls = [];
  const fetchCalls = [];

  const result = await agent.runWebResearchRound({
    round: 1,
    question: "测试问题",
    budget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async () => "query1: alpha\nquery2: beta\nquery3: alpha",
    searchMany: async (queries, onProgress) => {
      searchCalls.push(queries);
      onProgress?.({ message: "搜索进度" });
      return {
        providerLabel: "Bing + 百度",
        results: [
          makeResult("https://a.com/1", "A", "a snippet"),
          makeResult("https://b.com/1", "B", "b snippet")
        ]
      };
    },
    fetchPage: async (url) => {
      fetchCalls.push(url);
      return {
        title: url.includes("a.com") ? "Page A" : "Page B",
        url,
        content: `正文 ${url}`
      };
    },
    compressEvidence: async (_question, input) => `结论：已经读到正文 [1]\n输入长度 ${input.length}`,
    onProgress: (event) => progress.push(event)
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.queries, ["alpha", "beta"]);
  assert.equal(result.providerLabel, "Bing + 百度");
  assert.equal(result.results.length, 2);
  assert.equal(result.pages.length, 2);
  assert.deepEqual(result.pages.map((page) => page.sourceIndex), [1, 2]);
  assert.deepEqual(fetchCalls, ["https://a.com/1", "https://b.com/1"]);
  assert.equal(searchCalls.length, 1);
  assert.deepEqual(searchCalls[0], ["alpha", "beta"]);
  assert.match(result.evidenceText, /\[1\]/);
  assert.match(result.resultBlock, /sourceStart: 1/);
  assert.match(result.resultBlock, /sourceCount: 2/);
  assert.equal(result.failedPageCount, 0);
  assert.ok(progress.some((event) => event.stage === "done"));
  assert.equal(budget.queries, 2);
  assert.equal(budget.pages, 2);
  assert.equal(budget.modelCalls, 2, "query expansion and evidence compression should both be charged");
}

async function assertExpansionFallback(agent) {
  const budget = agent.createResearchBudget({
    maxQueries: 4,
    maxPages: 2,
    maxModelCalls: 4
  }, () => 0);
  const searchCalls = [];
  const progress = [];
  const result = await agent.runWebResearchRound({
    round: 1,
    question: "GitHub 最新热门项目",
    budget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async () => {
      throw new Error("model down");
    },
    searchMany: async (queries) => {
      searchCalls.push(queries);
      return {
        providerLabel: "GitHub + Bing",
        results: [makeResult("https://github.com/trending", "GitHub Trending", "热门项目")]
      };
    },
    fetchPage: async (url) => {
      throw new Error("fetch failed");
    },
    compressEvidence: async () => "",
    onProgress: (event) => progress.push(event)
  });

  assert.ok(searchCalls.length > 0, "fallback queries should still reach the search service");
  assert.ok(searchCalls[0].length > 0);
  assert.equal(result.status, "partial", "search-only evidence should be partial");
  assert.match(result.evidenceText, /搜索摘要|未逐页核对/);
  assert.ok(progress.some((event) => /查询扩展失败/.test(event.message)));
  assert.ok(progress.some((event) => /证据整理为空/.test(event.message)));
}

async function assertAllSearchFails(agent) {
  const budget = agent.createResearchBudget({ maxQueries: 4, maxPages: 3, maxModelCalls: 4 }, () => 0);
  let fetchCalled = false;
  let compressCalled = false;
  const result = await agent.runWebResearchRound({
    round: 1,
    question: "测试问题",
    budget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async () => "alpha",
    searchMany: async () => {
      throw new Error("all providers failed");
    },
    fetchPage: async () => {
      fetchCalled = true;
      throw new Error("should not fetch");
    },
    compressEvidence: async () => {
      compressCalled = true;
      return "should not compress";
    }
  });

  assert.equal(result.status, "empty");
  assert.equal(result.results.length, 0);
  assert.equal(result.pages.length, 0);
  assert.match(result.searchError, /all providers failed/);
  assert.match(result.evidenceText, /没有找到可用结果/);
  assert.equal(fetchCalled, false);
  assert.equal(compressCalled, false, "empty search should not spend a compression model call");
}

async function assertPartialFetch(agent) {
  const budget = agent.createResearchBudget({ maxQueries: 4, maxPages: 3, maxModelCalls: 4 }, () => 0);
  const result = await agent.runWebResearchRound({
    round: 1,
    question: "测试问题",
    budget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 5,
    signal: new AbortController().signal,
    expandQueries: async () => "alpha\nbeta\ngamma",
    searchMany: async () => ({
      providerLabel: "Bing",
      results: [
        makeResult("https://a.com/1", "A"),
        makeResult("https://b.com/1", "B"),
        makeResult("https://c.com/1", "C")
      ]
    }),
    fetchPage: async (url) => {
      if (url.includes("b.com")) {
        throw new Error("blocked");
      }
      return { title: url, url, content: `正文 ${url}` };
    },
    compressEvidence: async () => "证据 [5] [6]"
  });

  assert.equal(result.status, "ok");
  assert.equal(result.pages.length, 2);
  assert.equal(result.failedPageCount, 1);
  assert.deepEqual(result.pages.map((page) => page.sourceIndex), [5, 6]);
  assert.match(result.resultBlock, /sourceStart: 5/);
}

async function assertBudgetAndAbort(agent) {
  const zeroBudget = agent.createResearchBudget({ maxQueries: 0 }, () => 0);
  let searchCalled = false;
  const noBudgetResult = await agent.runWebResearchRound({
    round: 1,
    question: "测试问题",
    budget: zeroBudget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async () => "alpha",
    searchMany: async () => {
      searchCalled = true;
      return { providerLabel: "Bing", results: [] };
    },
    fetchPage: async () => ({ title: "", url: "", content: "" }),
    compressEvidence: async () => ""
  });
  assert.equal(noBudgetResult.status, "empty");
  assert.equal(searchCalled, false, "exhausted query budget should stop before searching");

  const chargedBudget = agent.createResearchBudget({
    maxRounds: 1,
    maxQueries: 4,
    maxPages: 2,
    maxModelCalls: 4
  }, () => 0);
  assert.equal(chargedBudget.chargeRound(), true, "the loop should charge the round before calling the agent");
  let chargedSearchCalled = false;
  const chargedRoundResult = await agent.runWebResearchRound({
    round: 1,
    question: "已扣轮次的问题",
    budget: chargedBudget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async () => "alpha",
    searchMany: async () => {
      chargedSearchCalled = true;
      return {
        providerLabel: "Bing",
        results: [makeResult("https://a.com/1", "A")]
      };
    },
    fetchPage: async (url) => ({ title: "A", url, content: "正文" }),
    compressEvidence: async () => "证据 [1]"
  });
  assert.equal(chargedSearchCalled, true, "a charged round should still run inside the agent");
  assert.equal(chargedRoundResult.status, "ok");

  const controller = new AbortController();
  const abortBudget = agent.createResearchBudget({ maxQueries: 4, maxPages: 3, maxModelCalls: 4 }, () => 0);
  const abortResult = await agent.runWebResearchRound({
    round: 1,
    question: "测试问题",
    budget: abortBudget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: controller.signal,
    expandQueries: async () => "alpha",
    searchMany: async () => {
      controller.abort();
      return { providerLabel: "Bing", results: [makeResult("https://a.com/1", "A")] };
    },
    fetchPage: async () => ({ title: "A", url: "https://a.com/1", content: "正文" }),
    compressEvidence: async () => "证据"
  });
  assert.equal(abortResult.status, "empty");
  assert.match(abortResult.evidenceText, /已取消/);
}

async function main() {
  try {
    const agent = await loadBundledModule("src/agent/web-search/research-agent.ts");
    assertBudget(agent);
    assertParseQueries(agent);
    assertSelectPages(agent);
    await assertHappyRound(agent);
    await assertExpansionFallback(agent);
    await assertAllSearchFails(agent);
    await assertPartialFetch(agent);
    await assertBudgetAndAbort(agent);
    console.log("web research agent logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
