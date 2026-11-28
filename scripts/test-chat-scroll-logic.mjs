import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-chat-scroll-logic-"));
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

function installFakeWindow() {
  const frameQueue = [];
  const cancelled = new Set();
  const timeoutQueue = [];
  const clearedTimeouts = new Set();
  let nextFrameId = 1;
  let nextTimeoutId = 1;

  globalThis.window = {
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frameQueue.push({ id, callback });
      return id;
    },
    cancelAnimationFrame(id) {
      cancelled.add(id);
    },
    setTimeout(callback, delay = 0) {
      const id = nextTimeoutId++;
      timeoutQueue.push({ id, callback, delay });
      return id;
    },
    clearTimeout(id) {
      clearedTimeouts.add(id);
    }
  };

  return {
    flushFrames() {
      while (frameQueue.length > 0) {
        const { id, callback } = frameQueue.shift();
        if (cancelled.has(id)) {
          continue;
        }
        callback(0);
      }
    },
    flushTimeouts() {
      timeoutQueue.sort((left, right) => left.delay - right.delay);
      while (timeoutQueue.length > 0) {
        const { id, callback } = timeoutQueue.shift();
        if (clearedTimeouts.has(id)) {
          continue;
        }
        callback();
      }
    }
  };
}

function createRendering(module) {
  const scrollHost = {
    scrollTop: 160,
    scrollHeight: 1200,
    clientHeight: 400
  };
  let pinnedToBottom = false;
  let syncCalls = 0;

  const rendering = new module.ChatViewAssistantRendering({
    getApp: () => ({
      workspace: {
        getActiveFile: () => null
      }
    }),
    addChild: () => undefined,
    trackMessageRenderComponent: () => undefined,
    getScrollHost: () => scrollHost,
    setScrollHostTop: (scrollTop) => {
      scrollHost.scrollTop = scrollTop;
    },
    syncScrollAffordances: () => {
      syncCalls += 1;
    },
    getScrollBottomTarget: (host = scrollHost) => Math.max(0, host.scrollHeight - host.clientHeight),
    getScrollPinnedToBottom: () => pinnedToBottom,
    setScrollPinnedToBottom: (value) => {
      pinnedToBottom = value;
    },
    getLastConversationId: () => null,
    getLastRenderedMessageCount: () => 0,
    setLastRenderedMessageCount: () => undefined,
    getMarkdownRenderGeneration: () => 0,
    buildMessageRevision: () => null,
    setLastMessageRevision: () => undefined,
    syncComposerButtons: () => undefined,
    getConversationForCurrentLeaf: () => null,
    getConversationById: () => null,
    getCurrentConversationId: () => null,
    getMessagesListEl: () => null,
    renderConversation: () => undefined,
    setPlainMessageContent: () => undefined,
    renderInlineToolAction: () => undefined,
    importWebSearchResultUrl: () => undefined
  });

  return {
    rendering,
    scrollHost,
    getPinnedToBottom: () => pinnedToBottom,
    getSyncCalls: () => syncCalls
  };
}

function createFakeContentElement() {
  return {
    textContent: "",
    ownerDocument: {
      createElement: () => createFakeContentElement()
    },
    empty() {
      this.textContent = "";
    },
    removeClass() {
      // no-op
    },
    addClass() {
      // no-op
    },
    setText(text) {
      this.textContent = text;
    },
    querySelectorAll() {
      return [];
    },
    appendChild() {
      // no-op
    }
  };
}

function assertAfterSendRestoresBottomInRaf(module) {
  const windowHarness = installFakeWindow();
  const { rendering, scrollHost, getPinnedToBottom, getSyncCalls } = createRendering(module);
  let clearCalls = 0;

  const nextState = rendering.restoreMessageScroll(
    {
      conversationId: "conv-1",
      scrollTop: 160,
      pinnedToBottom: false
    },
    "conv-1",
    "conv-1:2:user:done:15:0:0",
    {
      lastConversationId: "conv-1",
      lastMessageRevision: "conv-1:1:user:done:5:0:0",
      pendingScrollIntent: "after-send"
    },
    {
      clearPendingScrollIntent: () => {
        clearCalls += 1;
      }
    }
  );

  assert.equal(nextState.lastConversationId, "conv-1");
  assert.equal(nextState.lastMessageRevision, "conv-1:2:user:done:15:0:0");
  assert.equal(clearCalls, 0, "pending scroll intent should not clear before RAF applies bottom scroll");
  assert.equal(scrollHost.scrollTop, 160, "scroll position should stay untouched before RAF runs");

  windowHarness.flushFrames();

  assert.equal(clearCalls, 1, "pending scroll intent should clear after RAF bottom scroll runs");
  assert.equal(scrollHost.scrollTop, 800, "after-send should scroll to the live bottom target");
  assert.equal(getPinnedToBottom(), true, "after-send should pin the scroll state to bottom");
  assert.equal(getSyncCalls(), 1, "after-send should resync affordances once after applying bottom scroll");
}

function assertRevealIntentSkipsBottomScroll(module) {
  installFakeWindow();
  const { rendering, scrollHost, getSyncCalls } = createRendering(module);
  let clearCalls = 0;

  const nextState = rendering.restoreMessageScroll(
    {
      conversationId: "conv-1",
      scrollTop: 160,
      pinnedToBottom: true
    },
    "conv-1",
    "conv-1:2:user:done:15:0:0",
    {
      lastConversationId: "conv-1",
      lastMessageRevision: "conv-1:1:user:done:5:0:0",
      pendingScrollIntent: "reveal-message"
    },
    {
      clearPendingScrollIntent: () => {
        clearCalls += 1;
      }
    }
  );

  assert.equal(clearCalls, 1, "reveal intent should clear immediately");
  assert.equal(scrollHost.scrollTop, 160, "reveal intent must not jump to the bottom");
  assert.equal(getSyncCalls(), 0, "reveal intent should leave scrolling to the message reveal step");
  assert.equal(nextState.lastConversationId, "conv-1");
  assert.equal(nextState.lastMessageRevision, "conv-1:2:user:done:15:0:0");
}

function assertQueueScrollIntentCancelsComposerRestore(module) {
  let composerRestoreCancelCalls = 0;
  const runtime = new module.ChatViewConversationRuntime({
    controller: {},
    leaf: {},
    assistantRendering: {},
    messageActions: {},
    getMessagesListEl: () => null,
    addChild: () => undefined,
    trackMessageRenderComponent: () => undefined,
    resetMessageRenderComponents: () => undefined,
    renderAssistantMetaBlocks: () => undefined,
    shouldRenderAssistantMessageMarkdown: () => false,
    setPlainMessageContent: () => undefined,
    renderInlineToolAction: () => undefined,
    openWebpageAttachmentPreview: () => undefined,
    syncComposerButtons: () => undefined,
    syncLeafHeader: () => undefined,
    syncScrollAffordances: () => undefined,
    getScrollHost: () => ({ scrollTop: 0 }),
    getScrollPinnedToBottom: () => false,
    setScrollHostTop: () => undefined,
    setScrollPinnedToBottom: () => undefined,
    closeInlineSuggests: () => undefined,
    cancelComposerScrollRestore: () => {
      composerRestoreCancelCalls += 1;
    }
  });

  runtime.queueScrollIntent("after-send");

  assert.equal(composerRestoreCancelCalls, 1, "queueing explicit scroll should cancel composer restore");
}

function assertOlderAnswerVariantSwitchInvalidatesConversationRender(module) {
  const runtime = new module.ChatViewConversationRuntime({
    controller: {},
    leaf: {},
    assistantRendering: {},
    messageActions: {},
    getMessagesListEl: () => null,
    addChild: () => undefined,
    trackMessageRenderComponent: () => undefined,
    resetMessageRenderComponents: () => undefined,
    renderAssistantMetaBlocks: () => undefined,
    shouldRenderAssistantMessageMarkdown: () => false,
    setPlainMessageContent: () => undefined,
    renderInlineToolAction: () => undefined,
    openWebpageAttachmentPreview: () => undefined,
    syncComposerButtons: () => undefined,
    syncLeafHeader: () => undefined,
    syncScrollAffordances: () => undefined,
    getScrollHost: () => ({ scrollTop: 0 }),
    getScrollPinnedToBottom: () => false,
    setScrollHostTop: () => undefined,
    setScrollPinnedToBottom: () => undefined,
    closeInlineSuggests: () => undefined,
    cancelComposerScrollRestore: () => undefined
  });
  const conversation = {
    id: "conv-variants",
    messages: [
      { id: "user-1", role: "user", text: "问题", status: "done" },
      {
        id: "assistant-1",
        role: "assistant",
        text: "第二版",
        status: "done",
        answerVariants: [
          { id: "assistant-0", text: "第一版", status: "done", createdAt: 1 }
        ],
        activeAnswerVariantIndex: 1
      },
      { id: "user-2", role: "user", text: "继续", status: "done" },
      { id: "assistant-2", role: "assistant", text: "最新回答", status: "done" }
    ]
  };

  const beforeRevision = runtime.buildMessageRevision(conversation);
  const beforeOtherRevision = runtime.buildOtherMessagesRevision(conversation);
  conversation.messages[1].text = "第一版";
  conversation.messages[1].answerVariants[0].text = "第二版";
  conversation.messages[1].activeAnswerVariantIndex = 0;
  const afterRevision = runtime.buildMessageRevision(conversation);
  const afterOtherRevision = runtime.buildOtherMessagesRevision(conversation);

  assert.notEqual(afterRevision, beforeRevision, "an older answer version switch should invalidate the conversation revision");
  assert.notEqual(
    afterOtherRevision,
    beforeOtherRevision,
    "the non-latest message signature must catch version switches on older answers"
  );
  assert.equal(
    runtime.buildOtherMessagesRevision({ id: "conv-single", messages: [conversation.messages[3]] }),
    "",
    "a single-message conversation has no other-message revision"
  );
}

function assertLegacyMobileScrollCompensationsStayRemoved() {
  const composerSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-mobile-composer.ts"),
    "utf8"
  );
  const layerSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-mobile-composer-layer.ts"),
    "utf8"
  );
  const chatViewSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view.ts"),
    "utf8"
  );
  const css = readFileSync(path.join(rootDir, "styles.css"), "utf8");

  for (const source of [composerSource, chatViewSource]) {
    assert.doesNotMatch(
      source,
      /MobileComposerBlurScrollRestore|mobile-blur-scroll-restore/,
      "blur must not replay a delayed scrollTop compatibility chain"
    );
    assert.doesNotMatch(
      source,
      /FocusLock|focus-locked|shouldLockShortMobileComposerFocus/,
      "short conversations must not use a second focus-lock state"
    );
  }
  assert.doesNotMatch(
    composerSource,
    /getMobileFocusedReservedSpace|shouldReserveMobileFocusedComposerSpace/,
    "focused composer spacing must be derived from the active body layer, not a second reserve formula"
  );
  assert.doesNotMatch(
    composerSource,
    /mobile-toolbar|mobile-navbar|workspace-drawer\.mod-bottom|mobileBottomChromeFallback/,
    "the resting baseline must not scan private host chrome selectors"
  );
  assert.doesNotMatch(
    layerSource,
    /attachmentFocusRestoreTimers|\[80,\s*220\]/,
    "attachment return must use one focus handoff instead of timer retries"
  );
  assert.doesNotMatch(
    css,
    /is-mobile-composer-focus-locked/,
    "the retired focus-lock presentation must not remain in CSS"
  );
  assert.doesNotMatch(
    css,
    /scroll-padding-bottom:\s*var\(--sidet-composer-reserved-space\)/,
    "the message spacer must be the single reserved-space representation"
  );
}

function assertFollowLatestUsesSnapshotPinnedState(module) {
  const windowHarness = installFakeWindow();
  const { rendering, scrollHost, getPinnedToBottom, getSyncCalls } = createRendering(module);
  scrollHost.scrollTop = 0;

  const nextState = rendering.restoreMessageScroll(
    {
      conversationId: "conv-1",
      scrollTop: 876,
      pinnedToBottom: true
    },
    "conv-1",
    "conv-1:6:assistant:streaming:0:0:0",
    {
      lastConversationId: "conv-1",
      lastMessageRevision: "conv-1:5:user:done:15:0:0",
      pendingScrollIntent: "none"
    },
    {
      clearPendingScrollIntent: () => undefined
    }
  );

  assert.equal(nextState.lastConversationId, "conv-1");
  assert.equal(nextState.lastMessageRevision, "conv-1:6:assistant:streaming:0:0:0");

  windowHarness.flushFrames();
  windowHarness.flushFrames();

  assert.equal(
    scrollHost.scrollTop,
    800,
    "full rerender should still snap back to bottom when snapshot says the user was pinned before render"
  );
  assert.equal(getPinnedToBottom(), true, "follow-latest should keep pinned state true after rerender");
  assert.ok(getSyncCalls() >= 1, "follow-latest should resync affordances after restoring bottom");
}

async function assertManagedConversationRenderOwnsScrollRestoration(module) {
  const windowHarness = installFakeWindow();
  const scrollHost = {
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 400
  };
  const setScrollCalls = [];

  const rendering = new module.ChatViewAssistantRendering({
    getApp: () => ({
      workspace: {
        getActiveFile: () => null
      }
    }),
    addChild: () => undefined,
    trackMessageRenderComponent: () => undefined,
    getScrollHost: () => scrollHost,
    setScrollHostTop: (scrollTop) => {
      setScrollCalls.push(scrollTop);
      scrollHost.scrollTop = scrollTop;
    },
    syncScrollAffordances: () => undefined,
    getScrollBottomTarget: (host = scrollHost) => Math.max(0, host.scrollHeight - host.clientHeight),
    getScrollPinnedToBottom: () => false,
    setScrollPinnedToBottom: () => undefined,
    getLastConversationId: () => "conv-1",
    getLastRenderedMessageCount: () => 2,
    setLastRenderedMessageCount: () => undefined,
    getMarkdownRenderGeneration: () => 1,
    buildMessageRevision: () => "rev-1",
    setLastMessageRevision: () => undefined,
    syncComposerButtons: () => undefined,
    getConversationForCurrentLeaf: () => null,
    getConversationById: () => null,
    getCurrentConversationId: () => "conv-1",
    getMessagesListEl: () => null,
    renderConversation: () => undefined,
    setPlainMessageContent: () => undefined,
    renderInlineToolAction: () => undefined,
    importWebSearchResultUrl: () => undefined
  });

  await rendering.renderAssistantMarkdown(createFakeContentElement(), "hello", {}, {
    conversationId: "conv-1",
    renderGeneration: 1,
    managedScrollRestore: true
  });
  windowHarness.flushFrames();

  assert.deepEqual(
    setScrollCalls,
    [],
    "full conversation render should not let markdown renderer replay its own preserved scroll snapshot"
  );
}

async function assertPatchedAssistantRenderCanStillRestorePreservedScroll(module) {
  const windowHarness = installFakeWindow();
  const scrollHost = {
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 400
  };
  const setScrollCalls = [];

  const rendering = new module.ChatViewAssistantRendering({
    getApp: () => ({
      workspace: {
        getActiveFile: () => null
      }
    }),
    addChild: () => undefined,
    trackMessageRenderComponent: () => undefined,
    getScrollHost: () => scrollHost,
    setScrollHostTop: (scrollTop) => {
      setScrollCalls.push(scrollTop);
      scrollHost.scrollTop = scrollTop;
    },
    syncScrollAffordances: () => undefined,
    getScrollBottomTarget: (host = scrollHost) => Math.max(0, host.scrollHeight - host.clientHeight),
    getScrollPinnedToBottom: () => false,
    setScrollPinnedToBottom: () => undefined,
    getLastConversationId: () => "conv-1",
    getLastRenderedMessageCount: () => 2,
    setLastRenderedMessageCount: () => undefined,
    getMarkdownRenderGeneration: () => 1,
    buildMessageRevision: () => "rev-1",
    setLastMessageRevision: () => undefined,
    syncComposerButtons: () => undefined,
    getConversationForCurrentLeaf: () => null,
    getConversationById: () => ({
      id: "conv-1",
      messages: [{ id: "msg-1", status: "done" }]
    }),
    getCurrentConversationId: () => "conv-1",
    getMessagesListEl: () => null,
    renderConversation: () => undefined,
    setPlainMessageContent: () => undefined,
    renderInlineToolAction: () => undefined,
    importWebSearchResultUrl: () => undefined
  });

  await rendering.renderAssistantMarkdown(createFakeContentElement(), "hello", {}, {
    conversationId: "conv-1",
    renderGeneration: 1,
    messageId: "msg-1"
  });
  windowHarness.flushFrames();

  assert.deepEqual(
    setScrollCalls,
    [0],
    "patched assistant render should keep its local preserved-scroll replay behavior"
  );
}

function assertPinnedContentGrowthFollowsBottom(module) {
  const windowHarness = installFakeWindow();
  const { rendering, scrollHost, getPinnedToBottom } = createRendering(module);
  rendering.resetContentHeightBaseline();
  scrollHost.scrollTop = 800;
  rendering.updatePinnedToBottom(40);
  assert.equal(getPinnedToBottom(), true, "fixture should start pinned at the bottom");

  scrollHost.scrollHeight = 1680;
  rendering.handleContentResize();
  windowHarness.flushFrames();

  assert.equal(
    scrollHost.scrollTop,
    1280,
    "expanded content must keep a pinned reader on the new bottom"
  );
  assert.equal(getPinnedToBottom(), true, "content growth must leave the reader pinned");
}

function assertUnpinnedContentGrowthKeepsReadingPosition(module) {
  const windowHarness = installFakeWindow();
  const { rendering, scrollHost, getPinnedToBottom } = createRendering(module);
  rendering.resetContentHeightBaseline();
  scrollHost.scrollTop = 300;
  rendering.updatePinnedToBottom(40);
  assert.equal(getPinnedToBottom(), false, "fixture should start away from the bottom");

  scrollHost.scrollHeight = 1680;
  rendering.handleContentResize();
  windowHarness.flushFrames();

  assert.equal(
    scrollHost.scrollTop,
    300,
    "content growth must not pull a reader who is not pinned back to the bottom"
  );
  assert.equal(getPinnedToBottom(), false, "content growth must not change an unpinned reader state");
}

function assertContentShrinkAnchorsBottomSynchronously(module) {
  const windowHarness = installFakeWindow();
  const { rendering, scrollHost, getPinnedToBottom } = createRendering(module);
  rendering.resetContentHeightBaseline();
  scrollHost.scrollTop = 800;
  rendering.updatePinnedToBottom(40);
  assert.equal(getPinnedToBottom(), true, "fixture should start pinned at the bottom");

  scrollHost.scrollHeight = 1000;
  rendering.handleContentResize();
  windowHarness.flushFrames();

  assert.equal(
    scrollHost.scrollTop,
    600,
    "shrinking content at the bottom must keep the bottom edge anchored"
  );
  assert.equal(getPinnedToBottom(), true, "content shrink must not change the reader state");
}

function assertSuppressedContentGrowthDoesNotFollowBottom(module) {
  const windowHarness = installFakeWindow();
  const { rendering, scrollHost, getPinnedToBottom } = createRendering(module);
  rendering.resetContentHeightBaseline();
  scrollHost.scrollTop = 800;
  rendering.updatePinnedToBottom(40);
  assert.equal(getPinnedToBottom(), true, "fixture should start pinned at the bottom");

  rendering.suppressContentResizeFollow(500);
  scrollHost.scrollHeight = 1680;
  rendering.handleContentResize();
  windowHarness.flushFrames();

  assert.equal(
    scrollHost.scrollTop,
    800,
    "a suppressed manual toggle must keep the current scroll position"
  );
  assert.equal(getPinnedToBottom(), true, "suppression must not flip the reader state");
}

function assertBottomFollowIntentSurvivesLayoutScrollEvents(module) {
  const { rendering, scrollHost, getPinnedToBottom } = createRendering(module);
  rendering.holdBottomFollowIntent(900);
  assert.equal(getPinnedToBottom(), true, "holding the intent must pin the bottom");

  // 内容展开 / 版本切换时浏览器夹紧产生的滚动事件与任何程序化写入都不匹配，
  // 但它们不是用户滚动，不得把贴底意图翻掉。
  scrollHost.scrollTop = 40;
  assert.equal(
    rendering.handleScroll(40),
    true,
    "layout-induced scrolls must be swallowed while the intent is held"
  );
  assert.equal(getPinnedToBottom(), true, "the pin must survive layout scrolls");

  rendering.releaseBottomFollowIntent();
  scrollHost.scrollTop = 120;
  assert.equal(
    rendering.handleScroll(120),
    false,
    "after a real gesture the scroll must be treated as a user scroll"
  );
}

function assertContentGrowthAnchorsBottomSynchronously(module) {
  const windowHarness = installFakeWindow();
  const { rendering, scrollHost, getPinnedToBottom } = createRendering(module);
  rendering.resetContentHeightBaseline();
  scrollHost.scrollTop = 800;
  rendering.updatePinnedToBottom(40);
  assert.equal(getPinnedToBottom(), true, "fixture should start pinned at the bottom");

  scrollHost.scrollHeight = 1680;
  rendering.handleContentResize();

  assert.equal(
    scrollHost.scrollTop,
    1280,
    "content growth at the bottom must anchor synchronously so the bottom bar never moves"
  );
  windowHarness.flushFrames();
  assert.equal(
    scrollHost.scrollTop,
    1280,
    "the synchronous anchor must not leave a queued follow behind"
  );

  rendering.release();
  assert.equal(
    scrollHost.scrollTop,
    1280,
    "release after anchoring must not move the view"
  );
}

function assertKeyboardPresentationAnchorsBottomSynchronously(module) {
  const windowHarness = installFakeWindow();
  const { rendering, scrollHost, getPinnedToBottom } = createRendering(module);
  scrollHost.scrollTop = 0;
  scrollHost.scrollHeight = 1500;
  scrollHost.clientHeight = 400;
  rendering.holdBottomFollowIntent(600);
  rendering.requestBottomFollow("smooth");

  scrollHost.scrollHeight = 1700;
  rendering.anchorBottomForKeyboardPresentation();
  assert.equal(
    scrollHost.scrollTop,
    1300,
    "a keyboard reserved-space change must land on the new bottom in the same call"
  );
  assert.equal(getPinnedToBottom(), true);
  windowHarness.flushFrames();
  assert.equal(
    scrollHost.scrollTop,
    1300,
    "the rigid keyboard anchor must cancel the queued smooth follow"
  );
  rendering.release();
}

async function main() {
  try {
    const assistantRenderingModule = await loadBundledModule("src/workspace/chat-view-assistant-rendering.ts");
    const conversationRuntimeModule = await loadBundledModule("src/workspace/chat-view-conversation-runtime.ts");
    assertAfterSendRestoresBottomInRaf(assistantRenderingModule);
    assertFollowLatestUsesSnapshotPinnedState(assistantRenderingModule);
    assertRevealIntentSkipsBottomScroll(assistantRenderingModule);
    assertPinnedContentGrowthFollowsBottom(assistantRenderingModule);
    assertUnpinnedContentGrowthKeepsReadingPosition(assistantRenderingModule);
    assertContentShrinkAnchorsBottomSynchronously(assistantRenderingModule);
    assertSuppressedContentGrowthDoesNotFollowBottom(assistantRenderingModule);
    assertContentGrowthAnchorsBottomSynchronously(assistantRenderingModule);
    assertKeyboardPresentationAnchorsBottomSynchronously(assistantRenderingModule);
    assertBottomFollowIntentSurvivesLayoutScrollEvents(assistantRenderingModule);
    assertQueueScrollIntentCancelsComposerRestore(conversationRuntimeModule);
    assertOlderAnswerVariantSwitchInvalidatesConversationRender(conversationRuntimeModule);
    assertLegacyMobileScrollCompensationsStayRemoved();
    await assertManagedConversationRenderOwnsScrollRestoration(assistantRenderingModule);
    await assertPatchedAssistantRenderCanStillRestorePreservedScroll(assistantRenderingModule);
    console.log("chat scroll logic test passed");
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
