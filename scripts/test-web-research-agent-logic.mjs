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
  assert.deepEqual(
    agent.parseResearchQueries(
      '{"intent":"查当地天气","ambiguities":[],"queries":["汉阴 天气","汉阴 天气预报 实况"]}',
      4
    ),
    ["汉阴 天气", "汉阴 天气预报 实况"],
    "the intent-plan JSON object should expose only queries"
  );
  assert.deepEqual(
    agent.parseResearchQueries(
      '```json\n{"intent":"查当地天气","queries":["汉阴 天气"]}\n```',
      4
    ),
    ["汉阴 天气"],
    "fenced intent-plan JSON should be supported"
  );
  assert.deepEqual(
    agent.parseResearchQueries('{"queries":[{"query":"汉阴 天气"},{"q":"汉阴 气温"}]}', 4),
    ["汉阴 天气", "汉阴 气温"],
    "query objects should be tolerated instead of failing the whole plan"
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
          makeResult("https://a.com/1", "Alpha 结果", "alpha snippet"),
          makeResult("https://b.com/1", "Beta 结果", "beta snippet")
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

async function assertRawEvidenceFastPath(agent) {
  const budget = agent.createResearchBudget({
    maxQueries: 4,
    maxPages: 3,
    maxModelCalls: 4
  }, () => 0);
  let compressCalls = 0;
  const result = await agent.runWebResearchRound({
    round: 1,
    question: "测试问题",
    budget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async () => "alpha",
    searchMany: async () => ({
      providerLabel: "Bing",
      results: [makeResult("https://a.com/1", "Alpha 页面", "alpha 短摘要")]
    }),
    fetchPage: async (url) => ({
      title: "A",
      url,
      content: "短正文"
    }),
    compressEvidence: async () => {
      compressCalls += 1;
      return "不应调用压缩";
    },
    evidenceCharLimit: 2_000,
    skipCompressionWhenFits: true
  });

  assert.equal(compressCalls, 0, "small evidence should skip the compression model call");
  assert.equal(budget.modelCalls, 1, "only query expansion should be charged");
  assert.match(result.evidenceText, /已读网页/);
  assert.match(result.evidenceText, /短正文/);
  assert.equal(result.status, "ok");
}

async function assertCompressionStaysBounded(agent) {
  const budget = agent.createResearchBudget({
    maxQueries: 4,
    maxPages: 3,
    maxModelCalls: 4
  }, () => 0);
  let compressCalls = 0;
  const result = await agent.runWebResearchRound({
    round: 1,
    question: "测试问题",
    budget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async () => "alpha",
    searchMany: async () => ({
      providerLabel: "Bing",
      results: [makeResult("https://a.com/1", "Alpha 页面", "alpha 摘要")]
    }),
    fetchPage: async (url) => ({
      title: "A",
      url,
      content: "长正文".repeat(600)
    }),
    compressEvidence: async (_question, _input, maxChars) => {
      compressCalls += 1;
      assert.equal(maxChars, 300, "compression should use the round compression limit");
      return "压缩后的证据 ".repeat(100);
    },
    evidenceCharLimit: 1_000,
    compressionCharLimit: 300,
    skipCompressionWhenFits: true
  });

  assert.equal(compressCalls, 1, "oversized evidence should still be compressed");
  assert.equal(budget.modelCalls, 2, "query expansion and compression should both be charged");
  assert.match(result.evidenceText, /证据已截断/);
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
        makeResult("https://a.com/1", "Alpha 页面"),
        makeResult("https://b.com/1", "Beta 页面"),
        makeResult("https://c.com/1", "Gamma 页面")
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
        results: [makeResult("https://a.com/1", "Alpha 页面")]
      };
    },
    fetchPage: async (url) => ({ title: "Alpha 页面", url, content: "正文" }),
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

function assertRelevantPassages(agent) {
  const markdown = [
    "# 导航",
    "首页 产品 关于我们 登录".repeat(8),
    "",
    "## 背景",
    "这是一段与问题无关的背景介绍，讲的是别的城市和别的年份。".repeat(4),
    "",
    "## 实况",
    "汉阴县今天白天晴，最高气温 18 摄氏度，东南风 2 级。".repeat(3),
    "",
    "页脚 版权 联系方式".repeat(20)
  ].join("\n\n");

  const passages = agent.selectRelevantPassages(markdown, "汉阴 天气 气温", 600);
  assert.match(passages, /最高气温 18 摄氏度/, "相关段落应被保留");
  assert.ok(passages.length <= 600, "相关段落不应超过预算");

  assert.equal(
    agent.extractContentDate("发布时间：2026-11-27 08:00\n正文"),
    "2026-11-27"
  );
  assert.equal(agent.extractContentDate("没有任何日期"), null);
}

async function assertAttemptFeedbackAndQueryGuard(agent) {
  const budget = agent.createResearchBudget({
    maxQueries: 4,
    maxPages: 2,
    maxModelCalls: 4
  }, () => 0);
  let receivedAttempts = null;
  let searchedQueries = null;

  const result = await agent.runWebResearchRound({
    round: 2,
    question: "汉阴 天气",
    budget,
    previousAttempts: [{
      question: "汉阴天气",
      queries: ["汉阴 天气"],
      hosts: ["pc6.com"],
      pageCount: 0
    }],
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async (_question, _maxQueries, attempts) => {
      receivedAttempts = attempts;
      return JSON.stringify({
        intent: "查当地天气",
        answerNeed: "今天的实况与气温",
        queries: [
          "汉阴 天气",
          "汉阴 天气预报",
          `汉阴 天气 ${"实况".repeat(30)}`
        ]
      });
    },
    searchMany: async (queries) => {
      searchedQueries = queries;
      return {
        providerLabel: "Bing",
        results: [{
          ...makeResult("https://a.com/1", "汉阴天气", "今天晴"),
          publishedAt: "2026-11-27"
        }]
      };
    },
    fetchPage: async (url) => ({
      title: "汉阴天气",
      url,
      content: "发布时间：2026-11-27\n\n汉阴今天晴，最高气温 18 摄氏度。"
    }),
    compressEvidence: async () => "不应调用压缩",
    evidenceCharLimit: 2_000,
    skipCompressionWhenFits: true
  });

  assert.deepEqual(
    receivedAttempts.map((attempt) => attempt.hosts[0]),
    ["pc6.com"],
    "上一轮命中站点应回传给检索前理解"
  );
  assert.deepEqual(
    searchedQueries,
    ["汉阴 天气预报"],
    "与上一轮重复、超长的查询应被丢弃后继续执行剩余查询"
  );
  assert.match(result.evidenceText, /日期: 2026-11-27/);
  assert.match(result.evidenceText, /最高气温 18 摄氏度/);
  assert.equal(result.status, "ok");
}

async function assertOffTopicResultsDropped(agent) {
  const budget = agent.createResearchBudget({
    maxQueries: 2,
    maxPages: 2,
    maxModelCalls: 3
  }, () => 0);
  const fetched = [];
  const progress = [];

  const result = await agent.runWebResearchRound({
    round: 1,
    question: "汉阴县 天气预报",
    budget,
    alreadyFetchedUrls: new Set(),
    sourceStart: 1,
    signal: new AbortController().signal,
    expandQueries: async () => "汉阴 天气",
    searchMany: async () => ({
      providerLabel: "Bing",
      results: [
        makeResult("https://weather.com.cn/a", "汉阴天气预报", "汉阴今天晴，最高气温18℃"),
        makeResult("https://rili.com.cn/b", "2026年11月日历", "日历查询"),
        makeResult("https://baike.baidu.com/c", "开源笔记软件", "开源项目介绍")
      ]
    }),
    fetchPage: async (url) => {
      fetched.push(url);
      return { title: "汉阴天气", url, content: "汉阴今天晴" };
    },
    compressEvidence: async () => "结论 [1]",
    onProgress: (event) => progress.push(event)
  });

  assert.equal(result.results.length, 1, "无关结果不应进入候选");
  assert.deepEqual(fetched, ["https://weather.com.cn/a"], "只应读取相关页面");
  assert.ok(
    progress.some((event) => /丢弃 2 条与问题无关的结果/.test(event.message)),
    "过程里应说明丢弃了多少条无关结果"
  );
}

async function main() {
  try {
    const agent = await loadBundledModule("src/agent/web-search/research-agent.ts");
    await assertOffTopicResultsDropped(agent);
    assertBudget(agent);
    assertParseQueries(agent);
    assertSelectPages(agent);
    assertRelevantPassages(agent);
    await assertAttemptFeedbackAndQueryGuard(agent);
    await assertHappyRound(agent);
    await assertRawEvidenceFastPath(agent);
    await assertCompressionStaysBounded(agent);
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
