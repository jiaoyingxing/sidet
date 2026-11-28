import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-chat-leaf-navigation-"));
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

function createLeaf({ type = "empty", state = {}, active = false, container = {} } = {}) {
  let currentViewState = { type, state, active };
  let ephemeralState = {};
  return {
    parent: null,
    view: null,
    detached: false,
    getViewState() {
      return currentViewState;
    },
    async setViewState(nextViewState) {
      currentViewState = nextViewState;
    },
    async loadIfDeferred() {
      return undefined;
    },
    getEphemeralState() {
      return ephemeralState;
    },
    setEphemeralState(nextState) {
      ephemeralState = nextState;
    },
    getContainer() {
      return container;
    },
    detach() {
      this.detached = true;
    }
  };
}

function createHarness(
  modeState = { webSearchEnabled: false },
  options = {}
) {
  const defaultModelConfigId = "model-default";
  const rootSplit = {};
  const createdLeaves = [];
  const chatLeaves = options.chatLeaves ?? [];
  const app = {
    workspace: {
      activeLeaf: null,
      rootSplit,
      getLeavesOfType: (type) => (type === "sidet-chat-view" ? chatLeaves : []),
      getMostRecentLeaf: () => chatLeaves[0] ?? null,
      getRightLeaf: () => null,
      getLeaf: () => {
        const leaf = createLeaf({ container: rootSplit });
        createdLeaves.push(leaf);
        return leaf;
      },
      revealLeaf: async () => undefined,
      setActiveLeaf: () => undefined
    }
  };
  const store = {
    hasConversation: (conversationId) => conversationId === "conversation-1",
    getConversationDraft: () => "已有草稿",
    setConversationDraft: () => undefined,
    getConversation: () => ({
      id: "conversation-1",
      modelConfigId: defaultModelConfigId
    })
  };
  const runtime = {
    hydratedStates: [],
    updatedStates: [],
    revealedRequests: [],
    rememberedLeaf: null,
    getLastFocusedChatLeaf: () => null,
    getLastModeState: () => modeState,
    getChatLeafState: (leaf) => leaf.__chatLeafState ?? {
      conversationId: "conversation-0",
      draft: "旧草稿",
      modelConfigId: defaultModelConfigId,
      webSearchEnabled: modeState.webSearchEnabled === true
    },
    hydrateChatLeafState: (_leaf, state) => {
      runtime.hydratedStates.push(state);
    },
    flush: async () => undefined,
    rememberFocusedChatLeaf: (leaf) => {
      runtime.rememberedLeaf = leaf;
    },
    focusComposer: () => undefined,
    setHomeDraft: () => undefined,
    updateChatLeafState: (leaf, state) => {
      leaf.__chatLeafState = state;
      runtime.updatedStates.push(state);
    },
    queueMessageReveal: (leaf, request) => {
      runtime.revealedRequests.push({ leaf, request });
    }
  };

  return {
    app,
    store,
    runtime,
    rootSplit,
    createdLeaves,
    defaultModelConfigId
  };
}

async function assertOpenNewChatTabPreservesMode(module) {
  const harness = createHarness({
    webSearchEnabled: true
  });
  const navigation = new module.WorkspaceLeafNavigation(
    harness.app,
    harness.store,
    harness.runtime,
    () => harness.defaultModelConfigId
  );

  const leaf = await navigation.openNewChatTab({
    focusComposer: false,
    reuseHomepage: false
  });

  assert.equal(harness.createdLeaves.length, 1, "openNewChatTab should create one leaf when no homepage leaf exists");
  assert.equal(leaf.getViewState().state.modelConfigId, harness.defaultModelConfigId, "new chat leaf should inherit the current default model");
  assert.equal(leaf.getViewState().state.webSearchEnabled, true, "new chat leaf should inherit the persistent web search state");
}

async function assertOpenConversationWithoutTargetLeafPreservesMode(module) {
  const harness = createHarness({
    webSearchEnabled: false
  });
  const navigation = new module.WorkspaceLeafNavigation(
    harness.app,
    harness.store,
    harness.runtime,
    () => harness.defaultModelConfigId
  );

  const leaf = await navigation.openConversationInLeaf("conversation-1", {
    messageId: "message-1"
  });
  assert.ok(leaf, "openConversationInLeaf should create a leaf when the conversation exists");
  assert.equal(leaf.getViewState().state.conversationId, "conversation-1", "newly opened leaf should target the requested conversation");
  assert.equal(leaf.getViewState().state.modelConfigId, harness.defaultModelConfigId, "conversation leaf should carry the conversation model id");
  assert.equal(leaf.getViewState().state.webSearchEnabled, false, "conversation leaf should preserve the inherited web-search mode");
  assert.deepEqual(
    harness.runtime.revealedRequests,
    [
      {
        leaf,
        request: {
          conversationId: "conversation-1",
          messageId: "message-1"
        }
      }
    ],
    "openConversationInLeaf should queue a one-shot message reveal request"
  );
}

async function assertOpenConversationOnExistingLeafQueuesReveal(module) {
  const existingLeaf = createLeaf({
    type: "sidet-chat-view",
    active: true
  });
  const harness = createHarness(
    { webSearchEnabled: false },
    { chatLeaves: [existingLeaf] }
  );
  existingLeaf.__chatLeafState = {
    conversationId: "conversation-0",
    draft: "旧草稿",
    modelConfigId: harness.defaultModelConfigId,
    webSearchEnabled: false
  };
  const navigation = new module.WorkspaceLeafNavigation(
    harness.app,
    harness.store,
    harness.runtime,
    () => harness.defaultModelConfigId
  );

  const leaf = await navigation.openConversationInLeaf("conversation-1", {
    messageId: "message-1"
  });

  assert.equal(leaf, existingLeaf, "an existing chat leaf should be reused");
  assert.equal(
    existingLeaf.__chatLeafState?.conversationId,
    "conversation-1",
    "the existing leaf should be retargeted to the requested conversation"
  );
  assert.deepEqual(
    harness.runtime.revealedRequests,
    [
      {
        leaf: existingLeaf,
        request: {
          conversationId: "conversation-1",
          messageId: "message-1"
        }
      }
    ],
    "reusing an existing leaf should still queue the one-shot message reveal"
  );
}

async function assertResetFreshConversationKeepsMode(module) {
  const harness = createHarness({
    webSearchEnabled: false
  });
  const navigation = new module.WorkspaceLeafNavigation(
    harness.app,
    harness.store,
    harness.runtime,
    () => harness.defaultModelConfigId
  );
  const leaf = createLeaf({ type: "chat-view", container: harness.rootSplit });
  leaf.__chatLeafState = {
    conversationId: "conversation-1",
    draft: "待发送草稿",
    modelConfigId: harness.defaultModelConfigId,
    webSearchEnabled: true
  };

  await navigation.resetChatLeafToFreshConversation(leaf);

  assert.equal(harness.runtime.updatedStates.length, 1, "reset should write one fresh state back into the runtime");
  assert.equal(harness.runtime.updatedStates[0].conversationId, null, "reset should clear the conversation id");
  assert.equal(harness.runtime.updatedStates[0].draft, "", "reset should clear the draft");
  assert.equal(harness.runtime.updatedStates[0].modelConfigId, harness.defaultModelConfigId, "reset should return to the current default model");
  assert.equal(harness.runtime.updatedStates[0].webSearchEnabled, true, "reset should keep the current web search mode");
}

async function assertBrowserRestoreKeepsOneSidebarLeaf(module) {
  const harness = createHarness();
  const browserLeaves = [];
  let rightLeafRequests = 0;
  const restoredLeaf = createLeaf();
  harness.app.workspace.getLeavesOfType = (type) => type === "sidet-browser-view" ? browserLeaves : [];
  harness.app.workspace.getRightLeaf = () => {
    rightLeafRequests += 1;
    browserLeaves.push(restoredLeaf);
    return restoredLeaf;
  };
  const navigation = new module.WorkspaceLeafNavigation(
    harness.app,
    harness.store,
    harness.runtime,
    () => harness.defaultModelConfigId
  );

  const firstLeaf = await navigation.ensureBrowserViewOpen();
  const secondLeaf = await navigation.ensureBrowserViewOpen();

  assert.equal(firstLeaf, restoredLeaf, "startup restore should mount the conversation list in the right sidebar");
  assert.equal(secondLeaf, restoredLeaf, "repeated restore should reuse the existing conversation list leaf");
  assert.equal(rightLeafRequests, 1, "repeated restore should not allocate another sidebar leaf");
  assert.equal(restoredLeaf.getViewState().type, "sidet-browser-view", "restored leaf should use the conversation list view type");
}

function assertStartupAndCommandEntrypointsAreRegistered() {
  const mainSource = readFileSync(path.join(rootDir, "src", "main.ts"), "utf8");
  assert.match(
    mainSource,
    /id:\s*"open-sidet-conversation-list"[\s\S]*?name:\s*"打开对话列表"[\s\S]*?controller\.openBrowserView\(\)/,
    "the Obsidian command palette should expose the conversation list opener"
  );
  assert.match(
    mainSource,
    /onLayoutReady\(\(\)\s*=>\s*\{[\s\S]*?scheduleDeferredBrowserBootstrap\(\)/,
    "layout ready should schedule the deferred conversation list restore"
  );
  assert.match(
    mainSource,
    /scheduleDeferredBrowserBootstrap\(\):\s*void\s*\{[\s\S]*?setTimeout\([\s\S]*?ensureBrowserViewOpen\(\)/,
    "startup restore should pass through the singleton conversation list entrypoint"
  );
}

function createNativeNewTabHarness({ homepageExists, homepageActive }) {
  const outsideLeaf = { id: "outside" };
  const homepageLeaf = { id: "homepage" };
  let currentHomepageLeaf = homepageExists ? homepageLeaf : null;
  let sidetHomepageOpenCount = 0;
  const nativeLeaves = [];
  const workspace = {
    activeLeaf: homepageActive ? homepageLeaf : outsideLeaf,
    rootSplit: {},
    getLeaf: () => {
      let viewState = { type: "empty", state: {}, active: false };
      const leaf = {
        id: `native-${nativeLeaves.length + 1}`,
        getViewState: () => viewState,
        setViewState: async (nextViewState) => {
          viewState = nextViewState;
        },
        loadIfDeferred: async () => undefined
      };
      nativeLeaves.push(leaf);
      return leaf;
    },
    revealLeaf: async () => undefined,
    setActiveLeaf: (leaf) => {
      workspace.activeLeaf = leaf;
    }
  };
  const commands = {
    "workspace:new-tab": {
      callback: () => undefined,
      checkCallback: () => true
    },
    "app:new-tab": {
      callback: () => undefined,
      checkCallback: () => true
    }
  };
  const app = {
    workspace,
    commands: { commands }
  };
  const leafNavigation = {
    getHomepageLeaf: () => currentHomepageLeaf,
    getActiveChatLeaf: () => workspace.activeLeaf === homepageLeaf ? homepageLeaf : null,
    openNewChatTab: async () => {
      sidetHomepageOpenCount += 1;
      await Promise.resolve();
      currentHomepageLeaf = homepageLeaf;
      workspace.activeLeaf = homepageLeaf;
      return homepageLeaf;
    }
  };

  return {
    app,
    commands,
    leafNavigation,
    homepageLeaf,
    nativeLeaves,
    getSidetHomepageOpenCount: () => sidetHomepageOpenCount
  };
}

async function runNativeNewTabActions(module, options, actionCount, trigger = "callback") {
  const harness = createNativeNewTabHarness(options);
  const takeover = new module.WorkspaceNativeNewTabTakeover(
    harness.app,
    harness.leafNavigation
  );
  const restore = takeover.install();
  try {
    if (trigger === "checkCallback") {
      assert.equal(harness.commands["workspace:new-tab"].checkCallback(true), true, "checking command availability should not execute the new-tab action");
    }
    for (let index = 0; index < actionCount; index += 1) {
      if (trigger === "checkCallback") {
        assert.equal(harness.commands["workspace:new-tab"].checkCallback(false), true, "the checked new-tab command should remain available");
      } else {
        harness.commands["workspace:new-tab"].callback();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return harness;
  } finally {
    restore();
  }
}

async function assertNativeNewTabUsesThreeStateRouting(module) {
  const missingHomepage = await runNativeNewTabActions(module, {
    homepageExists: false,
    homepageActive: false
  }, 1);
  assert.equal(missingHomepage.getSidetHomepageOpenCount(), 1, "new tab should create the Sidet homepage when none exists");
  assert.equal(missingHomepage.nativeLeaves.length, 0, "the first new-tab action should not create a native blank leaf");

  const backgroundHomepage = await runNativeNewTabActions(module, {
    homepageExists: true,
    homepageActive: false
  }, 1);
  assert.equal(backgroundHomepage.getSidetHomepageOpenCount(), 1, "new tab should focus the existing Sidet homepage when it is in the background");
  assert.equal(backgroundHomepage.nativeLeaves.length, 0, "a background Sidet homepage should be focused before native blank tabs are released");
  assert.equal(backgroundHomepage.app.workspace.activeLeaf, backgroundHomepage.homepageLeaf, "the existing Sidet homepage should become active");

  const activeHomepage = await runNativeNewTabActions(module, {
    homepageExists: true,
    homepageActive: true
  }, 1);
  assert.equal(activeHomepage.getSidetHomepageOpenCount(), 0, "an already active Sidet homepage should not be reopened");
  assert.equal(activeHomepage.nativeLeaves.length, 1, "an already active Sidet homepage should release one native blank tab");
}

async function assertRapidNewTabActionsAreSerialized(module) {
  const missingHomepage = await runNativeNewTabActions(module, {
    homepageExists: false,
    homepageActive: false
  }, 2);
  assert.equal(missingHomepage.getSidetHomepageOpenCount(), 1, "rapid actions should create only one Sidet homepage");
  assert.equal(missingHomepage.nativeLeaves.length, 1, "the second rapid action should observe the focused homepage and open a native blank tab");

  const backgroundHomepage = await runNativeNewTabActions(module, {
    homepageExists: true,
    homepageActive: false
  }, 2, "checkCallback");
  assert.equal(backgroundHomepage.getSidetHomepageOpenCount(), 1, "the first rapid action should focus the background homepage once");
  assert.equal(backgroundHomepage.nativeLeaves.length, 1, "the second rapid action should open one native blank tab after focus completes");
}

function createFallbackLeaf(id, rootSplit, type = "empty") {
  let viewState = { type, state: {}, active: true };
  return {
    id,
    parent: null,
    detached: false,
    getContainer: () => rootSplit,
    getViewState: () => viewState,
    setViewState: async (nextViewState) => {
      viewState = nextViewState;
    },
    detach() {
      this.detached = true;
    }
  };
}

async function assertNativeEmptyLeafFallbackUsesPreviousActiveLeaf(module) {
  async function runScenario(originKind, navigateCandidate = false) {
    const rootSplit = {};
    const homepageLeaf = createFallbackLeaf("homepage", rootSplit, "sidet-chat-view");
    const outsideLeaf = createFallbackLeaf("outside", rootSplit, "markdown");
    const sideLeaf = createFallbackLeaf("side", {}, "side-view");
    const candidateLeaf = createFallbackLeaf("candidate", rootSplit);
    let currentRootLeaf = originKind === "outside" ? outsideLeaf : homepageLeaf;
    let homepageFocusCount = 0;
    const app = {
      workspace: {
        activeLeaf: originKind === "side" ? sideLeaf : currentRootLeaf,
        rootSplit,
        getMostRecentLeaf: () => currentRootLeaf
      },
      commands: { commands: {} }
    };
    const leafNavigation = {
      getHomepageLeaf: () => homepageLeaf,
      getActiveChatLeaf: () => app.workspace.activeLeaf === homepageLeaf ? homepageLeaf : null,
      getMostRecentRootLeaf: () => currentRootLeaf,
      openNewChatTab: async () => {
        homepageFocusCount += 1;
        currentRootLeaf = homepageLeaf;
        app.workspace.activeLeaf = homepageLeaf;
        return homepageLeaf;
      }
    };
    const takeover = new module.WorkspaceNativeNewTabTakeover(app, leafNavigation);
    const restore = takeover.install();
    try {
      currentRootLeaf = candidateLeaf;
      app.workspace.activeLeaf = candidateLeaf;
      takeover.scheduleRecovery();
      if (navigateCandidate) {
        void Promise.resolve().then(() => candidateLeaf.setViewState({
          type: "markdown",
          state: { file: "note.md" },
          active: true
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { candidateLeaf, homepageFocusCount };
    } finally {
      restore();
    }
  }

  const backgroundHomepage = await runScenario("outside");
  assert.equal(backgroundHomepage.homepageFocusCount, 1, "a trusted new-tab UI fallback should focus a background Sidet homepage");
  assert.equal(backgroundHomepage.candidateLeaf.detached, true, "the transient native empty leaf should be removed after the background homepage is focused");

  const sideFocusedHomepage = await runScenario("side");
  assert.equal(sideFocusedHomepage.homepageFocusCount, 1, "a side-dock focus should not count as an active central Sidet homepage");
  assert.equal(sideFocusedHomepage.candidateLeaf.detached, true, "the transient empty leaf should be removed when focus came from a side dock");

  const activeHomepage = await runScenario("homepage");
  assert.equal(activeHomepage.homepageFocusCount, 0, "the fallback should not refocus an already active Sidet homepage");
  assert.equal(activeHomepage.candidateLeaf.detached, false, "a new native empty leaf should remain when the Sidet homepage was already active");

  const fileNavigation = await runScenario("outside", true);
  assert.equal(fileNavigation.homepageFocusCount, 0, "a new leaf that immediately starts file navigation should leave the Sidet takeover path");
  assert.equal(fileNavigation.candidateLeaf.detached, false, "the fallback must not detach a leaf that became a file view");
  assert.equal(fileNavigation.candidateLeaf.getViewState().type, "markdown", "file navigation should keep ownership of the new leaf");
}

async function main() {
  try {
    const module = await loadBundledModule("src/workspace/workspace-leaf-navigation.ts");
    await assertOpenNewChatTabPreservesMode(module);
    await assertOpenConversationWithoutTargetLeafPreservesMode(module);
    await assertOpenConversationOnExistingLeafQueuesReveal(module);
    await assertResetFreshConversationKeepsMode(module);
    await assertBrowserRestoreKeepsOneSidebarLeaf(module);
    assertStartupAndCommandEntrypointsAreRegistered();
    const takeoverModule = await loadBundledModule("src/workspace/workspace-native-new-tab-takeover.ts");
    await assertNativeNewTabUsesThreeStateRouting(takeoverModule);
    await assertRapidNewTabActionsAreSerialized(takeoverModule);
    await assertNativeEmptyLeafFallbackUsesPreviousActiveLeaf(takeoverModule);
    console.log("chat leaf navigation logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
