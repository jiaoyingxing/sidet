import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

// 服务按宿主要求使用 window 定时器（弹窗窗口兼容）；Node 测试提供最小等价物。
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-web-search-logic-"));
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

function assertProviderOrder(module) {
  assert.deepEqual(
    module.getSearchProviderIdsForLanguage("zh-CN"),
    ["quark", "bing"],
    "Chinese locale should use Quark mobile plus Bing"
  );
  assert.deepEqual(
    module.getSearchProviderIdsForLanguage("en-US"),
    ["bing", "mwmbl"],
    "Non-Chinese locale should use Bing plus Mwmbl"
  );
  assert.deepEqual(
    module.getSearchProviderIdsForLanguage("zh-CN", "jiaoyingxing github"),
    ["github", "quark", "bing"],
    "GitHub-focused queries should prepend the GitHub provider"
  );
  assert.deepEqual(
    module.getSearchProviderIdsForLanguage("zh-CN", "开源 仓库"),
    ["quark", "bing"],
    "generic repository wording should no longer be upgraded into a GitHub-specific provider route"
  );

  assert.equal(
    module.resolveQuarkResultUrl('{"u":"https://www.weather.com.cn/weather/101110704.shtml"}', ""),
    "https://www.weather.com.cn/weather/101110704.shtml",
    "Quark data-sc target URLs should be used"
  );
  assert.equal(
    module.resolveQuarkResultUrl('{"u":"https://quark.sm.cn/s?q=test"}', ""),
    null,
    "Quark internal links should not become sources"
  );

  assert.equal(
    module.resolveSoResultUrl("https://m.so.com/jump?u=https%3A%2F%2Fm.weather.com.cn%2Fmweather%2F101110704.shtml&m=ca529c&from=m.so.com"),
    "https://m.weather.com.cn/mweather/101110704.shtml",
    "360 jump links should resolve to the target URL"
  );
  assert.equal(module.resolveSoResultUrl("https://m.so.com/s?q=test"), null);
  assert.equal(
    module.resolveSoResultUrl("https://m.so.com/jump?u=https%3A%2F%2Fm.so.com%2Fs%3Fq%3Dtest"),
    null,
    "360 internal links should not become sources"
  );
}

function assertLegacyImportLinkCompatibility(module) {
  const targetUrl = "https://example.com/docs?id=1#section";
  const link = `https://sidet.invalid/web-search-import?url=${encodeURIComponent(targetUrl)}`;
  const parsed = module.parseWebSearchImportLink(link);
  assert.equal(parsed, "https://example.com/docs?id=1", "legacy search import links should keep opening normalized target URLs");
  assert.equal(module.parseWebSearchImportLink("https://example.com"), null, "non import links should be ignored");
}

async function assertAggregatedSearchResults(module) {
  const service = new module.WebSearchService({
    getProviders: () => [
      {
        id: "bing",
        label: "Provider A",
        search: async () => [
          { title: "A1", url: "https://docs.example.com/a1", host: "docs.example.com", snippet: "sidet from A1" },
          { title: "Shared", url: "https://docs.example.com/shared", host: "docs.example.com", snippet: "sidet from A shared" },
          { title: "A2", url: "https://docs.example.com/a2", host: "docs.example.com", snippet: "sidet from A2" },
          { title: "A3", url: "https://docs.example.com/a3", host: "docs.example.com", snippet: "sidet from A3" },
          { title: "A4", url: "https://docs.example.com/a4", host: "docs.example.com", snippet: "sidet from A4" },
          { title: "A5", url: "https://docs.example.com/a5", host: "docs.example.com", snippet: "sidet from A5" },
          { title: "A6", url: "https://docs.example.com/a6", host: "docs.example.com", snippet: "sidet from A6" }
        ]
      },
      {
        id: "baidu",
        label: "Provider B",
        search: async () => [
          { title: "B1", url: "https://docs.example.com/b1", host: "docs.example.com", snippet: "sidet from B1" },
          { title: "Shared", url: "https://docs.example.com/shared", host: "docs.example.com", snippet: "sidet from B shared" },
          { title: "B2", url: "https://docs.example.com/b2", host: "docs.example.com", snippet: "sidet from B2" },
          { title: "B3", url: "https://docs.example.com/b3", host: "docs.example.com", snippet: "sidet from B3" },
          { title: "B4", url: "https://docs.example.com/b4", host: "docs.example.com", snippet: "sidet from B4" },
          { title: "B5", url: "https://docs.example.com/b5", host: "docs.example.com", snippet: "sidet from B5" },
          { title: "B6", url: "https://docs.example.com/b6", host: "docs.example.com", snippet: "sidet from B6" }
        ]
      }
    ]
  });

  const payload = await service.search("sidet");
  assert.equal(payload.providerLabel, "Provider A + Provider B", "aggregated results should preserve contributing provider labels");
  assert.equal(payload.results.length, 12, "aggregated results should now keep up to twelve unique results");
  assert.deepEqual(
    payload.results.map((item) => item.title),
    ["Shared", "A1", "B1", "A2", "B2", "A3", "B3", "A4", "B4", "A5", "B5", "A6"],
    "aggregated results should merge providers, rank multi-provider hits first, dedupe shared URLs, and expand beyond six results"
  );
}

async function assertCircuitBreaker(module) {
  let failingCalls = 0;
  let stableCalls = 0;
  let currentTime = 1000;
  const progressMessages = [];
  const service = new module.WebSearchService({
    now: () => currentTime,
    getProviders: () => [
      {
        id: "bing",
        label: "Failing Provider",
        search: async () => {
          failingCalls += 1;
          throw new Error("net::ERR_CONNECTION_TIMED_OUT");
        }
      },
      {
        id: "baidu",
        label: "Stable Provider",
        search: async (query) => {
          stableCalls += 1;
          return [
            {
              title: `Result ${query}`,
              url: `https://docs.example.com/${query}`,
              host: "docs.example.com",
              snippet: `snippet for ${query}`
            }
          ];
        }
      }
    ]
  });

  await service.search("query-one");
  currentTime += 1;
  await service.search("query-two");
  currentTime += 1;
  await service.search("query-three", {
    onProgress: (event) => {
      progressMessages.push(event.message);
    }
  });

  assert.equal(failingCalls, 2, "provider should stop being called after entering cooldown");
  assert.equal(stableCalls, 3, "stable provider should keep serving searches");
  assert(
    progressMessages.some((message) => message.includes("暂时跳过")),
    "cooldown skip should be reported in progress messages"
  );
}

async function assertNewsQueryFiltering(module) {
  const service = new module.WebSearchService({
    getProviders: () => [
      {
        id: "bing",
        label: "Provider A",
        search: async () => [
          {
            title: "最近",
            url: "https://dict.youdao.com/result?word=%E6%9C%80%E8%BF%91",
            host: "dict.youdao.com",
            snippet: "最近 的 释义"
          },
          {
            title: "中国台湾网今日台湾新闻 最新",
            url: "https://news.example.com/taiwan-latest",
            host: "news.example.com",
            snippet: "两岸新闻滚动更新"
          }
        ]
      }
    ]
  });

  const payload = await service.search("最近 中国 重大 新闻 台湾");
  assert.equal(payload.results.length, 1, "news queries should drop obvious dictionary-style noise results");
  assert.equal(payload.results[0]?.host, "news.example.com");
}

async function assertAllProvidersRunInParallel(module) {
  let providerCCalls = 0;
  const service = new module.WebSearchService({
    getProviders: () => [
      {
        id: "bing",
        label: "Provider A",
        search: async () => Array.from({ length: 5 }, (_item, index) => ({
          title: `A${index + 1}`,
          url: `https://docs.example.com/a${index + 1}`,
          host: "docs.example.com",
          snippet: `sidet A${index + 1}`
        }))
      },
      {
        id: "baidu",
        label: "Provider B",
        search: async () => Array.from({ length: 5 }, (_item, index) => ({
          title: `B${index + 1}`,
          url: `https://docs.example.com/b${index + 1}`,
          host: "docs.example.com",
          snippet: `sidet B${index + 1}`
        }))
      },
      {
        id: "sogou",
        label: "Provider C",
        search: async () => {
          providerCCalls += 1;
          return [
            {
              title: "C1",
              url: "https://docs.example.com/c1",
              host: "docs.example.com",
              snippet: "sidet C1"
            }
          ];
        }
      }
    ]
  });

  const payload = await service.search("sidet");
  assert.equal(payload.results.length, 11, "all providers should contribute to the same merged result set");
  assert.equal(providerCCalls, 1, "search should query every healthy provider instead of stopping early");
}

function assertMwmblParsing(module) {
  const results = module.parseMwmblResults([
    {
      url: "https://itsfoss.com/notes-app-linux/",
      title: [{ value: "Notes: A Clean " }, { value: "Open Source" }],
      extract: [{ value: "The search feature is powerful." }]
    },
    {
      url: "https://itsfoss.com/notes-app-linux/",
      title: [{ value: "duplicate" }]
    },
    {
      url: "https://example.com/no-title",
      title: []
    }
  ]);

  assert.equal(results.length, 1, "Mwmbl 应去重并跳过无标题条目");
  assert.equal(results[0].title, "Notes: A Clean Open Source");
  assert.equal(results[0].host, "itsfoss.com");
  assert.match(results[0].snippet, /search feature/);
  assert.deepEqual(module.parseMwmblResults(null), []);
}

function assertBingRssParsing(module) {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<rss version=\"2.0\"><channel>",
    "<item>",
    "<title>汉阴天气 - 中国天气网</title>",
    "<link>https://weather.com.cn/a?x=1&amp;y=2</link>",
    "<description><![CDATA[汉阴今天晴，<b>18℃</b>]]></description>",
    "<pubDate>Fri, 27 Nov 2026 08:00:00 GMT</pubDate>",
    "</item>",
    "<item>",
    "<title>重复条目</title>",
    "<link>https://weather.com.cn/a?x=1&y=2</link>",
    "<description>dup</description>",
    "</item>",
    "<item>",
    "<title>没有链接</title>",
    "<description>no link</description>",
    "</item>",
    "<item>",
    "<title>中文日期条目</title>",
    "<link>https://weather.com.cn/b</link>",
    "<description>中文 pubDate</description>",
    "<pubDate>周五, 27 11月 2026 09:59:00 GMT</pubDate>",
    "</item>",
    "</channel></rss>"
  ].join("");

  const results = module.parseBingRssResults(xml);
  assert.equal(results.length, 2, "RSS 应去重并跳过缺链接条目");
  assert.equal(results[0].title, "汉阴天气 - 中国天气网");
  assert.equal(results[0].url, "https://weather.com.cn/a?x=1&y=2");
  assert.match(results[0].snippet, /18℃/, "描述里的 HTML 应被去掉");
  assert.equal(results[0].publishedAt, "2026-11-27");
  assert.equal(
    results.find((item) => item.url === "https://weather.com.cn/b")?.publishedAt,
    "2026-11-27",
    "中文 pubDate 也应解析成 YYYY-MM-DD"
  );
  assert.deepEqual(module.parseBingRssResults("<html>not rss</html>"), []);
}

async function assertProviderGracePeriod(module) {
  let resolveSlow = () => {};
  const service = new module.WebSearchService({
    getProviders: () => [
      {
        id: "bing",
        label: "Fast",
        search: async () => [{
          title: "Fast",
          url: "https://fast.example.com/1",
          host: "fast.example.com",
          snippet: "grace ok"
        }]
      },
      {
        id: "baidu",
        label: "Slow",
        search: () => new Promise((resolve) => {
          resolveSlow = resolve;
        })
      }
    ]
  });

  const startedAt = Date.now();
  const payload = await service.search("grace", { providerGraceMs: 30 });
  const elapsed = Date.now() - startedAt;
  assert.equal(payload.results.length, 1, "已有来源返回时不应被卡住的来源拖住");
  assert.ok(elapsed < 500, "宽限期应远小于 6 秒来源超时");
  resolveSlow([]);
}

async function assertPartialProviderFailureDoesNotReject(module) {
  const service = new module.WebSearchService({
    getProviders: () => [
      {
        id: "bing",
        label: "Broken",
        search: async () => {
          throw new Error("captcha");
        }
      },
      {
        id: "baidu",
        label: "Empty",
        search: async () => []
      }
    ]
  });

  const payload = await service.search("sidet query");
  assert.equal(
    payload.results.length,
    0,
    "有来源正常应答但没有结果时，不应把另一个来源的失败升级成整组查询失败"
  );

  const allBroken = new module.WebSearchService({
    getProviders: () => [
      { id: "bing", label: "Broken A", search: async () => { throw new Error("captcha a"); } },
      { id: "baidu", label: "Broken B", search: async () => { throw new Error("captcha b"); } }
    ]
  });
  await assert.rejects(
    allBroken.search("sidet query"),
    /captcha/,
    "全部来源都失败时仍应抛错"
  );
}

async function main() {
  try {
    const module = await loadBundledModule("src/context/web-search-service.ts");
    assertProviderOrder(module);
    assertLegacyImportLinkCompatibility(module);
    assertBingRssParsing(module);
    assertMwmblParsing(module);
    await assertAggregatedSearchResults(module);
    await assertCircuitBreaker(module);
    await assertNewsQueryFiltering(module);
    await assertAllProvidersRunInParallel(module);
    await assertProviderGracePeriod(module);
    await assertPartialProviderFailureDoesNotReject(module);
    console.log("web search provider logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
