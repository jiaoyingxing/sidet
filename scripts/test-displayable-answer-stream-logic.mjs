import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-displayable-answer-"));
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

function assertDisplayableTextHidesProtocol(module) {
  assert.equal(
    module.computeDisplayableAnswerText("先给你结果。\n```sidet-search\nquery: sidet"),
    "先给你结果。",
    "unfinished protocol block should stay hidden from visible text"
  );

  assert.equal(
    module.computeDisplayableAnswerText("```sidet-direct\nreason: 直接回答\n```"),
    "",
    "finished protocol block should be fully stripped from visible text"
  );

  assert.equal(
    module.computeDisplayableAnswerText("这是正文。\n```sidet-direct\nreason: hidden\n```\n补一句。"),
    "这是正文。\n\n补一句。",
    "protocol blocks inside the reply should be stripped while keeping surrounding visible text"
  );
}

function assertProtocolPreambleDetection(module) {
  assert.equal(module.looksLikeSidetProtocolPreamble(""), true);
  assert.equal(module.looksLikeSidetProtocolPreamble("```"), true);
  assert.equal(module.looksLikeSidetProtocolPreamble("```sid"), true);
  assert.equal(module.looksLikeSidetProtocolPreamble("  ```sidet-search"), true);
  assert.equal(module.looksLikeSidetProtocolPreamble("先回答一句"), false);
}

function assertStreamerEmitsVisibleDiffOnly(module) {
  const emitted = [];
  const streamer = module.createDisplayableAnswerStreamer((chunk) => {
    emitted.push(chunk);
  });

  assert.equal(streamer.sync("第一句"), "第一句");
  assert.deepEqual(emitted, ["第一句"]);

  assert.equal(streamer.sync("第一句\n```sidet-search\nquery: sidet"), "第一句");
  assert.deepEqual(emitted, ["第一句"], "unfinished protocol tail should not emit extra visible text");

  assert.equal(
    streamer.finish("第一句\n```sidet-search\nquery: sidet\n```\n第二句"),
    "第一句\n\n第二句"
  );
  assert.deepEqual(
    emitted,
    ["第一句", "\n\n第二句"],
    "finish should only emit the remaining visible diff after protocol blocks are stripped"
  );
}

async function main() {
  try {
    const module = await loadBundledModule("src/agent/web-search/displayable-answer-stream.ts");
    assertDisplayableTextHidesProtocol(module);
    assertProtocolPreambleDetection(module);
    assertStreamerEmitsVisibleDiffOnly(module);
    console.log("displayable answer stream logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
