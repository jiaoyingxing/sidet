import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-conversation-logic-"));
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

function createRuntimeHarness(ConversationStoreMessageRuntime, conversation) {
  let streamingConversationId = null;
  let saveCount = 0;
  let scheduleCount = 0;
  let storeChangeCount = 0;
  const chunkEvents = [];
  const conversations = new Map([[conversation.id, conversation]]);

  const runtime = new ConversationStoreMessageRuntime({
    requireConversation: (conversationId) => {
      const current = conversations.get(conversationId);
      if (!current) {
        throw new Error(`Missing conversation: ${conversationId}`);
      }
      return current;
    },
    requireMessage: (currentConversation, messageId) => {
      const message = currentConversation.messages.find((item) => item.id === messageId);
      if (!message) {
        throw new Error(`Missing message: ${messageId}`);
      }
      return message;
    },
    saveImmediately: async () => {
      saveCount += 1;
    },
    scheduleSave: () => {
      scheduleCount += 1;
    },
    getStreamingConversationId: () => streamingConversationId,
    setStreamingConversationId: (conversationId) => {
      streamingConversationId = conversationId;
    },
    emitStoreChange: () => {
      storeChangeCount += 1;
    },
    emitAssistantChunk: (event) => {
      chunkEvents.push(event);
    }
  });

  return {
    runtime,
    get saveCount() {
      return saveCount;
    },
    get scheduleCount() {
      return scheduleCount;
    },
    get storeChangeCount() {
      return storeChangeCount;
    },
    get chunkEvents() {
      return chunkEvents;
    },
    get streamingConversationId() {
      return streamingConversationId;
    },
    set streamingConversationId(value) {
      streamingConversationId = value;
    }
  };
}

function createConversation(overrides = {}) {
  return {
    id: "conversation-1",
    title: "新对话",
    createdAt: 1,
    updatedAt: 1,
    isPinned: false,
    folderId: null,
    messages: [],
    ...overrides
  };
}

function createMessage(overrides = {}) {
  return {
    id: "message-1",
    role: "user",
    text: "",
    createdAt: 1,
    status: "done",
    ...overrides
  };
}

function assertRepairConversationRecord(recordsModule, constantsModule) {
  const { repairConversationRecord } = recordsModule;
  const { UNTITLED_CONVERSATION_TITLE } = constantsModule;

  const source = {
    id: "conversation-1",
    title: "   ",
    createdAt: 1,
    updatedAt: 1,
    isPinned: "yes",
    folderId: "missing-folder",
    draft: 42,
    messages: [
      createMessage({
        id: "assistant-empty",
        role: "assistant",
        status: "streaming",
        text: "",
        reasoningText: ""
      }),
      createMessage({
        id: "assistant-partial",
        role: "assistant",
        status: "streaming",
        text: "partial answer",
        metaPanels: [
          {
            kind: "web-process",
            label: "联网过程",
            text: "正在搜索"
          }
        ]
      }),
      createMessage({
        id: "assistant-streaming-with-history",
        role: "assistant",
        status: "streaming",
        text: "",
        answerVariants: [
          {
            id: "assistant-old",
            text: "旧回答",
            status: "done",
            createdAt: 1
          }
        ],
        activeAnswerVariantIndex: 1
      }),
      createMessage({
        id: "user-1",
        role: "user",
        text: "hello"
      })
    ]
  };

  const { conversation, repaired } = repairConversationRecord(source, new Set(["folder-1"]));
  assert.equal(repaired, true, "repairConversationRecord should report repairs");
  assert.equal(conversation.title, UNTITLED_CONVERSATION_TITLE, "blank titles should fall back to untitled");
  assert.equal(conversation.isPinned, false, "non-boolean isPinned should normalize to false");
  assert.equal(conversation.folderId, null, "invalid folder references should be dropped");
  assert.equal(conversation.draft, undefined, "non-string drafts should be removed");
  assert.equal(conversation.messages.length, 3, "empty streaming messages should be dropped");
  assert.equal(conversation.messages[0].status, "error", "partial streaming messages should downgrade to error");
  assert.equal(conversation.messages[0].metaPanels?.[0]?.label, "联网过程", "valid meta panels should survive repair");
  assert.equal(
    conversation.messages[1].status,
    "error",
    "an interrupted streaming message carrying answer variants must survive repair"
  );
  assert.equal(
    conversation.messages[1].answerVariants?.[0]?.text,
    "旧回答",
    "the previous answer must not be lost when the replacement message has no body yet"
  );
}

async function assertAppendUserMessageBehavior(messageRuntimeModule, recordsModule, constantsModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const { buildConversationTitle } = recordsModule;
  const { UNTITLED_CONVERSATION_TITLE } = constantsModule;

  const conversation = createConversation({
    title: UNTITLED_CONVERSATION_TITLE
  });
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);

  const message = await harness.runtime.appendUserMessage(
    conversation.id,
    "This is a long enough first user message for title derivation."
  );

  assert.equal(message.role, "user");
  assert.equal(conversation.messages.length, 1, "appendUserMessage should append a user message");
  assert.equal(
    conversation.title,
    buildConversationTitle("This is a long enough first user message for title derivation."),
    "untitled conversations should derive their title from the first user message"
  );
  assert.equal(harness.saveCount, 1, "appendUserMessage should persist immediately");
  assert.equal(harness.storeChangeCount, 1, "appendUserMessage should emit a store change");
}

async function assertDeleteMessagesBetweenRetitlesConversation(messageRuntimeModule, recordsModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const { buildConversationTitle } = recordsModule;

  const firstText = "First topic for automatic title";
  const secondText = "Second topic after rewrite";
  const conversation = createConversation({
    title: buildConversationTitle(firstText),
    messages: [
      createMessage({ id: "user-1", role: "user", text: firstText }),
      createMessage({ id: "assistant-1", role: "assistant", text: "reply 1" }),
      createMessage({ id: "user-2", role: "user", text: secondText }),
      createMessage({ id: "assistant-2", role: "assistant", text: "reply 2" })
    ]
  });
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);

  await harness.runtime.deleteMessagesBetween(conversation.id, "user-1", "user-2");

  assert.deepEqual(
    conversation.messages.map((message) => message.id),
    ["user-2", "assistant-2"],
    "deleteMessagesBetween should remove the replacement range"
  );
  assert.equal(
    conversation.title,
    buildConversationTitle(secondText),
    "deleting the leading user range should restore the next auto-derived title"
  );
  assert.equal(harness.saveCount, 1, "deleteMessagesBetween should persist immediately");
  assert.equal(harness.storeChangeCount, 1, "deleteMessagesBetween should emit a store change");
}

async function assertPruneClearsStreamingAndBuildProviderMessages(messageRuntimeModule, recordsModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const { buildConversationTitle } = recordsModule;

  const conversation = createConversation({
    title: buildConversationTitle("First topic"),
    messages: [
      createMessage({ id: "user-1", role: "user", text: "First topic" }),
      createMessage({ id: "assistant-1", role: "assistant", text: "reply 1" }),
      createMessage({ id: "assistant-stream", role: "assistant", text: "", status: "streaming" }),
      createMessage({ id: "user-2", role: "user", text: "later question" })
    ]
  });
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);
  harness.streamingConversationId = conversation.id;

  const providerMessages = harness.runtime.buildProviderMessages(conversation.id);
  assert.deepEqual(
    providerMessages.map((message) => message.id),
    ["user-1", "assistant-1", "user-2"],
    "buildProviderMessages should exclude streaming messages"
  );

  await harness.runtime.pruneConversationAfterMessage(conversation.id, "assistant-1");
  assert.deepEqual(
    conversation.messages.map((message) => message.id),
    ["user-1", "assistant-1"],
    "pruneConversationAfterMessage should trim trailing messages"
  );
  assert.equal(harness.streamingConversationId, null, "pruning should clear the streaming marker");
  assert.equal(harness.saveCount, 1, "pruning should persist immediately");
}

async function assertAssistantReasoningLabelBehavior(messageRuntimeModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const conversation = createConversation();
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);

  const assistantMessage = await harness.runtime.beginAssistantMessage(conversation.id, {
    reasoningLabel: "联网搜索"
  });
  assert.equal(assistantMessage.reasoningLabel, "联网搜索", "beginAssistantMessage should keep custom reasoning labels");

  harness.runtime.appendAssistantReasoningChunk(conversation.id, assistantMessage.id, "正在请求 Bing\n");
  assert.equal(
    conversation.messages[0]?.reasoningText,
    "正在请求 Bing\n",
    "appendAssistantReasoningChunk should accumulate local progress text"
  );
  assert.equal(harness.chunkEvents.at(-1)?.segment, "reasoning", "reasoning updates should emit reasoning chunk events");

  const webFetchPanel = {
    kind: "web-fetch-round-1",
    label: "网页抓取"
  };
  harness.runtime.appendAssistantMetaPanelChunk(conversation.id, assistantMessage.id, webFetchPanel, "第 1 轮：开始联网搜索。\n");
  harness.runtime.replaceAssistantMetaPanelSources(conversation.id, assistantMessage.id, webFetchPanel, [
    {
      title: "Sidet Repo",
      url: "https://example.com/sidet",
      host: "example.com",
      note: "repo"
    }
  ]);
  harness.runtime.appendAssistantMetaPanelChunk(conversation.id, assistantMessage.id, {
    kind: "reasoning-2",
    label: "深度思考"
  }, "继续判断下一步。\n");
  assert.equal(
    conversation.messages[0]?.metaPanels?.[0]?.text,
    "第 1 轮：开始联网搜索。\n",
    "appendAssistantMetaPanelChunk should accumulate process text in a dedicated panel"
  );
  assert.equal(
    conversation.messages[0]?.metaPanels?.[0]?.sources?.[0]?.title,
    "Sidet Repo",
    "replaceAssistantMetaPanelSources should attach source list to the active panel"
  );
  assert.equal(
    conversation.messages[0]?.metaPanels?.[1]?.label,
    "深度思考",
    "meta panels should keep later panels in append order"
  );
  assert.equal(harness.chunkEvents.at(-1)?.segment, "meta", "meta panel updates should emit meta chunk events");
}

async function assertWebProcessPanelDedupesBehavior(messageRuntimeModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const conversation = createConversation();
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);
  const assistantMessage = await harness.runtime.beginAssistantMessage(conversation.id);
  const webProcessPanel = {
    kind: "web-process",
    label: "深度思考"
  };

  harness.runtime.appendAssistantMetaPanelChunk(
    conversation.id,
    assistantMessage.id,
    webProcessPanel,
    "我先确认要不要联网。\n"
  );
  harness.runtime.appendAssistantMetaPanelChunk(
    conversation.id,
    assistantMessage.id,
    webProcessPanel,
    "我先确认要不要联网。\n"
  );
  harness.runtime.replaceAssistantMetaPanelSources(conversation.id, assistantMessage.id, webProcessPanel, [
    {
      title: "Sidet Repo",
      url: "https://example.com/sidet",
      host: "example.com",
      note: "repo"
    }
  ]);
  harness.runtime.replaceAssistantMetaPanelSources(conversation.id, assistantMessage.id, webProcessPanel, [
    {
      title: "Sidet Repo",
      url: "https://example.com/sidet",
      host: "example.com",
      note: "repo"
    },
    {
      title: "Sidet Docs",
      url: "https://example.com/docs",
      host: "example.com",
      note: "docs"
    }
  ]);

  const panel = conversation.messages[0]?.metaPanels?.[0];
  assert.equal(
    panel?.text,
    "我先确认要不要联网。\n",
    "same web-process text should not be appended twice"
  );
  assert.equal(
    panel?.sources?.length ?? 0,
    2,
    "web-process sources should merge across rounds and dedupe repeated entries"
  );
}

async function assertAssistantSourcesAndErrorTextBehavior(messageRuntimeModule) {
  const conversation = createConversation();
  const harness = createRuntimeHarness(messageRuntimeModule.ConversationStoreMessageRuntime, conversation);

  const partialMessage = await harness.runtime.beginAssistantMessage(conversation.id);
  harness.runtime.appendAssistantChunk(conversation.id, partialMessage.id, "回答到一半");
  await harness.runtime.failAssistantMessage(conversation.id, partialMessage.id, "网络连接中断");

  assert.equal(partialMessage.status, "error");
  assert.equal(partialMessage.text, "回答到一半", "partial assistant text should be preserved");
  assert.equal(partialMessage.errorText, "网络连接中断", "error reason should be stored separately");

  const sourcedMessage = await harness.runtime.beginAssistantMessage(conversation.id);
  harness.runtime.setAssistantSources(conversation.id, sourcedMessage.id, [
    {
      title: "DeepSeek V4 发布",
      url: "https://example.com/v4",
      host: "example.com",
      note: "1M context",
      readDepth: "full"
    },
    {
      title: "检索结果",
      url: "https://example.com/search",
      host: "example.com",
      readDepth: "summary"
    }
  ]);
  assert.equal(sourcedMessage.sources?.length, 2);
  assert.equal(sourcedMessage.sources?.[0]?.readDepth, "full");
  assert.equal(sourcedMessage.sources?.[1]?.readDepth, "summary");

  await harness.runtime.finishAssistantMessage(conversation.id, sourcedMessage.id);
  assert.equal(sourcedMessage.errorText, undefined);
}

async function assertRegenerateKeepsPreviousAnswerAsVariant(messageRuntimeModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const conversation = createConversation({
    messages: [
      createMessage({ id: "user-1", role: "user", text: "问题" }),
      createMessage({ id: "assistant-1", role: "assistant", text: "第一版回答" })
    ]
  });
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);

  const replacementUser = await harness.runtime.appendUserMessage(conversation.id, "问题");
  const newAssistant = await harness.runtime.beginAssistantMessage(conversation.id, {
    variantOfMessageId: "assistant-1"
  });

  assert.deepEqual(
    newAssistant.answerVariants?.map((variant) => variant.text),
    ["第一版回答"],
    "regeneration should keep the previous answer as the first variant"
  );
  assert.equal(newAssistant.activeAnswerVariantIndex, 1, "the new answer should be the active variant");

  harness.runtime.appendAssistantChunk(conversation.id, newAssistant.id, "第二版回答");
  await harness.runtime.finishAssistantMessage(conversation.id, newAssistant.id);
  await harness.runtime.deleteMessagesBetween(conversation.id, "user-1", replacementUser.id);

  assert.deepEqual(
    conversation.messages.map((message) => message.id),
    [replacementUser.id, newAssistant.id],
    "the replacement commit should remove the old user turn"
  );
  assert.equal(newAssistant.text, "第二版回答", "the new answer remains the active payload");
  assert.equal(newAssistant.answerVariants?.[0]?.text, "第一版回答", "the previous answer survives on the new message");

  const providerMessages = harness.runtime.buildProviderMessages(conversation.id);
  assert.equal(providerMessages.at(-1)?.text, "第二版回答", "provider context should use the active answer");
  assert.equal(
    JSON.stringify(providerMessages).includes("第一版回答"),
    false,
    "inactive answer variants must not leak into provider context"
  );
}

async function assertSelectAnswerVariantSwitchesActivePayload(messageRuntimeModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const conversation = createConversation({
    messages: [
      createMessage({ id: "user-1", role: "user", text: "问题" }),
      createMessage({
        id: "assistant-2",
        role: "assistant",
        text: "第二版回答",
        sources: [
          { title: "来源二", url: "https://example.com/2", readDepth: "summary" }
        ],
        answerVariants: [
          {
            id: "assistant-1",
            text: "第一版回答",
            status: "done",
            createdAt: 1,
            sources: [
              { title: "来源一", url: "https://example.com/1", readDepth: "full" }
            ]
          }
        ],
        activeAnswerVariantIndex: 1
      })
    ]
  });
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);
  const message = conversation.messages[1];

  await harness.runtime.selectAnswerVariant(conversation.id, message.id, 0);
  assert.equal(message.text, "第一版回答", "selecting the first variant should materialize it");
  assert.equal(message.sources?.[0]?.title, "来源一", "variant sources should follow the active version");
  assert.equal(message.answerVariants?.length, 1, "the previous active version should be stored back");
  assert.equal(message.answerVariants?.[0]?.text, "第二版回答");
  assert.equal(message.activeAnswerVariantIndex, 0);

  await harness.runtime.selectAnswerVariant(conversation.id, message.id, 1);
  assert.equal(message.text, "第二版回答", "switching back should restore the newer answer");
  assert.equal(message.sources?.[0]?.title, "来源二");
  assert.equal(message.activeAnswerVariantIndex, 1);
  assert.equal(harness.storeChangeCount, 2, "each switch should emit one store change");
}

async function assertErrorAnswerVariantsAreNotInheritedUnlessHistoryExists(messageRuntimeModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const plainError = createConversation({
    messages: [
      createMessage({ id: "user-1", role: "user", text: "问题" }),
      createMessage({
        id: "assistant-error",
        role: "assistant",
        text: "错误说明",
        status: "error",
        errorText: "网络连接中断"
      })
    ]
  });
  const plainHarness = createRuntimeHarness(ConversationStoreMessageRuntime, plainError);
  const plainRetry = await plainHarness.runtime.beginAssistantMessage(plainError.id, {
    variantOfMessageId: "assistant-error"
  });
  assert.equal(plainRetry.answerVariants, undefined, "a plain failure should be replaced, not versioned");
  assert.equal(plainRetry.activeAnswerVariantIndex, undefined);

  const errorWithHistory = createConversation({
    id: "conversation-2",
    messages: [
      createMessage({ id: "user-1", role: "user", text: "问题" }),
      createMessage({
        id: "assistant-error-history",
        role: "assistant",
        text: "错误说明",
        status: "error",
        errorText: "网络连接中断",
        answerVariants: [
          { id: "assistant-old", text: "旧回答", status: "done", createdAt: 1 }
        ],
        activeAnswerVariantIndex: 1
      })
    ]
  });
  const historyHarness = createRuntimeHarness(ConversationStoreMessageRuntime, errorWithHistory);
  const historyRetry = await historyHarness.runtime.beginAssistantMessage(errorWithHistory.id, {
    variantOfMessageId: "assistant-error-history"
  });
  assert.deepEqual(
    historyRetry.answerVariants?.map((variant) => variant.text),
    ["旧回答", "错误说明"],
    "retrying an error that is already part of a version history should keep the whole history"
  );
  assert.equal(historyRetry.activeAnswerVariantIndex, 2);
}

function assertRepairAnswerVariants(recordsModule, constantsModule) {
  const { repairConversationRecord } = recordsModule;
  const validVariant = {
    id: "assistant-1",
    text: "第一版回答",
    status: "done",
    createdAt: 1,
    sources: [
      { title: "来源一", url: "https://example.com/1", readDepth: "full" }
    ]
  };
  const source = {
    ...createConversation(),
    messages: [
      createMessage({
        id: "assistant-2",
        role: "assistant",
        text: "第二版回答",
        answerVariants: [
          validVariant,
          {
            id: "assistant-streaming",
            text: "不完整",
            status: "streaming",
            createdAt: 2
          },
          {
            text: "缺少 id",
            status: "done",
            createdAt: 3
          }
        ],
        activeAnswerVariantIndex: 99
      })
    ]
  };

  const { conversation, repaired } = repairConversationRecord(source, new Set());
  assert.equal(repaired, true, "invalid answer variants should report a repair");
  assert.equal(conversation.messages[0].answerVariants?.length, 1, "invalid and streaming variants should be dropped");
  assert.equal(conversation.messages[0].answerVariants?.[0]?.text, "第一版回答");
  assert.equal(conversation.messages[0].activeAnswerVariantIndex, 1, "out-of-range active indexes should fall back to the newest version");

  const idempotentSource = {
    ...createConversation(),
    isArchived: false,
    archivedAt: null,
    modelConfigId: null,
    messages: [
      createMessage({
        id: "assistant-2",
        role: "assistant",
        text: "第二版回答",
        answerVariants: [validVariant],
        activeAnswerVariantIndex: 0
      })
    ]
  };
  const idempotent = repairConversationRecord(idempotentSource, new Set());
  assert.equal(idempotent.repaired, false, "valid answer variants should not be rewritten on load");
  assert.equal(
    idempotent.conversation.messages[0].answerVariants,
    idempotentSource.messages[0].answerVariants,
    "valid variant arrays should keep their identity for idempotent repair"
  );
}

function assertCloneDeepCopiesAnswerVariants(recordsModule) {
  const { cloneConversation } = recordsModule;
  const conversation = createConversation({
    messages: [
      createMessage({
        id: "assistant-2",
        role: "assistant",
        text: "第二版回答",
        answerVariants: [
          {
            id: "assistant-1",
            text: "第一版回答",
            status: "done",
            createdAt: 1,
            sources: [
              { title: "原始来源", url: "https://example.com/1", readDepth: "full" }
            ]
          }
        ],
        activeAnswerVariantIndex: 1
      })
    ]
  });

  const clone = cloneConversation(conversation);
  assert.notEqual(clone.messages[0].answerVariants, conversation.messages[0].answerVariants);
  assert.notEqual(
    clone.messages[0].answerVariants?.[0]?.sources,
    conversation.messages[0].answerVariants?.[0]?.sources
  );
  clone.messages[0].answerVariants[0].sources[0].title = "克隆后修改";
  assert.equal(
    conversation.messages[0].answerVariants?.[0]?.sources?.[0]?.title,
    "原始来源",
    "cloning should deep-copy variant sources"
  );
}

function createSummaryMessage(id, role, text) {
  return createMessage({ id, role, text });
}

function assertContextSummaryRepairAndClone(recordsModule, constantsModule) {
  const { repairConversationRecord, cloneConversation } = recordsModule;
  const messages = [
    createSummaryMessage("user-1", "user", "问题"),
    createSummaryMessage("assistant-1", "assistant", "回答")
  ];
  const summary = {
    text: "背景摘要",
    summarizedThroughMessageId: "assistant-1",
    updatedAt: 1
  };
  const validConversation = {
    ...createConversation(),
    isArchived: false,
    archivedAt: null,
    modelConfigId: null,
    messages,
    contextSummary: summary
  };

  const valid = repairConversationRecord(validConversation, new Set());
  assert.equal(valid.repaired, false, "valid context summaries should not be rewritten");
  assert.equal(valid.conversation.contextSummary, summary, "valid context summaries should keep their identity");

  const missingAnchor = repairConversationRecord({
    ...validConversation,
    contextSummary: {
      ...summary,
      summarizedThroughMessageId: "missing-message"
    }
  }, new Set());
  assert.equal(missingAnchor.repaired, true);
  assert.equal(
    missingAnchor.conversation.contextSummary,
    undefined,
    "summaries with a missing anchor should be dropped"
  );

  const clone = cloneConversation(validConversation);
  assert.notEqual(clone.contextSummary, validConversation.contextSummary);
  clone.contextSummary.text = "克隆后修改";
  assert.equal(validConversation.contextSummary.text, "背景摘要", "cloning should copy the summary");
}

async function assertContextSummarySetAndPrune(messageRuntimeModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const conversation = createConversation({
    messages: [
      createSummaryMessage("user-1", "user", "问题"),
      createSummaryMessage("assistant-1", "assistant", "回答"),
      createSummaryMessage("user-2", "user", "继续")
    ],
    contextSummary: {
      text: "背景摘要",
      summarizedThroughMessageId: "assistant-1",
      updatedAt: 1
    }
  });
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);

  await harness.runtime.setContextSummary(conversation.id, {
    text: "新摘要",
    summarizedThroughMessageId: "user-1",
    updatedAt: 2
  });
  assert.equal(conversation.contextSummary?.text, "新摘要");
  assert.equal(harness.saveCount, 1, "setting a summary should persist immediately");
  assert.equal(harness.storeChangeCount, 0, "summary changes should not trigger a visible store change");

  await harness.runtime.removeMessage(conversation.id, "user-1");
  assert.equal(
    conversation.contextSummary,
    undefined,
    "removing the summary anchor should drop the summary"
  );
}

async function assertArchivedAnswerVariantSwitchIsRejected(messageRuntimeModule) {
  const { ConversationStoreMessageRuntime } = messageRuntimeModule;
  const conversation = createConversation({
    isArchived: true,
    messages: [
      createMessage({ id: "user-1", role: "user", text: "问题" }),
      createMessage({
        id: "assistant-2",
        role: "assistant",
        text: "第二版回答",
        status: "done",
        answerVariants: [
          { id: "assistant-1", text: "第一版回答", status: "done", createdAt: 1 }
        ],
        activeAnswerVariantIndex: 1
      })
    ]
  });
  const harness = createRuntimeHarness(ConversationStoreMessageRuntime, conversation);

  await assert.rejects(
    () => harness.runtime.selectAnswerVariant(conversation.id, "assistant-2", 0),
    /已归档/,
    "archived conversations must stay read-only for version switching"
  );
  assert.equal(conversation.messages[1].text, "第二版回答", "rejected switches must not mutate archived messages");
  assert.equal(harness.storeChangeCount, 0, "rejected archived switches must not emit a store change");
}

async function main() {
  try {
    const [messageRuntimeModule, recordsModule, constantsModule] = await Promise.all([
      loadBundledModule("src/conversations/conversation-store-message-runtime.ts"),
      loadBundledModule("src/conversations/conversation-store-records.ts"),
      loadBundledModule("src/constants.ts")
    ]);

    assertRepairConversationRecord(recordsModule, constantsModule);
    assertRepairAnswerVariants(recordsModule, constantsModule);
    assertCloneDeepCopiesAnswerVariants(recordsModule);
    assertContextSummaryRepairAndClone(recordsModule, constantsModule);
    await assertContextSummarySetAndPrune(messageRuntimeModule);
    await assertRegenerateKeepsPreviousAnswerAsVariant(messageRuntimeModule);
    await assertSelectAnswerVariantSwitchesActivePayload(messageRuntimeModule);
    await assertErrorAnswerVariantsAreNotInheritedUnlessHistoryExists(messageRuntimeModule);
    await assertArchivedAnswerVariantSwitchIsRejected(messageRuntimeModule);
    await assertAppendUserMessageBehavior(messageRuntimeModule, recordsModule, constantsModule);
    await assertDeleteMessagesBetweenRetitlesConversation(messageRuntimeModule, recordsModule);
    await assertPruneClearsStreamingAndBuildProviderMessages(messageRuntimeModule, recordsModule);
    await assertAssistantReasoningLabelBehavior(messageRuntimeModule);
    await assertWebProcessPanelDedupesBehavior(messageRuntimeModule);
    await assertAssistantSourcesAndErrorTextBehavior(messageRuntimeModule);

    console.log("conversation store logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
