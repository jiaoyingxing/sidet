import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

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
    captureConversationSnapshot: () => null,
    restoreConversationSnapshot: async () => undefined,
    getConversation: () => conversation,
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

async function assertLocalAssistantReplyStartsBeforeReplyFactoryResolves(module) {
  const provider = {
    async *streamReply() {
      yield { type: "content", text: "unused" };
    }
  };
  const store = createStoreHarness();
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  let producerSawStreamingAssistant = false;
  await session.sendLocalAssistantReply(
    store.conversation.id,
    "测试知识库本地回复",
    async (userMessage) => {
      const latestMessage = store.conversation.messages.at(-1);
      producerSawStreamingAssistant = latestMessage?.role === "assistant" && latestMessage?.status === "streaming";
      assert.equal(userMessage.role, "user", "reply producer should receive the appended user message");
      assert.equal(
        userMessage.knowledgeBaseRouting?.status,
        "searching",
        "the user message should expose a searching state before the reply factory resolves"
      );
      return {
        assistantText: "# 知识库检索结果\n\n命中了 1 篇。",
        knowledgeBaseRouting: {
          mode: "single",
          displayName: "Sidet/Wiki",
          status: "complete",
          resultCount: 1,
          hits: [
            {
              path: "Sidet/Wiki/Index.md",
              basename: "Index",
              kindLabel: "Index"
            }
          ]
        }
      };
    },
    [],
    {
      knowledgeBaseRouting: {
        mode: "single",
        displayName: "Sidet/Wiki",
        status: "searching",
        resultCount: 0,
        hits: []
      }
    }
  );

  assert.equal(producerSawStreamingAssistant, true, "local reply should create a streaming assistant message before the reply factory resolves");
  assert.equal(store.conversation.messages.length, 2, "conversation should contain one user message and one assistant message");
  assert.equal(store.conversation.messages[0].knowledgeBaseRouting?.displayName, "Sidet/Wiki", "knowledge base routing should be written back onto the user message");
  assert.equal(store.conversation.messages[1].status, "done", "assistant reply should finish after local content is appended");
  assert.match(store.conversation.messages[1].text, /知识库检索结果/, "assistant reply should contain the local result markdown");
}

async function assertLocalAssistantReplyFailureEndsSearchingState(module) {
  const provider = {
    async *streamReply() {
      yield { type: "content", text: "unused" };
    }
  };
  const store = createStoreHarness();
  store.beginAssistantMessage = async () => {
    throw new Error("assistant placeholder failed");
  };
  const session = new module.ConversationSession(
    store,
    provider,
    () => "test-api-key"
  );

  await assert.rejects(
    session.sendLocalAssistantReply(
      store.conversation.id,
      "测试知识库失败收口",
      async () => "unused",
      [],
      {
        knowledgeBaseRouting: {
          mode: "all",
          displayName: "全部知识库",
          status: "searching",
          resultCount: 0,
          hits: []
        }
      }
    ),
    /assistant placeholder failed/
  );

  assert.equal(
    store.conversation.messages[0].knowledgeBaseRouting?.status,
    "error",
    "knowledge-base feedback must not remain searching when local reply setup fails before the assistant placeholder exists"
  );
}

function createRoutingDomNode() {
  const node = {
    children: [],
    tag: null,
    className: "",
    text: "",
    createDiv(options = {}) {
      const child = createRoutingDomNode();
      child.className = options.cls ?? "";
      child.text = options.text ?? "";
      node.children.push(child);
      return child;
    },
    createSpan(options = {}) {
      const child = createRoutingDomNode();
      child.className = options.cls ?? "";
      child.text = options.text ?? "";
      node.children.push(child);
      return child;
    },
    createEl(tag, options = {}) {
      const child = createRoutingDomNode();
      child.tag = tag;
      child.className = options.cls ?? "";
      node.children.push(child);
      return child;
    },
    setAttribute() {
      // no-op
    },
    addEventListener() {
      // no-op
    }
  };
  return node;
}

function collectRoutingNodes(node, className, collected = []) {
  if (node.className === className) {
    collected.push(node);
  }
  for (const child of node.children) {
    collectRoutingNodes(child, className, collected);
  }
  return collected;
}

function assertKnowledgeBaseRoutingRendersHitsOnReplySurface(module) {
  const completeRouting = {
    mode: "single",
    displayName: "Sidet Wiki",
    status: "complete",
    resultCount: 2,
    hits: [
      { path: "Sidet/Wiki/Index.md", basename: "Index", kindLabel: "知识库根页" },
      { path: "Sidet/Wiki/同步.md", basename: "同步", kindLabel: "知识卡" }
    ]
  };

  const hitParent = createRoutingDomNode();
  module.renderMessageKnowledgeBaseRouting(hitParent, completeRouting, { controller: {} });
  assert.equal(hitParent.children.length, 1, "complete routing should render exactly one container on the reply surface");
  const hitContainers = collectRoutingNodes(hitParent, "sidet-message-routing-hint");
  assert.equal(hitContainers.length, 1, "complete routing should not rebuild the user-bubble header block");
  assert.equal(collectRoutingNodes(hitParent, "sidet-message-routing-hint-header").length, 0, "scope header must stay out of the reply surface block");
  assert.equal(collectRoutingNodes(hitParent, "sidet-message-routing-hint-note").length, 0, "hit count note must stay out of the reply surface block");
  const hitButtons = collectRoutingNodes(hitParent, "sidet-message-routing-hit");
  assert.equal(hitButtons.length, 2, "every routing hit should render as one openable file entry at the reply bottom");

  const emptyParent = createRoutingDomNode();
  module.renderMessageKnowledgeBaseRouting(
    emptyParent,
    { ...completeRouting, hits: [], resultCount: 0 },
    { controller: {} }
  );
  assert.equal(emptyParent.children.length, 0, "complete routing without hits should not render an empty container");

  const errorParent = createRoutingDomNode();
  module.renderMessageKnowledgeBaseRouting(
    errorParent,
    { ...completeRouting, status: "error", hits: [], resultCount: 0 },
    { controller: {} }
  );
  const errorNotes = collectRoutingNodes(errorParent, "sidet-message-routing-hint-note");
  assert.equal(errorNotes.length, 1, "failed searches should keep a retry hint on the reply surface");
  assert.equal(errorNotes[0].text, "知识库检索失败，请重新发送");
  assert.equal(collectRoutingNodes(errorParent, "sidet-message-routing-hit").length, 0, "failed searches should not render hit entries");
}

function createKnowledgeBaseMatch(overrides = {}) {
  return {
    file: { path: "Sidet/Wiki/示例.md", basename: "示例" },
    kind: "knowledge-card",
    score: 1,
    summary: "这是命中笔记的摘要内容。",
    outline: [],
    relatedLinks: [],
    sourceLinks: [],
    matchedTerms: ["侧栏", "输入框"],
    matchedFragments: ["…点击侧栏的输入框…"],
    excerpt: "正文摘录。",
    truncated: false,
    routeHint: "先读摘要，再按大纲或相关链接决定是否展开正文。",
    structured: true,
    ...overrides
  };
}

async function assertKnowledgeBaseReplyMarkdownStaysLean(module) {
  const matches = [
    createKnowledgeBaseMatch({ file: { path: "Sidet/Wiki/侧栏.md", basename: "侧栏" } }),
    createKnowledgeBaseMatch({
      file: { path: "Sidet/Wiki/摘录回退.md", basename: "摘录回退" },
      matchedFragments: []
    }),
    createKnowledgeBaseMatch({ file: { path: "Sidet/Wiki/第三篇.md", basename: "第三篇" } }),
    createKnowledgeBaseMatch({ file: { path: "Sidet/Wiki/第四篇.md", basename: "第四篇" } }),
    createKnowledgeBaseMatch({ file: { path: "Sidet/Wiki/第五篇.md", basename: "第五篇" } }),
    createKnowledgeBaseMatch({ file: { path: "Sidet/Wiki/第六篇.md", basename: "第六篇" } })
  ];
  const builder = new module.VaultAgentKnowledgeBaseSearchBuilder({
    wikiKnowledgeIndex: {
      findKnowledgeBaseByIndexPath: (indexPath) => indexPath === "Sidet/Wiki/Index.md"
        ? {
            rootPath: "Sidet/Wiki",
            indexPath: "Sidet/Wiki/Index.md",
            displayName: "Sidet Wiki",
            summary: "",
            files: []
          }
        : null,
      findRelevantEntries: async (query) => query === "侧栏输入框" ? matches : []
    }
  });

  const result = await builder.build("侧栏输入框", [], "Sidet/Wiki/Index.md");
  assert.ok(result, "selected knowledge base should produce a local search reply");
  const markdown = result.responseMarkdown;

  assert.match(markdown, /^# 知识库检索结果/, "reply should keep its result title");
  assert.match(markdown, /- 范围：Sidet Wiki/, "reply should keep the selected scope");
  assert.match(markdown, /- 命中：6 篇/, "reply should keep the total hit count");
  assert.match(markdown, /命中片段：/, "fragments stay as the single per-hit content line");
  assert.match(markdown, /摘录：/, "excerpt fallback stays when a match has no fragments");
  assert.doesNotMatch(markdown, /摘要：/, "summary lines must not duplicate the fragment line");
  assert.doesNotMatch(markdown, /读取：/, "route hint instructions must leave the user-facing reply");
  assert.doesNotMatch(markdown, /模式：/, "local-search mode line is implementation detail");
  assert.doesNotMatch(markdown, /根目录：/, "root path line duplicates the scope line");
  assert.doesNotMatch(markdown, /下一步建议/, "coaching sections must not append after the hits");
  assert.doesNotMatch(markdown, /未展开/, "unexpanded-count note duplicates the total hit count");
  assert.doesNotMatch(markdown, /### 5\./, "reply hit entries should align with the four routing hits");

  assert.equal(result.knowledgeBaseRouting.resultCount, 6, "routing should report the full hit count");
  assert.equal(result.knowledgeBaseRouting.hits.length, 4, "routing hits stay capped at four entries");

  const emptyResult = await builder.build("不存在的词", [], "Sidet/Wiki/Index.md");
  assert.ok(emptyResult, "empty search should still resolve");
  assert.match(emptyResult.responseMarkdown, /当前没有找到直接相关的笔记。/, "empty search keeps a direct no-hit line");
  assert.doesNotMatch(emptyResult.responseMarkdown, /## 建议/, "empty search should not keep a suggestion section shell");
  assert.equal(emptyResult.knowledgeBaseRouting.hits.length, 0, "empty search should not report hits");
}

function assertKnowledgeBaseRoutingUsesLightweightListStyling() {
  const css = readFileSync(path.join(rootDir, "styles.css"), "utf8");
  const hintRule = css.match(/\.sidet-message-routing-hint\s*\{([^}]*)\}/)?.[1] ?? "";
  const hitsRule = css.match(/\.sidet-message-routing-hits\s*\{([^}]*)\}/)?.[1] ?? "";
  const hitRule = css.match(
    /\.sidet-message-routing-hits\s*>\s*button\.sidet-message-routing-hit\s*\{([^}]*)\}/
  )?.[1] ?? "";

  assert.match(hintRule, /border:\s*0/, "routing metadata should not add a framed panel inside the user bubble");
  assert.match(hintRule, /background:\s*transparent/, "routing metadata should reuse the user bubble surface");
  assert.match(hitsRule, /flex-direction:\s*column/, "knowledge-base hits should read as one lightweight list");
  assert.match(hitRule, /border:\s*0/, "individual hits should not render as outlined pills");
  assert.match(hitRule, /background:\s*transparent/, "individual hits should not add nested card surfaces");
  assert.match(hitRule, /box-shadow:\s*none/, "individual hits should not inherit a raised button surface");
  assert.doesNotMatch(
    css,
    /(?<!button)\.sidet-message-routing-hit\s*\{/,
    "the lightweight hit rule must retain enough specificity to beat Obsidian's default button surface"
  );
}

function assertFastKnowledgeBaseSearchDoesNotRenderTransientRouting(module) {
  let rootChildCount = 0;
  const createNode = () => ({
    createDiv() {
      return createNode();
    },
    createSpan() {
      return createNode();
    },
    createEl() {
      return createNode();
    },
    setAttribute() {
      // no-op
    },
    addEventListener() {
      // no-op
    }
  });
  const parentEl = {
    createDiv() {
      rootChildCount += 1;
      return createNode();
    }
  };

  module.renderMessageKnowledgeBaseRouting(
    parentEl,
    {
      mode: "all",
      displayName: "全部知识库",
      status: "searching",
      resultCount: 0,
      hits: []
    },
    {
      controller: {}
    }
  );

  assert.equal(
    rootChildCount,
    0,
    "fast local knowledge-base searches should not flash a transient routing block before the result is ready"
  );
}

async function main() {
  try {
    const sessionModule = await loadBundledModule("src/conversations/conversation-session.ts");
    const routingModule = await loadBundledModule("src/workspace/chat-message-knowledge-base-routing.ts");
    const searchModule = await loadBundledModule("src/agent/knowledge/vault-agent-knowledge-base-search.ts");
    await assertLocalAssistantStreamingStopsEarly(sessionModule);
    await assertLocalAssistantStreamingCollectsFullReply(sessionModule);
    await assertLocalAssistantReplyStartsBeforeReplyFactoryResolves(sessionModule);
    await assertLocalAssistantReplyFailureEndsSearchingState(sessionModule);
    await assertKnowledgeBaseReplyMarkdownStaysLean(searchModule);
    assertKnowledgeBaseRoutingUsesLightweightListStyling();
    assertFastKnowledgeBaseSearchDoesNotRenderTransientRouting(routingModule);
    assertKnowledgeBaseRoutingRendersHitsOnReplySurface(routingModule);
    console.log("local assistant stream logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
