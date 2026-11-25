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

function buildSearchResults() {
  return [
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
  ];
}

function buildResearchPage(overrides = {}) {
  return {
    sourceIndex: 1,
    title: "Page",
    url: "https://example.com/page",
    host: "example.com",
    content: "完整正文",
    snippet: "摘要",
    ...overrides
  };
}

function assertSearchOnlyFallbackUsesOriginalQuery(controller) {
  const markdown = controller.buildSearchOnlyFallbackAnswer("台湾 新闻 最新", buildSearchResults());
  assert.match(markdown, /我已经按“台湾 新闻 最新”完成了这轮网页搜索/);
  assert.match(markdown, /共 2 条/);
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

  const visibleText = await controller.streamDisplayableModelAnswer(runtime, []);

  assert.equal(visibleText, "第一段第二段");
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
      options.onReasoningChunk?.("先看一下还缺什么。", {
        contentText: "",
        reasoningText: "先看一下还缺什么。"
      });
      return {
        contentText: "```sidet-research\nquestion: 2026 年 GitHub 热门项目\n```",
        reasoningText: "先看一下还缺什么。",
        stoppedEarly: true
      };
    }
  };

  const reply = await controller.streamProtocolReply(runtime, [], {
    parseResearch: true
  });

  assert.deepEqual(
    reasoningChunks,
    ["先看一下还缺什么。"],
    "research decision rounds should stream model reasoning into deep-thinking"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(streamOptions[0] ?? {}, "reasoningMode"),
    false,
    "protocol rounds should no longer force reasoningMode off"
  );
  assert.match(reply.contentText, /sidet-research/, "protocol reply should still return the collected protocol block");
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
      contentText: "```sidet-research\nquestion: 继续处理\n```",
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

  const visibleText = await controller.streamDisplayableModelAnswer(runtime, [], {
    fallbackText: "回退答复"
  });

  assert.equal(visibleText, "回退答复");
  assert.deepEqual(contentChunks, ["回退答复"], "when no visible text can be repaired, fallback text should be emitted");
  assert.deepEqual(repairOptions, { webSearchMode: "off" }, "repair round should only turn off web search");
}

async function assertWebSearchFinalAnswerUsesResearchContext(controller) {
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
    {
      originalQuery: "帮我从网上搜一下台湾最近新闻",
      exhausted: true,
      pages: [],
      searchResults: buildSearchResults()
    }
  );

  assert.ok(captured, "final answer helper should delegate to streamDisplayableModelAnswer");
  assert.match(captured.messages[0].text, /联网最终答复/, "final answer should use the research final-answer context");
  assert.match(captured.messages[0].text, /预算/, "exhausted final answer should mention the budget boundary");
  assert.match(
    captured.options.fallbackText,
    /我已经按“帮我从网上搜一下台湾最近新闻”完成了这轮网页搜索/,
    "fallback should prefer the original user query"
  );
}

function assertStructuredSourcesWithFetchedSources(controller) {
  const recordedSources = [];
  const runtime = {
    setSources: (sources) => recordedSources.push(sources),
    getAbortSignal: () => new AbortController().signal
  };

  controller.commitWebSearchSources(runtime, [
    buildResearchPage({
      title: "Page [One]",
      url: "https://example.com/page",
      content: "完整正文",
      snippet: "摘要"
    }),
    buildResearchPage({
      sourceIndex: 2,
      title: "Page [One] duplicate",
      url: "https://example.com/page"
    })
  ], []);

  assert.equal(recordedSources.length, 1, "fetched sources should set structured sources once");
  assert.equal(recordedSources[0].length, 1, "duplicate URLs should be collapsed");
  assert.equal(recordedSources[0][0].title, "Page [One]");
  assert.equal(recordedSources[0][0].url, "https://example.com/page");
  assert.equal(recordedSources[0][0].host, "example.com");
  assert.equal(recordedSources[0][0].note, "摘要");
  assert.equal(recordedSources[0][0].readDepth, "full");

  const summarySources = [];
  controller.commitWebSearchSources({
    setSources: (sources) => summarySources.push(sources),
    getAbortSignal: () => new AbortController().signal
  }, [], buildSearchResults());
  assert.equal(summarySources[0].length, 2);
  assert.equal(summarySources[0][0].readDepth, "summary");

  const abortedSources = [];
  controller.commitWebSearchSources({
    setSources: (sources) => abortedSources.push(sources),
    getAbortSignal: () => AbortSignal.abort()
  }, [buildResearchPage()], []);
  assert.deepEqual(abortedSources, [], "a cancelled task should not set sources");
}

async function assertResearchRoundWiring(controller) {
  const calls = {
    search: [],
    fetch: [],
    complete: [],
    panels: [],
    sources: [],
    content: []
  };
  controller.webSearch = {
    searchMany: async (queries, options = {}) => {
      calls.search.push({ queries, options });
      options.onProgress?.({ message: "并行执行 2 组搜索词…" });
      return {
        providerLabel: "Bing + 百度",
        results: [
          {
            title: "Result A",
            url: "https://a.example.com/1",
            host: "a.example.com",
            snippet: "snippet A"
          },
          {
            title: "Result B",
            url: "https://b.example.com/1",
            host: "b.example.com",
            snippet: "snippet B"
          }
        ]
      };
    }
  };
  controller.buildWebpageAttachment = async (url) => {
    calls.fetch.push(url);
    return {
      id: `attachment-${calls.fetch.length}`,
      type: "webpage",
      name: `Page ${calls.fetch.length}`,
      url,
      content: `formatted ${url}`,
      rawContent: `raw ${url}`,
      truncated: false,
      size: 10
    };
  };

  const runtime = {
    buildRequestMessages: () => [],
    completeModelReply: async (messages) => {
      calls.complete.push(messages.map((message) => message.text).join("\n"));
      const systemText = messages[0]?.text ?? "";
      if (systemText.includes("检索规划")) {
        return { contentText: "query1: alpha\nquery2: beta", reasoningText: "" };
      }
      if (systemText.includes("证据整理")) {
        return { contentText: "结论：已经读到正文 [1]", reasoningText: "" };
      }
      return { contentText: "", reasoningText: "" };
    },
    streamModelReply: async () => ({
      contentText: "这是最终答案",
      reasoningText: "",
      stoppedEarly: false
    }),
    appendContent: (chunk) => calls.content.push(chunk),
    appendReasoning: () => undefined,
    appendMetaPanelText: (panel, text) => calls.panels.push({ panel, text }),
    setMetaPanelSources: () => undefined,
    setSources: (sources) => calls.sources.push(sources),
    getAbortSignal: () => new AbortController().signal
  };

  await controller.runModelDrivenWebSearch("测试研究问题", null, runtime);

  assert.equal(calls.search.length, 1, "research should call searchMany once");
  assert.deepEqual(calls.search[0].queries, ["alpha", "beta"]);
  assert.equal(calls.search[0].options.maxQueries, 4);
  assert.deepEqual(calls.fetch, [
    "https://a.example.com/1",
    "https://b.example.com/1"
  ], "the agent should fetch selected pages in ranked order");
  assert.equal(calls.complete.length, 2, "research should use one query-expansion and one evidence-compression call");
  assert.ok(calls.complete[0].includes("检索规划"));
  assert.ok(calls.complete[1].includes("证据整理"));
  assert.deepEqual(calls.content, ["这是最终答案"]);
  assert.equal(calls.sources.length, 1);
  assert.deepEqual(calls.sources[0].map((source) => source.url), [
    "https://a.example.com/1",
    "https://b.example.com/1"
  ]);
  assert.equal(calls.sources[0][0].readDepth, "full");
  assert.ok(
    calls.panels.some(({ panel, text }) => panel.kind.startsWith("web-step-research-") && text.includes("研究问题：测试研究问题")),
    "research should expose its question in the web-search process panel"
  );
  assert.ok(calls.panels.some(({ text }) => text.includes("检索词：alpha / beta")));
  assert.ok(
    calls.panels.every(({ text }) => !/联网思考未能在当前轮次内完成|超过当前轮次预算/.test(text)),
    "the old five-step failure card should no longer appear"
  );
}

async function main() {
  try {
    const module = await loadBundledModule("src/workspace/workspace-controller.ts");
    const controller = createControllerHarness(module.WorkspaceController);
    assertSearchOnlyFallbackUsesOriginalQuery(controller);
    await assertDisplayableAnswerStreamsIncrementally(controller);
    await assertProtocolReplyStreamsReasoning(controller);
    await assertDisplayableAnswerFallsBackWhenNoVisibleText(controller);
    await assertWebSearchFinalAnswerUsesResearchContext(controller);
    assertStructuredSourcesWithFetchedSources(controller);
    await assertResearchRoundWiring(controller);
    console.log("sidet web search answering logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
