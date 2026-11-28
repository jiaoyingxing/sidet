import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-local-assistant-stream-"));
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

function createStoreHarness() {
  const conversation = {
    id: "conversation-1",
    title: "测试对话",
    createdAt: 1,
    updatedAt: 1,
    isPinned: false,
    folderId: null,
    modelConfigId: "model-1",
    messages: []
  };

  return {
    conversation,
    hasConversation: (conversationId) => conversationId === conversation.id,
    appendUserMessage: async (_conversationId, text, _attachments, options = {}) => {
      const message = {
        id: `user-${conversation.messages.length + 1}`,
        role: "user",
        text,
        createdAt: Date.now(),
        status: "done",
        knowledgeBaseRouting: options.knowledgeBaseRouting
      };
      conversation.messages.push(message);
      return message;
    },
    buildProviderMessages: () => [],
    beginAssistantMessage: async (_conversationId) => {
      const message = {
        id: `assistant-${conversation.messages.length + 1}`,
        role: "assistant",
        text: "",
        createdAt: Date.now(),
        status: "streaming"
      };
      conversation.messages.push(message);
      return message;
    },
    appendAssistantReasoningChunk: (_conversationId, messageId, chunk) => {
      const message = conversation.messages.find((item) => item.id === messageId);
      message.reasoningText = `${message.reasoningText ?? ""}${chunk}`;
    },
    updateMessageKnowledgeBaseRouting: (_conversationId, messageId, knowledgeBaseRouting) => {
      const message = conversation.messages.find((item) => item.id === messageId);
      message.knowledgeBaseRouting = knowledgeBaseRouting;
    },
    appendAssistantChunk: (_conversationId, messageId, chunk) => {
      const message = conversation.messages.find((item) => item.id === messageId);
      message.text += chunk;
    },
    appendAssistantMetaPanelChunk: () => undefined,
    replaceAssistantMetaPanelSources: () => undefined,
    finishAssistantMessage: async (_conversationId, messageId) => {
      const message = conversation.messages.find((item) => item.id === messageId);
      message.status = "done";
    },
    removeMessage: async (_conversationId, messageId) => {
      const index = conversation.messages.findIndex((item) => item.id === messageId);
      if (index >= 0) {
        conversation.messages.splice(index, 1);
      }
    },
    captureConversationSnapshot: () => null,
    restoreConversationSnapshot: async () => undefined,
    getConversation: () => conversation,
    setConversationContextSummary: async (_conversationId, summary) => {
      conversation.contextSummary = summary ?? undefined;
    },
    failAssistantMessage: async (_conversationId, messageId, errorText) => {
      const message = conversation.messages.find((item) => item.id === messageId);
      message.status = "error";
      message.text = errorText;
    }
  };
}

function createResolvedModelConfig() {
  return {
    id: "model-1",
    name: "测试模型",
    providerId: "siliconflow",
    providerLabel: "硅基流动",
    presetId: "siliconflow-deepseek-v3",
    model: "test-model",
    baseUrl: "https://example.com",
    reasoningEnabled: false,
    reasoningCompatibilityMode: "none"
  };
}

async function assertLocalAssistantStreamingStopsEarly(module) {
  let chunkCount = 0;
  const provider = {
    async *streamReply() {
      chunkCount += 1;
      yield { type: "content", text: "```sidet-search\nquery1: sidet\n" };
      chunkCount += 1;
      yield { type: "content", text: "reason: 查一下公开资料\n```" };
      chunkCount += 1;
      yield { type: "content", text: "\nTHIS SHOULD NOT BE CONSUMED" };
    }
  };
  const store = createStoreHarness();
  const modelConfig = createResolvedModelConfig();
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  let streamedReply = null;
  await session.sendLocalAssistantTask(
    store.conversation.id,
    modelConfig,
    "测试联网流式早停",
    [],
    async (runtime) => {
      streamedReply = await runtime.streamModelReply([], {
        shouldStop: ({ contentText }) => contentText.trimEnd().endsWith("```")
      });
    }
  );

  assert.equal(chunkCount, 2, "local assistant streaming should stop as soon as the protocol block closes");
  assert.equal(streamedReply?.stoppedEarly, true, "streamed reply should report early stop");
  assert.match(streamedReply?.contentText ?? "", /sidet-search/, "streamed reply should retain the collected protocol block");
  assert.doesNotMatch(streamedReply?.contentText ?? "", /THIS SHOULD NOT BE CONSUMED/, "streamed reply should not include chunks after early stop");
}

async function assertLocalAssistantStreamingCollectsFullReply(module) {
  const provider = {
    async *streamReply() {
      yield { type: "reasoning", text: "先想一下。" };
      yield { type: "content", text: "第一段" };
      yield { type: "content", text: "第二段" };
    }
  };
  const store = createStoreHarness();
  const modelConfig = createResolvedModelConfig();
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  let streamedReply = null;
  await session.sendLocalAssistantTask(
    store.conversation.id,
    modelConfig,
    "测试本地流式完整收集",
    [],
    async (runtime) => {
      streamedReply = await runtime.streamModelReply([]);
    }
  );

  assert.equal(streamedReply?.stoppedEarly, false, "streamed reply should report normal completion when no early stop is requested");
  assert.equal(streamedReply?.reasoningText, "先想一下。", "streamed reply should collect reasoning chunks");
  assert.equal(streamedReply?.contentText, "第一段第二段", "streamed reply should collect all content chunks");
}

function createAbortError() {
  return new DOMException("已取消", "AbortError");
}

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(createAbortError());
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function assertLocalAssistantTaskStopsAndFinishesPartialReply(module) {
  let firstChunkResolve;
  const firstChunk = new Promise((resolve) => {
    firstChunkResolve = resolve;
  });
  const provider = {
    async *streamReply({ signal }) {
      yield { type: "content", text: "先查一下。" };
      await waitForAbort(signal);
    }
  };
  const store = createStoreHarness();
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  const run = session.sendLocalAssistantTask(
    store.conversation.id,
    createResolvedModelConfig(),
    "测试会话取消",
    [],
    async (runtime) => {
      await runtime.streamModelReply([], {
        onContentChunk: (chunk) => {
          runtime.appendContent(chunk);
          firstChunkResolve();
        }
      });
    }
  );
  await firstChunk;

  assert.equal(session.isStreaming(), true, "local task should report streaming while the provider is running");
  assert.equal(
    session.getActiveConversationId(),
    store.conversation.id,
    "local task should expose its conversation while running"
  );

  const stopAndWait = session.stopAndWait();
  await run;
  await stopAndWait;

  assert.equal(session.isStreaming(), false, "stop should settle the local task and clear streaming state");
  assert.equal(session.getActiveConversationId(), null, "stopped local task should clear the active conversation id");
  const assistantMessage = store.conversation.messages.find((message) => message.role === "assistant");
  assert.equal(assistantMessage?.status, "done", "partial local assistant output should finish instead of staying streaming");
  assert.equal(assistantMessage?.text, "先查一下。", "partial local assistant output should be preserved after stop");
}

async function assertLocalAssistantTaskRemovesEmptyReplyOnStop(module) {
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const provider = {
    async *streamReply({ signal }) {
      startedResolve();
      await waitForAbort(signal);
    }
  };
  const store = createStoreHarness();
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  const run = session.sendLocalAssistantTask(
    store.conversation.id,
    createResolvedModelConfig(),
    "测试空回复取消",
    [],
    async (runtime) => {
      await runtime.streamModelReply([]);
    }
  );
  await started;
  session.stop();
  await run;

  assert.equal(session.isStreaming(), false, "empty cancelled local task should clear streaming state");
  assert.equal(store.conversation.messages.length, 1, "empty cancelled assistant message should be removed");
  assert.equal(store.conversation.messages[0].role, "user", "cancelled local task should keep the user message");
}

async function assertLocalAssistantTaskAbortSignalCancelsModelRequest(module) {
  let capturedSignal = null;
  let caughtErrorName = null;
  const provider = {
    async *streamReply({ signal }) {
      yield { type: "content", text: "第一段" };
      await waitForAbort(signal);
    }
  };
  const store = createStoreHarness();
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  await session.sendLocalAssistantTask(
    store.conversation.id,
    createResolvedModelConfig(),
    "测试外部取消信号",
    [],
    async (runtime) => {
      capturedSignal = runtime.getAbortSignal();
      try {
        await runtime.streamModelReply([], {
          signal: capturedSignal,
          onContentChunk: (chunk) => {
            runtime.appendContent(chunk);
            session.stop();
          }
        });
      } catch (error) {
        caughtErrorName = error?.name ?? null;
      }
    }
  );

  assert.ok(capturedSignal, "local task runtime should expose its abort signal");
  assert.equal(capturedSignal.aborted, true, "session.stop should abort the local task signal");
  assert.equal(caughtErrorName, "AbortError", "external signal abort should cancel the model request with AbortError");
  assert.equal(session.isStreaming(), false, "aborted model request should settle the local task");
  const assistantMessage = store.conversation.messages.find((message) => message.role === "assistant");
  assert.equal(assistantMessage?.status, "done", "partial reply before external abort should finish normally");
}

async function assertLocalAssistantTaskForceStopFallback(module) {
  let releaseProvider;
  const providerWaiting = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  let firstChunkResolve;
  const firstChunk = new Promise((resolve) => {
    firstChunkResolve = resolve;
  });
  const provider = {
    async *streamReply() {
      yield { type: "content", text: "卡住的输出" };
      await providerWaiting;
    }
  };
  const store = createStoreHarness();
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  const run = session.sendLocalAssistantTask(
    store.conversation.id,
    createResolvedModelConfig(),
    "测试停止兜底",
    [],
    async (runtime) => {
      await runtime.streamModelReply([], {
        onContentChunk: (chunk) => {
          runtime.appendContent(chunk);
          firstChunkResolve();
        }
      });
    }
  );
  await firstChunk;
  session.stop();
  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.equal(
    session.isStreaming(),
    false,
    "stop fallback should clear streaming state even when the provider ignores abort"
  );
  const assistantMessage = store.conversation.messages.find((message) => message.role === "assistant");
  assert.equal(assistantMessage?.status, "done", "stop fallback should finish a partially written assistant message");

  releaseProvider();
  await run;
  assert.equal(session.isStreaming(), false, "late provider completion after force stop should not reopen streaming state");
}

async function assertLocalAssistantTaskFailureStillFails(module) {
  const provider = {
    async *streamReply() {
      throw new Error("模型请求失败");
    }
  };
  const store = createStoreHarness();
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  await assert.rejects(
    session.sendLocalAssistantTask(
      store.conversation.id,
      createResolvedModelConfig(),
      "测试非取消错误",
      [],
      async (runtime) => {
        await runtime.streamModelReply([]);
      }
    ),
    /模型请求失败/
  );

  assert.equal(session.isStreaming(), false, "non-cancel failure should still clear streaming state");
  const assistantMessage = store.conversation.messages.find((message) => message.role === "assistant");
  assert.equal(assistantMessage?.status, "error", "non-cancel failure should keep the existing assistant error path");
}

async function assertAgentToolStepPresenter(module) {
  const panelWrites = [];
  const contentWrites = [];
  const presenter = module.createAgentToolStepPresenter({
    appendPanelText: (panel, chunk) => panelWrites.push({ panel, chunk }),
    appendVisibleContent: (chunk) => contentWrites.push(chunk)
  });

  presenter.appendVisibleContent("我先查一下。");
  presenter.handleStep({ tool: "search_notes", status: "running", summary: "检索笔记：Alpha" });
  assert.equal(panelWrites.length, 0, "running tool steps must not append panel text");

  presenter.handleStep({
    tool: "search_notes",
    status: "ok",
    summary: "检索笔记：Alpha",
    detail: "命中 2 篇笔记。"
  });
  assert.deepEqual(panelWrites[0], {
    panel: {
      kind: "tool-step-1",
      label: "检索笔记：Alpha",
      display: "step",
      group: "agent-tool",
      groupLabel: "工具过程"
    },
    chunk: "命中 2 篇笔记。"
  });

  presenter.appendVisibleContent("\n");
  presenter.appendVisibleContent("根据结果");
  presenter.appendVisibleContent("。");
  assert.deepEqual(
    contentWrites,
    ["我先查一下。", "\n", "\n\n", "根据结果", "。"],
    "only the first non-whitespace visible chunk after a tool step should get one separator"
  );

  presenter.handleStep({
    tool: "search_notes",
    status: "error",
    summary: "检索笔记：Alpha",
    detail: "重复调用已跳过"
  });
  assert.equal(panelWrites[1].panel.kind, "tool-step-2", "duplicate completion without running should get its own step panel");
  assert.equal(panelWrites[1].chunk, "失败：重复调用已跳过", "error detail should use the failure prefix");

  presenter.handleStep({ tool: "read_note", status: "ok", summary: "读取笔记：Beta" });
  assert.equal(panelWrites[2].panel.kind, "tool-step-3", "completion without running should still get a step panel");
  assert.equal(panelWrites[2].chunk, "完成", "missing detail should fall back to a completed label");

  const freshPanelWrites = [];
  const freshContentWrites = [];
  const freshPresenter = module.createAgentToolStepPresenter({
    appendPanelText: (panel, chunk) => freshPanelWrites.push({ panel, chunk }),
    appendVisibleContent: (chunk) => freshContentWrites.push(chunk)
  });
  freshPresenter.handleStep({
    tool: "read_note",
    status: "ok",
    summary: "读取笔记：Beta",
    detail: "path: Beta.md"
  });
  freshPresenter.appendVisibleContent("直接回答。");
  assert.deepEqual(freshContentWrites, ["直接回答。"], "no separator should be added when no visible preamble exists");
}

async function assertProviderMessagesAreBudgeted(module) {
  const store = createStoreHarness();
  const modelConfig = createResolvedModelConfig();
  const longHistory = [
    { id: "user-old", role: "user", text: "x".repeat(40000), createdAt: 1, status: "done" },
    { id: "assistant-old", role: "assistant", text: "y".repeat(40000), createdAt: 2, status: "done" },
    { id: "user-current", role: "user", text: "current question", createdAt: 3, status: "done" }
  ];
  store.buildProviderMessages = () => longHistory;
  const provider = {
    async *streamReply() {
      yield { type: "content", text: "ok" };
    }
  };
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  let capturedMessages = null;
  await session.sendLocalAssistantTask(
    store.conversation.id,
    modelConfig,
    "current question",
    [],
    async (runtime) => {
      capturedMessages = runtime.buildRequestMessages(null);
    }
  );

  assert.ok(capturedMessages, "the task should build request messages");
  assert.equal(
    capturedMessages[0]?.role,
    "system",
    "a trimmed provider history should start with a system notice"
  );
  assert.match(capturedMessages[0]?.text ?? "", /省略/, "the notice should explain the omission");
  assert.equal(
    capturedMessages[capturedMessages.length - 1]?.id,
    "user-current",
    "the current user message must stay the last request message"
  );
  assert.equal(
    capturedMessages.some((message) => message.id === "user-old"),
    false,
    "older oversized history should be omitted from the provider request"
  );
}

async function assertProviderMessagesUseContextSummary(module) {
  const store = createStoreHarness();
  const modelConfig = createResolvedModelConfig();
  const history = Array.from({ length: 20 }, (_value, index) => ({
    id: index === 9 ? "anchor-message" : `history-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `历史 ${index} ` + "x".repeat(100),
    createdAt: index,
    status: "done"
  }));
  store.buildProviderMessages = () => history;
  store.conversation.contextSummary = {
    text: "早期摘要内容",
    summarizedThroughMessageId: "anchor-message",
    updatedAt: 1
  };
  const provider = {
    async *streamReply() {
      yield { type: "content", text: "ok" };
    }
  };
  const session = new module.ConversationSession(store, provider, () => "test-api-key");

  let capturedMessages = null;
  await session.sendLocalAssistantTask(
    store.conversation.id,
    modelConfig,
    "当前问题",
    [],
    async (runtime) => {
      capturedMessages = runtime.buildRequestMessages(null);
    }
  );

  assert.ok(capturedMessages);
  assert.equal(capturedMessages[0].role, "system");
  assert.match(capturedMessages[0].text, /较早对话摘要/);
  assert.match(capturedMessages[0].text, /早期摘要内容/);
  assert.equal(
    capturedMessages.some((message) => message.id === "anchor-message"),
    false,
    "summarized messages should not be sent raw"
  );
  assert.equal(
    capturedMessages.some((message) => message.id === "history-5"),
    false,
    "messages before the summary anchor should be omitted"
  );
  assert.equal(
    capturedMessages.some((message) => message.id === "history-12"),
    true,
    "messages after the summary anchor should stay raw"
  );
}

async function assertBackgroundContextSummaryRunsAfterTurn(module) {
  const store = createStoreHarness();
  const modelConfig = createResolvedModelConfig();
  for (let index = 0; index < 20; index += 1) {
    store.conversation.messages.push({
      id: `history-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `历史 ${index}`,
      createdAt: index,
      status: "done"
    });
  }
  const provider = {
    async *streamReply() {
      yield { type: "content", text: "压缩后的背景摘要" };
    }
  };
  const session = new module.ConversationSession(store, provider, () => "test-api-key");

  await session.sendLocalAssistantTask(
    store.conversation.id,
    modelConfig,
    "当前问题",
    [],
    async () => undefined
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(
    store.conversation.contextSummary?.text,
    "压缩后的背景摘要",
    "a completed turn should trigger a background context summary"
  );
  assert.equal(
    store.conversation.contextSummary?.summarizedThroughMessageId,
    store.conversation.messages[5].id,
    "the summary anchor should cover everything before the 16-message raw window"
  );
}

async function main() {
  try {
    const sessionModule = await loadBundledModule("src/conversations/conversation-session.ts");
    const presenterModule = await loadBundledModule("src/workspace/agent-tool-step-presenter.ts");
    await assertLocalAssistantStreamingStopsEarly(sessionModule);
    await assertProviderMessagesAreBudgeted(sessionModule);
    await assertProviderMessagesUseContextSummary(sessionModule);
    await assertBackgroundContextSummaryRunsAfterTurn(sessionModule);
    await assertLocalAssistantStreamingCollectsFullReply(sessionModule);
    await assertLocalAssistantTaskStopsAndFinishesPartialReply(sessionModule);
    await assertLocalAssistantTaskRemovesEmptyReplyOnStop(sessionModule);
    await assertLocalAssistantTaskAbortSignalCancelsModelRequest(sessionModule);
    await assertLocalAssistantTaskForceStopFallback(sessionModule);
    await assertLocalAssistantTaskFailureStillFails(sessionModule);
    await assertAgentToolStepPresenter(presenterModule);
    console.log("local assistant stream logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
