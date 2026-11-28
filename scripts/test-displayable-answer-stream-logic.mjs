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

  assert.equal(
    module.computeDisplayableAnswerText("示例：\n```js\nconst a = 1;\n```"),
    "示例：\n```js\nconst a = 1;\n```",
    "a completed code block at the end must keep its closing fence"
  );
}

function assertProtocolPreambleDetection(module) {
  assert.equal(module.looksLikeSidetProtocolPreamble(""), true);
  assert.equal(module.looksLikeSidetProtocolPreamble("```"), true);
  assert.equal(module.looksLikeSidetProtocolPreamble("```sid"), true);
  assert.equal(module.looksLikeSidetProtocolPreamble("  ```sidet-search"), true);
  assert.equal(module.looksLikeSidetProtocolPreamble("先回答一句"), false);
}

function assertResearchProtocolPreambleDetection(module) {
  assert.equal(module.looksLikeResearchProtocolPreamble(""), true);
  assert.equal(module.looksLikeResearchProtocolPreamble("sidet-"), true);
  assert.equal(module.looksLikeResearchProtocolPreamble("sidet-research\nquestion: x"), true);
  assert.equal(module.looksLikeResearchProtocolPreamble("```sidet-search\nquery: x"), true);
  assert.equal(module.looksLikeResearchProtocolPreamble("```sidet-action\naction: x"), false);
  assert.equal(module.looksLikeResearchProtocolPreamble("```js"), false);
  assert.equal(module.looksLikeResearchProtocolPreamble("先回答一句"), false);
}

function assertResearchPreambleHoldsBareProtocol(module) {
  const emitted = [];
  const streamer = module.createDisplayableAnswerStreamer(
    (chunk) => {
      emitted.push(chunk);
    },
    { holdResearchProtocolPreamble: true }
  );

  streamer.sync("s");
  streamer.sync("sidet-research\nquestion: 没有围栏的协议");
  streamer.finish("sidet-research\nquestion: 没有围栏的协议");
  assert.deepEqual(emitted, [], "a bare research protocol attempt must not leak into the body");

  const normalEmitted = [];
  const normalStreamer = module.createDisplayableAnswerStreamer(
    (chunk) => {
      normalEmitted.push(chunk);
    },
    { holdResearchProtocolPreamble: true }
  );
  normalStreamer.sync("先回答一句");
  assert.deepEqual(normalEmitted, ["先回答一句"], "normal prose should release the preamble hold");
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

function assertBareFenceNeverReachesVisibleText(module) {
  assert.equal(
    module.computeDisplayableAnswerText("先说明。\n\n```"),
    "先说明。",
    "a bare fence whose protocol tag has not arrived must not render as an empty code block"
  );

  const emitted = [];
  const streamer = module.createDisplayableAnswerStreamer((chunk) => {
    emitted.push(chunk);
  });
  for (const snapshot of [
    "先说明。",
    "先说明。\n\n`",
    "先说明。\n\n``",
    "先说明。\n\n```",
    "先说明。\n\n```s",
    "先说明。\n\n```sidet-",
    "先说明。\n\n```sidet-tool\ntool: x"
  ]) {
    streamer.sync(snapshot);
  }
  streamer.finish("先说明。\n\n```sidet-tool\ntool: x\n```");
  assert.deepEqual(emitted, ["先说明。"], "partial and complete tool blocks must stay out of visible text");

  const afterBlock = [];
  const followStreamer = module.createDisplayableAnswerStreamer((chunk) => {
    afterBlock.push(chunk);
  });
  followStreamer.sync("先说明。");
  followStreamer.sync("先说明。\n\n```sidet-tool\ntool: x");
  followStreamer.finish("先说明。\n\n```sidet-tool\ntool: x\n```\n\n后面这句话");
  assert.equal(
    afterBlock.join(""),
    "先说明。\n\n后面这句话",
    "text after a hidden protocol block must not skip its first characters"
  );

  const codeBlock = [];
  const codeStreamer = module.createDisplayableAnswerStreamer((chunk) => {
    codeBlock.push(chunk);
  });
  codeStreamer.sync("示例：");
  codeStreamer.sync("示例：\n\n```");
  codeStreamer.sync("示例：\n\n```j");
  codeStreamer.finish("示例：\n\n```js\nconst a = 1;\n```");
  assert.equal(
    codeBlock.join(""),
    "示例：\n\n```js\nconst a = 1;\n```",
    "a real code block must be emitted once its language arrives"
  );
}

async function main() {
  try {
    const module = await loadBundledModule("src/agent/web-search/displayable-answer-stream.ts");
    assertDisplayableTextHidesProtocol(module);
    assertProtocolPreambleDetection(module);
    assertResearchProtocolPreambleDetection(module);
    assertResearchPreambleHoldsBareProtocol(module);
    assertStreamerEmitsVisibleDiffOnly(module);
    assertBareFenceNeverReachesVisibleText(module);
    console.log("displayable answer stream logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
