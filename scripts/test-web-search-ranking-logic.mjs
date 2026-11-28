import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath, prefix) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
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

function createResult(title, slug, host = "docs.example.com", snippet = "") {
  return {
    title,
    url: `https://${host}/${slug}`,
    host,
    snippet
  };
}

function assertUrlCanonicalization(ranking) {
  assert.equal(
    ranking.canonicalizeSearchResultUrl("https://www.example.com/post?id=1&utm_source=x#top"),
    "https://example.com/post?id=1",
    "canonical URLs should drop www, tracking params, and hash"
  );
  assert.equal(
    ranking.canonicalizeSearchResultUrl("https://example.com/post?id=1&fbclid=abc"),
    "https://example.com/post?id=1",
    "canonical URLs should drop share tracking params"
  );
  assert.equal(
    ranking.normalizeSearchResultUrl("https://example.com/post?id=1&utm_source=x#top"),
    "https://example.com/post?id=1",
    "display URLs should keep meaningful params and drop hash/tracking params"
  );
  assert.equal(
    ranking.canonicalizeSearchResultUrl("https://example.com/post?b=2&a=1"),
    "https://example.com/post?a=1&b=2",
    "canonical URLs should sort query params"
  );
  assert.equal(
    ranking.canonicalizeSearchResultUrl("javascript:alert(1)"),
    null,
    "non-http URLs should not be accepted"
  );
}

function assertDateParsing(ranking) {
  const now = new Date(2026, 10, 24, 12, 0, 0);
  assert.equal(
    ranking.parseSearchResultDate("发布于 2026-11-23 10:00", now),
    new Date(2026, 10, 23).getTime(),
    "full dates should parse"
  );
  assert.equal(
    ranking.parseSearchResultDate("11月23日更新", now),
    new Date(2026, 10, 23).getTime(),
    "month-day dates should parse with the current year"
  );
  assert.equal(
    ranking.parseSearchResultDate("3小时前", now),
    now.getTime() - 3 * 60 * 60 * 1000,
    "relative hour dates should parse"
  );
  assert.equal(
    ranking.parseSearchResultDate("昨天", now),
    now.getTime() - 24 * 60 * 60 * 1000,
    "yesterday should parse"
  );
  assert.equal(ranking.parseSearchResultDate("没有日期", now), null, "missing dates should stay null");
  assert.equal(
    ranking.scoreSearchResultFreshness(
      { title: "2026年11月23日 发布", snippet: "" },
      "普通知识问题",
      now
    ),
    0,
    "freshness should only affect queries that ask for recency"
  );
}

function assertRelevanceRanking(ranking) {
  const results = ranking.mergeRankedSearchBatches([
    {
      query: "DeepSeek V4",
      results: [
        createResult("其他新闻", "other", "news.example.com", "无关内容"),
        createResult("DeepSeek V4 发布", "deepseek", "deepseek.com", "上下文提升到 1M")
      ]
    }
  ], {
    now: new Date(2026, 10, 24, 12, 0, 0)
  });

  assert.equal(
    results[0]?.title,
    "DeepSeek V4 发布",
    "query-token relevance should outrank a slightly better raw position"
  );
}

function assertMultiQueryBoost(ranking) {
  const shared = createResult("Shared", "shared", "docs.example.com", "query-a query-b");
  const results = ranking.mergeRankedSearchBatches([
    {
      query: "alpha",
      results: [shared, createResult("A1", "a1")]
    },
    {
      query: "beta",
      results: [shared, createResult("B1", "b1")]
    }
  ]);

  assert.equal(results.length, 3, "duplicate URLs across queries should merge into one row");
  assert.equal(results[0]?.title, "Shared", "a URL hit by multiple queries should rank first");
}

function assertHostDiversity(ranking) {
  const results = ranking.mergeRankedSearchBatches([
    {
      query: "sidet",
      results: [
        createResult("S1", "s1", "same.example.com"),
        createResult("S2", "s2", "same.example.com"),
        createResult("S3", "s3", "same.example.com"),
        createResult("S4", "s4", "same.example.com"),
        createResult("O1", "o1", "other.example.com")
      ]
    }
  ], {
    maxResults: 4,
    perHostLimit: 2
  });

  assert.equal(results.length, 4, "host-diversity selection should still fill the requested result count");
  assert.equal(results[2]?.title, "O1", "a second host should be promoted before the capped host repeats");
  assert.equal(results[3]?.title, "S3", "remaining same-host results should fill the tail");
}

function assertFreshnessBoost(ranking) {
  const now = new Date(2026, 10, 24, 12, 0, 0);
  const results = ranking.mergeRankedSearchBatches([
    {
      query: "最新 发布",
      results: [
        createResult("2019年11月23日 发布", "old"),
        createResult("2026年11月23日 发布", "new")
      ]
    }
  ], { now });

  assert.equal(results[0]?.title, "2026年11月23日 发布", "fresh results should outrank older results for freshness queries");
}

function assertPublishedAtFreshness(ranking) {
  const now = new Date(2026, 10, 24, 12, 0, 0);
  const results = ranking.mergeRankedSearchBatches([
    {
      query: "最新 发布",
      results: [
        createResult("没有日期的旧文章", "old"),
        {
          ...createResult("带 RSS 日期的文章", "new"),
          publishedAt: "2026-11-23"
        }
      ]
    }
  ], { now });

  assert.equal(
    results[0]?.title,
    "带 RSS 日期的文章",
    "RSS/搜索结果的发布日期应参与时效排序"
  );
}

function assertQueryCoverage(ranking) {
  const weather = createResult(
    "汉阴天气预报15天_汉阴天气预报",
    "w",
    "weather.com.cn",
    "汉阴今天晴，最高气温18℃"
  );
  assert.equal(
    ranking.passesQueryCoverage(weather, "汉阴县 天气预报 陕西省"),
    true,
    "真实命中应通过覆盖率闸门"
  );

  const govOverview = createResult(
    "汉阴概况-汉阴县人民政府",
    "gov",
    "hanyin.gov.cn",
    "陕西省安康市汉阴县"
  );
  assert.equal(
    ranking.passesQueryCoverage(govOverview, "汉阴县 天气预报 陕西省"),
    false,
    "只提到地名不能冒充天气答案"
  );

  const calendar = createResult("2026年11月日历", "c", "rili.com.cn", "2026年11月日历查询");
  assert.equal(
    ranking.passesQueryCoverage(calendar, "2026年11月中国十大新闻"),
    false,
    "日期页不应被当成新闻结果"
  );

  const currency = createResult("人民币汇率中间价", "f", "safe.gov.cn", "人民币 美元 汇率 中间价");
  assert.equal(
    ranking.passesQueryCoverage(currency, "人民币 美元 汇率 中间价"),
    true,
    "官方汇率页应保留"
  );

  const dictionary = createResult("best - Cambridge Dictionary", "d", "dictionary.cambridge.org", "best meaning");
  assert.equal(
    ranking.passesQueryCoverage(dictionary, "open source note taking app comparison"),
    false,
    "词典页不应被当成英文查询结果"
  );

  const settings = createResult("Obsidian 设置项 搜索", "s", "docs.obsidian.md", "Obsidian 设置 搜索");
  assert.equal(
    ranking.passesQueryCoverage(settings, "Obsidian 插件 设置 全局搜索"),
    true,
    "覆盖部分查询词的文档页应保留"
  );

  const githubDaily = createResult("GitHubDaily 开源技术教程", "g", "github.com", "分享开源项目");
  assert.equal(
    ranking.passesQueryCoverage(githubDaily, "开源笔记软件 推荐 对比"),
    false,
    "只命中“开源”一个泛词不应算覆盖笔记软件"
  );
}

function assertNearDuplicateTitleDedupe(ranking) {
  const results = ranking.mergeRankedSearchBatches([
    {
      query: "汉阴 天气",
      results: [
        createResult("汉阴今天晴 最高气温18℃ - 中国天气网", "a", "weather.com.cn"),
        createResult("汉阴今天晴 最高气温18℃ - 天气网", "b", "tianqi.com"),
        createResult("汉阴天气预报", "c", "weather.com.cn"),
        createResult("新闻", "d", "site-a.com"),
        createResult("新闻", "e", "site-b.com")
      ]
    }
  ], { now: new Date(2026, 10, 24, 12, 0, 0) });

  const titles = results.map((item) => item.title);
  assert.equal(
    titles.filter((title) => title.startsWith("汉阴今天晴")).length,
    1,
    "同一标题的转载结果只应保留一条"
  );
  assert.equal(
    titles.filter((title) => title === "新闻").length,
    2,
    "过短的通用标题不应被误判为重复"
  );
}

async function assertSearchManyMergesQueries(serviceModule) {
  const shared = createResult("Shared", "shared", "docs.example.com", "query-a query-b");
  const progressMessages = [];
  const service = new serviceModule.WebSearchService({
    getProviders: () => [
      {
        id: "bing",
        label: "Fake",
        search: async (query) => {
          if (query.includes("fail")) {
            throw new Error("boom");
          }
          if (query === "query-a") {
            return [shared, createResult("A1", "a1", "docs.example.com", "query-a A1")];
          }
          return [shared, createResult("B1", "b1", "docs.example.com", "query-b B1")];
        }
      }
    ]
  });

  const payload = await service.searchMany(["query-a", "query-b"], {
    onProgress: (event) => {
      progressMessages.push(event.message);
    }
  });

  assert.equal(payload.results.length, 3, "multi-query search should merge and dedupe results");
  assert.deepEqual(
    payload.results.map((result) => result.title),
    ["Shared", "A1", "B1"],
    "multi-query search should rank the result shared by both queries first"
  );
  assert.equal(payload.providerLabel, "Fake", "multi-query search should preserve the contributing provider label");
  assert(
    progressMessages.some((message) => message.includes("并行执行 2 组搜索词")),
    "multi-query search should report parallel query execution"
  );
  assert(
    progressMessages.some((message) => message.includes("合并去重后保留 3 条结果")),
    "multi-query search should report the merged result count"
  );

  const partial = await service.searchMany(["query-a", "fail-query"]);
  assert.equal(partial.results.length, 2, "a failed query should not drop results from the successful query");

  await assert.rejects(
    service.searchMany(["fail-one", "fail-two"]),
    /关键词/,
    "multi-query search should fail only when every query fails"
  );
}


function assertSourceQualityRanking(ranking) {
  const downloadIntent = ranking.mergeRankedSearchBatches([
    {
      query: "天气 app 下载",
      results: [createResult("天气App下载", "app", "pc6.com", "下载安装")]
    }
  ]);
  assert.equal(
    downloadIntent[0]?.title,
    "天气App下载",
    "an explicit download query should not penalize app stores"
  );

  const docs = ranking.mergeRankedSearchBatches([
    {
      query: "Node.js 文档",
      results: [
        createResult("Node.js 文档博客", "blog", "example.com"),
        createResult("Node.js 文档", "docs", "nodejs.org")
      ]
    }
  ]);
  assert.equal(docs[0]?.title, "Node.js 文档", "official docs should outrank a generic blog");
}

async function main() {
  try {
    const ranking = await loadBundledModule("src/context/web-search-ranking.ts", "sidet-web-search-ranking");
    const serviceModule = await loadBundledModule("src/context/web-search-service.ts", "sidet-web-search-service");

    assertUrlCanonicalization(ranking);
    assertDateParsing(ranking);
    assertRelevanceRanking(ranking);
    assertMultiQueryBoost(ranking);
    assertHostDiversity(ranking);
    assertFreshnessBoost(ranking);
    assertPublishedAtFreshness(ranking);
    assertQueryCoverage(ranking);
    assertNearDuplicateTitleDedupe(ranking);
    assertSourceQualityRanking(ranking);
    await assertSearchManyMergesQueries(serviceModule);

    console.log("web search ranking logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
