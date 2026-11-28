import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-web-search-policy-"));
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

function assertVisibleProcessNotes(module) {
  assert.equal(module.pickVisibleProcessNote(""), null);
  assert.equal(module.pickVisibleProcessNote("reasoning: hidden"), null);
  assert.equal(module.pickVisibleProcessNote("我先去看一下公开资料"), "我先去看一下公开资料。");
}

function assertFallbackSearchPolicy(module) {
  assert.deepEqual(
    module.buildFallbackSearchQueries("帮我查一下 Sidet 最新 release"),
    ["最新 Sidet release", "Sidet 最新 release"],
    "fallback queries should prefer keyword-style search terms"
  );

  assert.deepEqual(
    module.buildFallbackSearchQueries("帮我在 github 上查一下 jiaoyingxing 有哪些产品"),
    ["GitHub jiaoyingxing 产品", "jiaoyingxing 产品"],
    "site-aware fallback queries should keep the site signal while stripping request filler"
  );

  assert.deepEqual(
    module.normalizeSearchQueries(["最近 从网上 新闻？"]),
    ["最近 新闻"],
    "model-provided queries should only receive light cleanup"
  );

  assert.deepEqual(
    module.normalizeSearchQueries(["最近 中国 重大 新闻 跟台湾有关"]),
    ["最近 中国 重大 新闻 台湾"],
    "related-tail wording should collapse into a clean search token instead of polluting the query"
  );

  assert.deepEqual(
    module.normalizeSearchQueries(["GitHub jiaoyingxing 产品"]),
    ["GitHub jiaoyingxing 产品"],
    "already-good keyword queries should stay intact"
  );
}

function assertResearchQuerySanitizer(module) {
  assert.deepEqual(
    module.sanitizeResearchQueries([
      "汉阴 天气",
      "汉阴 天气",
      `汉阴 天气 ${"实况".repeat(30)}`,
      "sidet-action tool: create_note",
      "天气 App 下载",
      "https://example.com/weather",
      "a b c d e f g h i j k"
    ], { limit: 4 }),
    ["汉阴 天气"],
    "整句、协议字段、无关下载词、URL、重复和超长查询都应被丢弃"
  );

  assert.deepEqual(
    module.sanitizeResearchQueries(["天气 App 下载"], {
      limit: 4,
      allowDownloadWords: true
    }),
    ["天气 App 下载"],
    "用户明确要下载时不应误伤下载词"
  );

  assert.deepEqual(
    module.sanitizeResearchQueries(["汉阴 天气", "汉阴 天气预报"], {
      limit: 4,
      previousQueries: ["汉阴天气"]
    }),
    ["汉阴 天气预报"],
    "上一轮试过的查询不应重复执行"
  );

  assert.equal(
    module.normalizeResearchQueryKey("汉阴 天气"),
    module.normalizeResearchQueryKey("汉阴-天气"),
    "去重键应忽略空白和分隔符"
  );

  const attempt = module.buildResearchAttemptSummary(
    "汉阴天气",
    ["汉阴 天气", "汉阴 天气", "汉阴 天气预报"],
    [
      { host: "WWW.A.com", url: "https://a.com/1" },
      { host: "", url: "https://b.com/2" },
      { host: "a.com", url: "https://a.com/3" }
    ],
    2
  );
  assert.deepEqual(attempt.queries, ["汉阴 天气", "汉阴 天气预报"]);
  assert.deepEqual(attempt.hosts, ["a.com", "b.com"]);
  assert.equal(attempt.pageCount, 2);
}

async function main() {
  try {
    const module = await loadBundledModule("src/agent/web-search/web-search-runtime-policy.ts");
    assertVisibleProcessNotes(module);
    assertFallbackSearchPolicy(module);
    assertResearchQuerySanitizer(module);
    console.log("sidet web search runtime policy logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
