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

async function main() {
  try {
    const module = await loadBundledModule("src/agent/web-search/web-search-runtime-policy.ts");
    assertVisibleProcessNotes(module);
    assertFallbackSearchPolicy(module);
    console.log("sidet web search runtime policy logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
