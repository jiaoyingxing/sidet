import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-prompt-context-"));
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

function assertDateContext(module) {
  const text = module.buildSidetCurrentDateContext(new Date("2026-06-02T10:11:12+08:00"));
  assert.match(text, /当前时间：2026-06-02/);
  assert.match(text, /如果用户提到今天、明天、昨天、最近、最新/);
}

function assertToolPromptMode(module) {
  assert.equal(
    module.resolveSidetFileToolPromptMode({
      text: "帮我保存成一篇笔记"
    }),
    "full",
    "explicit save intent should enable file tool prompt"
  );

  assert.equal(
    module.resolveSidetFileToolPromptMode({
      text: "小红书是什么"
    }),
    "compact",
    "ordinary questions should only carry the lightweight file tool summary"
  );

  assert.equal(
    module.resolveSidetFileToolPromptMode({
      text: "继续",
      requestContextPrefix: "执行模式：把上一个计划推进成一个可确认的单条写入草稿。"
    }),
    "full",
    "execution prefixes that imply writing should enable file tool prompt"
  );

  assert.equal(
    module.resolveSidetFileToolPromptMode({
      text: " "
    }),
    "off",
    "empty inputs should still disable the file tool prompt"
  );
}

function assertJoinContexts(module) {
  const joined = module.joinSidetRequestContexts("A", "B", "A", null, " ");
  assert.equal(joined, "A\n\nB", "request contexts should dedupe and preserve order");
}

async function main() {
  try {
    const module = await loadBundledModule("src/agent/prompts/base-request-context.ts");
    assertDateContext(module);
    assertToolPromptMode(module);
    assertJoinContexts(module);
    console.log("sidet prompt context logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
