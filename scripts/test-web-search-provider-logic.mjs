import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

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
    ["baidu", "sogou", "bing"],
    "Chinese locale should prioritize Baidu, then Sogou, then Bing"
  );
  assert.deepEqual(
    module.getSearchProviderIdsForLanguage("en-US"),
    ["bing", "sogou", "baidu"],
    "Non-Chinese locale should prioritize Bing, then Sogou, then Baidu"
  );
  assert.deepEqual(
    module.getSearchProviderIdsForLanguage("zh-CN", "jiaoyingxing github"),
    ["github", "baidu", "sogou", "bing"],
    "GitHub-focused queries should prepend the GitHub provider"
  );
  assert.deepEqual(
    module.getSearchProviderIdsForLanguage("zh-CN", "开源 仓库"),
    ["baidu", "sogou", "bing"],
    "generic repository wording should no longer be upgraded into a GitHub-specific provider route"
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
          { title: "A1", url: "https://docs.example.com/a1", host: "docs.example.com", snippet: "from A1" },
          { title: "Shared", url: "https://docs.example.com/shared", host: "docs.example.com", snippet: "from A shared" },
          { title: "A2", url: "https://docs.example.com/a2", host: "docs.example.com", snippet: "from A2" },
          { title: "A3", url: "https://docs.example.com/a3", host: "docs.example.com", snippet: "from A3" },
          { title: "A4", url: "https://docs.example.com/a4", host: "docs.example.com", snippet: "from A4" },
          { title: "A5", url: "https://docs.example.com/a5", host: "docs.example.com", snippet: "from A5" },
          { title: "A6", url: "https://docs.example.com/a6", host: "docs.example.com", snippet: "from A6" }
        ]
      },
      {
        id: "baidu",
        label: "Provider B",
        search: async () => [
          { title: "B1", url: "https://docs.example.com/b1", host: "docs.example.com", snippet: "from B1" },
          { title: "Shared", url: "https://docs.example.com/shared", host: "docs.example.com", snippet: "from B shared" },
          { title: "B2", url: "https://docs.example.com/b2", host: "docs.example.com", snippet: "from B2" },
          { title: "B3", url: "https://docs.example.com/b3", host: "docs.example.com", snippet: "from B3" },
          { title: "B4", url: "https://docs.example.com/b4", host: "docs.example.com", snippet: "from B4" },
          { title: "B5", url: "https://docs.example.com/b5", host: "docs.example.com", snippet: "from B5" },
          { title: "B6", url: "https://docs.example.com/b6", host: "docs.example.com", snippet: "from B6" }
        ]
      }
    ]
  });

  const payload = await service.search("sidet");
  assert.equal(payload.providerLabel, "Provider A + Provider B", "aggregated results should preserve contributing provider labels");
  assert.equal(payload.results.length, 12, "aggregated results should now keep up to twelve unique results");
  assert.deepEqual(
    payload.results.map((item) => item.title),
    ["A1", "Shared", "B1", "A2", "B2", "A3", "B3", "A4", "B4", "A5", "B5", "A6"],
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
          snippet: `A${index + 1}`
        }))
      },
      {
        id: "baidu",
        label: "Provider B",
        search: async () => Array.from({ length: 5 }, (_item, index) => ({
          title: `B${index + 1}`,
          url: `https://docs.example.com/b${index + 1}`,
          host: "docs.example.com",
          snippet: `B${index + 1}`
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
              snippet: "C1"
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

async function main() {
  try {
    const module = await loadBundledModule("src/context/web-search-service.ts");
    assertProviderOrder(module);
    assertLegacyImportLinkCompatibility(module);
    await assertAggregatedSearchResults(module);
    await assertCircuitBreaker(module);
    await assertNewsQueryFiltering(module);
    await assertAllProvidersRunInParallel(module);
    console.log("web search provider logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
