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
  assert.equal(conversation.messages.length, 2, "empty streaming messages should be dropped");
  assert.equal(conversation.messages[0].status, "error", "partial streaming messages should downgrade to error");
  assert.equal(conversation.messages[0].metaPanels?.[0]?.label, "联网过程", "valid meta panels should survive repair");
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

async function main() {
  try {
    const [messageRuntimeModule, recordsModule, constantsModule] = await Promise.all([
      loadBundledModule("src/conversations/conversation-store-message-runtime.ts"),
      loadBundledModule("src/conversations/conversation-store-records.ts"),
      loadBundledModule("src/constants.ts")
    ]);

    assertRepairConversationRecord(recordsModule, constantsModule);
    await assertAppendUserMessageBehavior(messageRuntimeModule, recordsModule, constantsModule);
    await assertDeleteMessagesBetweenRetitlesConversation(messageRuntimeModule, recordsModule);
    await assertPruneClearsStreamingAndBuildProviderMessages(messageRuntimeModule, recordsModule);
    await assertAssistantReasoningLabelBehavior(messageRuntimeModule);
    await assertWebProcessPanelDedupesBehavior(messageRuntimeModule);

    console.log("conversation store logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
