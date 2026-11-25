import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-chat-draft-runtime-"));
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

function createHarness(ChatViewDraftRuntime) {
  let localDraft = "编辑后的消息";
  let attachments = [];
  let editingState = {
    conversationId: "conversation-1",
    messageId: "user-1",
    originalDraft: "原草稿",
    originalAttachments: [],
    originalKnowledgeBaseIndexPath: "Sidet/Wiki/Index.md",
    originalWebSearchEnabled: true
  };
  let chipSyncCount = 0;
  let buttonSyncCount = 0;
  let clearDraftAttachmentCount = 0;
  let focusActiveCount = 0;
  let requestContextPrefix = null;
  const sendErrors = [];
  const controller = {
    currentModelSupportsImageInput: () => true,
    isLeafConversationArchived: () => false,
    tryHandleConversationKnowledgeCommandFromChat: () => false,
    setComposerDraft: () => undefined,
    sendMessageFromLeaf: async () => undefined
  };

  const runtime = new ChatViewDraftRuntime({
    controller,
    leaf: {},
    getLocalDraft: () => localDraft,
    setLocalDraftValue: (draft) => {
      localDraft = draft;
    },
    getDraftOrigin: () => "test",
    getLastFocusComposerNonce: () => 0,
    setLastFocusComposerNonce: () => undefined,
    getTextareaEl: () => null,
    getPreferredComposerTextarea: () => null,
    focusComposerTextarea: () => undefined,
    focusActiveComposerTextarea: () => {
      focusActiveCount += 1;
    },
    scheduleViewportSync: () => undefined,
    syncComposerLayout: () => undefined,
    syncComposerButtons: () => {
      buttonSyncCount += 1;
    },
    getDraftAttachments: () => attachments,
    clearDraftAttachments: () => {
      attachments = [];
      clearDraftAttachmentCount += 1;
      chipSyncCount += 1;
      buttonSyncCount += 1;
    },
    setDraftAttachments: (nextAttachments) => {
      attachments = [...nextAttachments];
    },
    syncDraftAttachmentChips: () => {
      chipSyncCount += 1;
    },
    addWebpageAttachmentFromUrl: async () => undefined,
    closeInlineSuggests: () => undefined,
    getEditingMessageState: () => editingState,
    hasEditingMessageState: () => Boolean(editingState),
    setEditingMessageState: (state) => {
      editingState = state;
    },
    queueScrollIntent: () => undefined,
    clearPendingScrollIntent: () => undefined,
    getRequestContextPrefix: () => requestContextPrefix,
    showSendError: (error) => {
      sendErrors.push(error);
    }
  });

  return {
    runtime,
    getLocalDraft: () => localDraft,
    setLocalDraft: (draft) => {
      localDraft = draft;
    },
    getEditingState: () => editingState,
    setEditingState: (state) => {
      editingState = state;
    },
    getAttachments: () => attachments,
    setAttachments: (nextAttachments) => {
      attachments = [...nextAttachments];
    },
    getChipSyncCount: () => chipSyncCount,
    getButtonSyncCount: () => buttonSyncCount,
    getClearDraftAttachmentCount: () => clearDraftAttachmentCount,
    getFocusActiveCount: () => focusActiveCount,
    setRequestContextPrefix: (value) => {
      requestContextPrefix = value;
    },
    getSendErrors: () => sendErrors,
    controller
  };
}

async function assertEditingStateWaitsForReplacementCommit(module) {
  const harness = createHarness(module.ChatViewDraftRuntime);
  let seenDraft = null;
  let seenAttachments = null;
  let seenKnowledgeBaseOverride = "unreached";
  let seenWebSearchEnabledOverride = "unreached";
  let editingStateBeforeCommit = null;
  let editingStateAfterCommit = "unreached";
  harness.controller.sendMessageFromLeaf = async (_leaf, draft, attachments, options) => {
    seenDraft = draft;
    seenAttachments = attachments;
    seenKnowledgeBaseOverride = options?.selectedKnowledgeBaseIndexPathOverride ?? null;
    seenWebSearchEnabledOverride = options?.webSearchEnabledOverride ?? null;
    editingStateBeforeCommit = harness.getEditingState()?.messageId ?? null;
    options?.onReplacementCommit?.();
    editingStateAfterCommit = harness.getEditingState();
  };

  const sent = await harness.runtime.handleSend();
  assert.equal(
    sent,
    true,
    `handleSend should report success: ${harness.getSendErrors().map((error) => error instanceof Error ? error.message : String(error)).join(" | ")}`
  );
  assert.equal(seenDraft, "编辑后的消息", "send should use the edited draft content");
  assert.deepEqual(seenAttachments, [], "send should forward cleared attachment list");
  assert.equal(seenKnowledgeBaseOverride, "Sidet/Wiki/Index.md", "edit resend should preserve the original knowledge base selection");
  assert.equal(seenWebSearchEnabledOverride, true, "edit resend should preserve the original web search enabled state");
  assert.equal(editingStateBeforeCommit, "user-1", "editing state should still exist before replacement commit");
  assert.equal(editingStateAfterCommit, null, "replacement commit should clear editing state");
  assert.equal(harness.getEditingState(), null, "successful replacement should leave editing state cleared");
  assert.equal(harness.getLocalDraft(), "", "draft should stay cleared after successful replacement");
  assert.equal(harness.getClearDraftAttachmentCount(), 1, "send should clear attachments once");
  assert.ok(harness.getChipSyncCount() > 0, "replacement commit should resync chips");
  assert.equal(harness.getFocusActiveCount(), 0, "send completion must not refocus the composer");
}

async function assertPostCommitErrorDoesNotRestoreEditingState(module) {
  const harness = createHarness(module.ChatViewDraftRuntime);
  harness.controller.sendMessageFromLeaf = async (_leaf, _draft, _attachments, options) => {
    options?.onReplacementCommit?.();
    throw new Error("replacement already committed");
  };

  const sent = await harness.runtime.handleSend();
  assert.equal(sent, false, "post-commit error should surface as failed send");
  assert.equal(harness.getEditingState(), null, "editing state should not be restored after replacement commit");
  assert.equal(harness.getLocalDraft(), "", "draft should stay cleared after post-commit failure");
  assert.equal(harness.getSendErrors().length, 1, "post-commit error should still be reported");
}

async function assertPreCommitErrorRestoresEditingState(module) {
  const harness = createHarness(module.ChatViewDraftRuntime);
  harness.controller.sendMessageFromLeaf = async () => {
    throw new Error("replacement not committed");
  };

  const sent = await harness.runtime.handleSend();
  assert.equal(sent, false, "pre-commit error should surface as failed send");
  assert.equal(harness.getEditingState()?.messageId, "user-1", "editing state should be restored when replacement has not committed");
  assert.equal(harness.getLocalDraft(), "编辑后的消息", "draft should be restored when replacement has not committed");
  assert.equal(harness.getSendErrors().length, 1, "pre-commit error should be reported");
}

async function assertAttachmentOnlySendStillWorks(module) {
  const harness = createHarness(module.ChatViewDraftRuntime);
  harness.setEditingState(null);
  harness.setLocalDraft("");
  harness.setAttachments([
    {
      type: "image",
      name: "diagram.png",
      content: "stub"
    }
  ]);

  let seenDraft = "unreached";
  let seenAttachments = null;
  harness.controller.sendMessageFromLeaf = async (_leaf, draft, attachments) => {
    seenDraft = draft;
    seenAttachments = attachments;
  };

  const sent = await harness.runtime.handleSend();
  assert.equal(sent, true, "attachment-only send should still go through the main send chain");
  assert.equal(seenDraft, "", "attachment-only send should keep an empty draft");
  assert.deepEqual(seenAttachments, [
    {
      type: "image",
      name: "diagram.png",
      content: "stub"
    }
  ], "attachment-only send should forward the current attachments");
}

async function assertHomeIntentContextUsesTheNormalSendChain(module) {
  const harness = createHarness(module.ChatViewDraftRuntime);
  harness.setEditingState(null);
  harness.setLocalDraft("把这个想法整理成卡片");
  harness.setRequestContextPrefix("Sidet 首页 Wiki 卡片意图");

  let seenOptions = null;
  harness.controller.sendMessageFromLeaf = async (_leaf, _draft, _attachments, options) => {
    seenOptions = options;
  };

  const sent = await harness.runtime.handleSend();
  assert.equal(sent, true);
  assert.equal(
    seenOptions?.requestContextPrefix,
    "Sidet 首页 Wiki 卡片意图",
    "the transient home intent must flow through the existing send context instead of a parallel sender"
  );
}

async function main() {
  try {
    const module = await loadBundledModule("src/workspace/chat-view-draft-runtime.ts");
    await assertEditingStateWaitsForReplacementCommit(module);
    await assertPostCommitErrorDoesNotRestoreEditingState(module);
    await assertPreCommitErrorRestoresEditingState(module);
    await assertAttachmentOnlySendStillWorks(module);
    await assertHomeIntentContextUsesTheNormalSendChain(module);
    console.log("chat draft runtime logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
