import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-web-answering-"));
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

function createControllerHarness(WorkspaceController) {
  return Object.create(WorkspaceController.prototype);
}

function buildSearchState() {
  return {
    round: 1,
    selectedQuery: "台湾 新闻 最新",
    providerLabel: "Bing",
    results: [
      {
        title: "结果一",
        url: "https://example.com/1",
        host: "example.com",
        snippet: "片段一"
      },
      {
        title: "结果二",
        url: "https://example.com/2",
        host: "example.com",
        snippet: "片段二"
      }
    ]
  };
}

function assertSearchOnlyFallbackUsesSelectedQuery(controller) {
  const markdown = controller.buildSearchOnlyFallbackAnswer("台湾 新闻 最新", buildSearchState());
  assert.match(markdown, /我已经按“台湾 新闻 最新”完成了这轮网页搜索/);
  assert.match(markdown, /上面的联网搜索里，共 2 条/);
  assert.doesNotMatch(markdown, /\[结果一\]\(https:\/\/example.com\/1\)/);
}

async function assertDisplayableAnswerStreamsIncrementally(controller) {
  const contentChunks = [];
  const reasoningChunks = [];
  const streamOptions = [];
  const runtime = {
    appendContent: (chunk) => {
      contentChunks.push(chunk);
    },
    appendReasoning: (chunk) => {
      reasoningChunks.push(chunk);
    },
    streamModelReply: async (_messages, options = {}) => {
      streamOptions.push(options);
      options.onReasoningChunk?.("先判断一下。", {
        contentText: "",
        reasoningText: "先判断一下。"
      });
      options.onContentChunk?.("第一段", {
        contentText: "第一段",
        reasoningText: "先判断一下。"
      });
      options.onContentChunk?.("第二段", {
        contentText: "第一段第二段",
        reasoningText: "先判断一下。"
      });
      return {
        contentText: "第一段第二段",
        reasoningText: "先判断一下。",
        stoppedEarly: false
      };
    },
    completeModelReply: async () => {
      throw new Error("should not repair when visible text already streamed");
    }
  };

  await controller.streamDisplayableModelAnswer(runtime, []);

  assert.deepEqual(reasoningChunks, ["先判断一下。"], "reasoning should stream through runtime");
  assert.deepEqual(contentChunks, ["第一段", "第二段"], "visible answer should stream as diffs instead of a final whole block");
  assert.equal(
    Object.prototype.hasOwnProperty.call(streamOptions[0] ?? {}, "reasoningMode"),
    false,
    "final displayable answer should no longer force reasoningMode off"
  );
}

async function assertProtocolReplyStreamsReasoning(controller) {
  const reasoningChunks = [];
  const streamOptions = [];
  const runtime = {
    appendReasoning: (chunk) => {
      reasoningChunks.push(chunk);
    },
    streamModelReply: async (_messages, options = {}) => {
      streamOptions.push(options);
      options.onReasoningChunk?.("先看一下用户真正想搜什么。", {
        contentText: "",
        reasoningText: "先看一下用户真正想搜什么。"
      });
      return {
        contentText: "```sidet-search\nquery1: GitHub Trending 最新\n```",
        reasoningText: "先看一下用户真正想搜什么。",
        stoppedEarly: true
      };
    }
  };

  const reply = await controller.streamProtocolReply(runtime, [], {
    parseSearch: true
  });

  assert.deepEqual(
    reasoningChunks,
    ["先看一下用户真正想搜什么。"],
    "protocol rounds should now stream model reasoning into deep-thinking"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(streamOptions[0] ?? {}, "reasoningMode"),
    false,
    "protocol rounds should no longer force reasoningMode off"
  );
  assert.match(reply.contentText, /sidet-search/, "protocol reply should still return the collected protocol block");
}

async function assertDisplayableAnswerFallsBackWhenNoVisibleText(controller) {
  const contentChunks = [];
  let repairOptions = null;
  const runtime = {
    appendContent: (chunk) => {
      contentChunks.push(chunk);
    },
    appendReasoning: () => undefined,
    streamModelReply: async () => ({
      contentText: "```sidet-direct\nreason: 继续处理\n```",
      reasoningText: "",
      stoppedEarly: false
    }),
    completeModelReply: async (_messages, options = {}) => {
      repairOptions = options;
      return {
        contentText: "",
        reasoningText: ""
      };
    }
  };

  await controller.streamDisplayableModelAnswer(runtime, [], {
    fallbackText: "回退答复"
  });

  assert.deepEqual(contentChunks, ["回退答复"], "when no visible text can be repaired, fallback text should be emitted");
  assert.deepEqual(repairOptions, { webSearchMode: "off" }, "repair round should only turn off web search");
}

async function assertWebSearchFinalAnswerBuildsRepairRound(controller) {
  let captured = null;
  controller.streamDisplayableModelAnswer = async (_runtime, messages, options) => {
    captured = { messages, options };
  };

  await controller.streamWebSearchFinalAnswer(
    {},
    [
      {
        id: "m1",
        role: "system",
        text: "existing transcript",
        createdAt: 1,
        status: "done"
      }
    ],
    buildSearchState(),
    "帮我从网上搜一下台湾最近新闻",
    "上一轮半成品"
  );

  assert.ok(captured, "final answer helper should delegate to streamDisplayableModelAnswer");
  assert.match(captured.messages[0].text, /联网最终答复修正/, "seeded final answer should use repair context");
  assert.equal(captured.messages.at(-1).text, "上一轮半成品", "seed text should be appended as the last assistant message");
  assert.match(
    captured.options.fallbackText,
    /我已经按“台湾 新闻 最新”完成了这轮网页搜索/,
    "fallback should prefer the executed search query"
  );
}

async function assertModelDrivenWebSearchStopsOnVisibleAnswer(controller) {
  const appendedContent = [];
  let protocolCallCount = 0;

  controller.runSearchInstruction = async () => ({
    round: 1,
    selectedQuery: "github 热门项目",
    providerLabel: "GitHub + Bing",
    results: [
      {
        title: "GitHub Trending",
        url: "https://github.com/trending",
        host: "github.com",
        snippet: "Trending repositories on GitHub today"
      }
    ]
  });
  controller.repairWebSearchContinuation = async () => {
    throw new Error("should not repair when a visible answer already exists");
  };
  controller.streamWebSearchFinalAnswer = async () => {
    throw new Error("should not enter final-answer repair when visible answer already exists");
  };
  controller.streamProtocolReply = async () => {
    protocolCallCount += 1;
    if (protocolCallCount === 1) {
      return {
        contentText: "```sidet-search\nquery1: github 热门项目\n```",
        reasoningText: ""
      };
    }

    return {
      contentText: "我查到最近 GitHub 上比较热的项目可以先看 GitHub Trending，再按语言或时间筛一轮。",
      reasoningText: ""
    };
  };

  const runtime = {
    appendContent: (chunk) => {
      appendedContent.push(chunk);
    },
    buildRequestMessages: () => [],
    appendMetaPanelText: () => undefined,
    setMetaPanelSources: () => undefined
  };

  await controller.runModelDrivenWebSearch("最近 github 上有什么热门的项目吗？", null, runtime);

  assert.equal(protocolCallCount, 2, "search flow should stop once the model returns a visible answer");
  assert.deepEqual(
    appendedContent,
    ["我查到最近 GitHub 上比较热的项目可以先看 GitHub Trending，再按语言或时间筛一轮。"],
    "visible answer should be emitted directly instead of entering repair/fallback"
  );
}

async function assertModelDrivenWebSearchRepairsMalformedProtocol(controller) {
  const appendedContent = [];
  let protocolCallCount = 0;
  let repairCallCount = 0;

  controller.runSearchInstruction = async () => ({
    round: 1,
    selectedQuery: "俄罗斯 最新 热点新闻 2026年6月",
    providerLabel: "搜狗 + Bing",
    results: [
      {
        title: "结果一",
        url: "https://example.com/1",
        host: "example.com",
        snippet: "片段一"
      }
    ]
  });
  controller.streamWebSearchFinalAnswer = async () => {
    throw new Error("should not need final-answer repair when continuation repair already returns a visible answer");
  };
  controller.streamProtocolReply = async () => {
    protocolCallCount += 1;
    if (protocolCallCount === 1) {
      return {
        contentText: "```sidet-search\nquery1: 俄罗斯 最新 热点新闻 2026年6月\n```",
        reasoningText: ""
      };
    }

    return {
      contentText: "sidet-fetch\nround: 3\npick1: https://example.com/1\nreason: 我先抓这一条正文确认细节。",
      reasoningText: ""
    };
  };
  controller.repairWebSearchContinuation = async () => {
    repairCallCount += 1;
    return {
      contentText: "我先基于现有结果给你一个阶段性判断：近期俄罗斯相关热点主要集中在局势进展和经济信号两条线。",
      reasoningText: ""
    };
  };

  const runtime = {
    appendContent: (chunk) => {
      appendedContent.push(chunk);
    },
    buildRequestMessages: () => [],
    appendMetaPanelText: () => undefined,
    setMetaPanelSources: () => undefined
  };

  await controller.runModelDrivenWebSearch("最近有没有什么热门的新闻有关于俄罗斯方面的。", null, runtime);

  assert.equal(repairCallCount, 1, "malformed bare protocol text should enter continuation repair");
  assert.deepEqual(
    appendedContent,
    ["我先基于现有结果给你一个阶段性判断：近期俄罗斯相关热点主要集中在局势进展和经济信号两条线。"],
    "malformed protocol text should not leak to the user as final visible content"
  );
}

async function main() {
  try {
    const module = await loadBundledModule("src/workspace/workspace-controller.ts");
    const controller = createControllerHarness(module.WorkspaceController);
    assertSearchOnlyFallbackUsesSelectedQuery(controller);
    await assertDisplayableAnswerStreamsIncrementally(controller);
    await assertProtocolReplyStreamsReasoning(controller);
    await assertDisplayableAnswerFallsBackWhenNoVisibleText(controller);
    await assertWebSearchFinalAnswerBuildsRepairRound(controller);
    await assertModelDrivenWebSearchStopsOnVisibleAnswer(controller);
    await assertModelDrivenWebSearchRepairsMalformedProtocol(controller);
    console.log("sidet web search answering logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
