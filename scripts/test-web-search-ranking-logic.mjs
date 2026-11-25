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
  const shared = createResult("Shared", "shared");
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

async function assertSearchManyMergesQueries(serviceModule) {
  const shared = createResult("Shared", "shared");
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
            return [shared, createResult("A1", "a1")];
          }
          return [shared, createResult("B1", "b1")];
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
    await assertSearchManyMergesQueries(serviceModule);

    console.log("web search ranking logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
