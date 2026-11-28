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

async function assertProtocolReplyStreamsVisibleContent(controller) {
  const contentChunks = [];
  const runtime = {
    appendContent: (chunk) => {
      contentChunks.push(chunk);
    },
    appendReasoning: () => undefined,
    streamModelReply: async (_messages, options = {}) => {
      options.onContentChunk?.("第一段", {
        contentText: "第一段",
        reasoningText: ""
      });
      options.onContentChunk?.("第二段", {
        contentText: "第一段第二段",
        reasoningText: ""
      });
      return {
        contentText: "第一段第二段",
        reasoningText: "",
        stoppedEarly: false
      };
    }
  };

  const reply = await controller.streamProtocolReply(runtime, [], {
    parseResearch: true,
    streamVisibleContent: true
  });

  assert.deepEqual(contentChunks, ["第一段", "第二段"], "decision rounds should stream visible answer diffs");
  assert.equal(reply.visibleContentStreamed, true);
}

async function assertProtocolReplyHidesResearchBlockWhileStreaming(controller) {
  const contentChunks = [];
  const block = "```sidet-research\nquestion: 还需要补一轮\n```";
  const runtime = {
    appendContent: (chunk) => {
      contentChunks.push(chunk);
    },
    appendReasoning: () => undefined,
    streamModelReply: async (_messages, options = {}) => {
      options.onContentChunk?.(block, {
        contentText: block,
        reasoningText: ""
      });
      return {
        contentText: block,
        reasoningText: "",
        stoppedEarly: true
      };
    }
  };

  const reply = await controller.streamProtocolReply(runtime, [], {
    parseResearch: true,
    streamVisibleContent: true
  });

  assert.deepEqual(contentChunks, [], "research protocol blocks must not be streamed to the answer body");
  assert.equal(reply.visibleContentStreamed, false);
  assert.match(reply.contentText, /sidet-research/);
}

async function assertProtocolReplyHidesBareResearchAttempt(controller) {
  const contentChunks = [];
  const malformed = "sidet-research\nquestion: 没有围栏的协议";
  const runtime = {
    appendContent: (chunk) => {
      contentChunks.push(chunk);
    },
    appendReasoning: () => undefined,
    streamModelReply: async (_messages, options = {}) => {
      options.onContentChunk?.(malformed, {
        contentText: malformed,
        reasoningText: ""
      });
      return {
        contentText: malformed,
        reasoningText: "",
        stoppedEarly: false
      };
    }
  };

  const reply = await controller.streamProtocolReply(runtime, [], {
    parseResearch: true,
    streamVisibleContent: true
  });

  assert.deepEqual(contentChunks, [], "bare malformed research attempts must not leak into the answer body");
  assert.equal(reply.visibleContentStreamed, false);
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
            title: "Alpha 结果",
            url: "https://a.example.com/1",
            host: "a.example.com",
            snippet: "alpha snippet"
          },
          {
            title: "Beta 结果",
            url: "https://b.example.com/1",
            host: "b.example.com",
            snippet: "beta snippet"
          }
        ]
      };
    }
  };
  controller.buildWebpageAttachment = async (url, fetchOptions = {}) => {
    calls.fetch.push({ url, options: fetchOptions });
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
      if (systemText.includes("检索前理解")) {
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
  assert.deepEqual(calls.fetch.map((item) => item.url), [
    "https://a.example.com/1",
    "https://b.example.com/1"
  ], "the agent should fetch selected pages in ranked order");
  assert.ok(
    calls.fetch.every((item) => item.options.timeoutMs === 8_000),
    "research page fetches should use the shorter research timeout"
  );
  assert.equal(
    calls.complete.length,
    1,
    "small first-round evidence should skip the compression call"
  );
  assert.ok(calls.complete[0].includes("检索前理解"));
  assert.ok(
    calls.complete.every((text) => !text.includes("证据整理")),
    "small evidence should not enter the compression prompt"
  );
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

async function assertResearchCompressionDropsConversationHistory(controller) {
  const calls = {
    fetch: [],
    complete: [],
    sources: [],
    content: []
  };
  controller.webSearch = {
    searchMany: async () => ({
      providerLabel: "Bing",
      results: [
        {
          title: "Long Result 1",
          url: "https://long.example.com/1",
          host: "long.example.com",
          snippet: "长证据摘要一"
        },
        {
          title: "Long Result 2",
          url: "https://long2.example.com/2",
          host: "long2.example.com",
          snippet: "长证据摘要二"
        }
      ]
    })
  };
  controller.buildWebpageAttachment = async (url, fetchOptions = {}) => {
    calls.fetch.push({ url, options: fetchOptions });
    return {
      id: `attachment-long-${url}`,
      type: "webpage",
      name: "Long Page",
      url,
      content: "formatted long page",
      rawContent: "长证据".repeat(5_000),
      truncated: false,
      size: 15_000
    };
  };

  const runtime = {
    buildRequestMessages: () => [{
      id: "history",
      role: "user",
      text: "历史消息",
      createdAt: 1,
      status: "done"
    }],
    completeModelReply: async (messages) => {
      calls.complete.push(messages.map((message) => message.text).join("\n"));
      const systemText = messages[0]?.text ?? "";
      if (systemText.includes("检索前理解")) {
        return { contentText: "query1: alpha", reasoningText: "" };
      }
      if (systemText.includes("证据整理")) {
        return { contentText: "结论：长证据 [1]", reasoningText: "" };
      }
      return { contentText: "", reasoningText: "" };
    },
    streamModelReply: async () => ({
      contentText: "长证据最终答案",
      reasoningText: "",
      stoppedEarly: false
    }),
    appendContent: (chunk) => calls.content.push(chunk),
    appendReasoning: () => undefined,
    appendMetaPanelText: () => undefined,
    setMetaPanelSources: () => undefined,
    setSources: (sources) => calls.sources.push(sources),
    getAbortSignal: () => new AbortController().signal
  };

  await controller.runModelDrivenWebSearch("长证据研究问题", null, runtime);

  assert.equal(calls.complete.length, 2, "oversized evidence should still use the compression call");
  assert.ok(calls.complete[0].includes("检索前理解"));
  assert.ok(calls.complete[0].includes("历史消息"), "query expansion may keep recent conversation context");
  assert.ok(calls.complete[1].includes("证据整理"));
  assert.ok(
    !calls.complete[1].includes("历史消息"),
    "evidence compression should receive only the question and evidence, not the whole conversation"
  );
  assert.deepEqual(calls.content, ["长证据最终答案"]);
  assert.equal(calls.sources.length, 1);
}

async function main() {
  try {
    const module = await loadBundledModule("src/workspace/workspace-controller.ts");
    const controller = createControllerHarness(module.WorkspaceController);
    assertSearchOnlyFallbackUsesOriginalQuery(controller);
    await assertDisplayableAnswerStreamsIncrementally(controller);
    await assertProtocolReplyStreamsReasoning(controller);
    await assertProtocolReplyStreamsVisibleContent(controller);
    await assertProtocolReplyHidesResearchBlockWhileStreaming(controller);
    await assertProtocolReplyHidesBareResearchAttempt(controller);
    await assertDisplayableAnswerFallsBackWhenNoVisibleText(controller);
    await assertWebSearchFinalAnswerUsesResearchContext(controller);
    assertStructuredSourcesWithFetchedSources(controller);
    await assertResearchRoundWiring(controller);
    await assertResearchCompressionDropsConversationHistory(controller);
    console.log("sidet web search answering logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
