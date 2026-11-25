import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-web-search-routing-"));
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
  const modelConfig = {
    id: "model-1",
    name: "测试模型",
    providerId: "siliconflow",
    providerLabel: "硅基流动",
    presetId: "siliconflow-deepseek-v3",
    model: "deepseek-ai/DeepSeek-V3",
    baseUrl: "https://example.com/v1",
    reasoningEnabled: false,
    reasoningCompatibilityMode: "none"
  };
  const controller = Object.create(WorkspaceController.prototype);
  controller.store = {
    createConversation: async () => ({ id: "conversation-1", modelConfigId: modelConfig.id }),
    getConversation: () => ({ id: "conversation-1", modelConfigId: modelConfig.id }),
    isConversationArchived: () => false,
    setConversationModelConfigId: async () => undefined
  };
  controller.session = {
    sendLocalAssistantReply: async (...args) => {
      controller.__capturedLocalReplyArgs = args;
    },
    sendLocalAssistantTask: async (...args) => {
      if ((args[3]?.length ?? 0) > 0) {
        controller.__capturedNormalTaskArgs = args;
      } else {
        controller.__capturedLocalTaskArgs = args;
      }
    },
    send: async (...args) => {
      controller.__capturedSendArgs = args;
    }
  };
  controller.leafNavigation = {
    presentChatLeaf: async () => undefined
  };
  controller.chatLeafRuntime = {
    updateChatLeafState: () => undefined
  };
  controller.ensureConversationStoreReady = async () => undefined;
  controller.refreshKnowledgeBases = async () => [];
  controller.getChatLeafState = () => ({
    conversationId: "conversation-1",
    draft: "",
    modelConfigId: modelConfig.id,
    knowledgeBaseIndexPath: null,
    webSearchEnabled: true
  });
  controller.getSettings = () => ({
    modelConfigs: [modelConfig],
    defaultModelConfigId: modelConfig.id,
    webSearchMode: "off",
    exportFolder: "Sidet/chat",
    homePinnedCommands: []
  });
  controller.getSelectedKnowledgeBaseState = () => ({
    mode: "none",
    indexPath: null,
    displayName: null,
    knowledgeBase: null
  });
  controller.resolveSelectedKnowledgeBaseState = () => ({
    mode: "none",
    indexPath: null,
    displayName: null,
    knowledgeBase: null
  });
  controller.buildPreSendAgentContext = async () => ({
    requestContext: "当前时间：2026-06-03",
    knowledgeBaseRouting: undefined
  });
  controller.isWebSearchEnabled = () => true;
  controller.__webSearchTaskRuns = 0;
  controller.runModelDrivenWebSearch = async () => {
    controller.__webSearchTaskRuns += 1;
  };
  controller.stopStreamingAndWait = async () => undefined;
  return controller;
}

function createFakeTaskRuntime() {
  const calls = {
    modelCalls: 0,
    visible: []
  };
  return {
    calls,
    runtime: {
      buildRequestMessages: () => [],
      completeModelReply: async () => ({ contentText: "", reasoningText: "" }),
      streamModelReply: async () => {
        calls.modelCalls += 1;
        return { contentText: "测试答案", reasoningText: "", stoppedEarly: false };
      },
      appendContent: (chunk) => calls.visible.push(chunk),
      appendReasoning: () => undefined,
      appendMetaPanelText: () => undefined,
      setMetaPanelSources: () => undefined,
      setSources: () => undefined,
      getAbortSignal: () => new AbortController().signal
    }
  };
}

async function assertPureTextUsesWebSearch(controller) {
  controller.__capturedLocalTaskArgs = undefined;
  controller.__capturedNormalTaskArgs = undefined;
  controller.__capturedSendArgs = undefined;
  controller.__webSearchTaskRuns = 0;
  const leaf = {};
  await controller.sendMessageFromLeaf(leaf, "帮我查一下 GitHub 上的产品", []);
  assert.ok(controller.__capturedLocalTaskArgs, "pure text with explicit web search should use the local web search task");
  assert.equal(controller.__capturedNormalTaskArgs, undefined, "pure text web search should not fall through to the normal task chain");
  assert.equal(controller.__capturedSendArgs, undefined, "pure text web search should not use the legacy single-stream send chain");

  const fake = createFakeTaskRuntime();
  await controller.__capturedLocalTaskArgs[4](fake.runtime);
  assert.equal(controller.__webSearchTaskRuns, 1, "the captured web search task should run the model-driven web search");
  assert.equal(fake.calls.modelCalls, 0, "the web search task should not fall through to the normal tool loop");
}

async function assertAttachmentsBypassWebSearch(controller) {
  controller.__capturedLocalTaskArgs = undefined;
  controller.__capturedNormalTaskArgs = undefined;
  controller.__capturedSendArgs = undefined;
  controller.__webSearchTaskRuns = 0;

  const leaf = {};
  await controller.sendMessageFromLeaf(leaf, "基于这个网页继续帮我整理", [
    {
      id: "webpage-1",
      type: "webpage",
      name: "示例网页",
      url: "https://example.com",
      content: "网页正文",
      truncated: false,
      size: 128
    }
  ]);

  assert.ok(controller.__capturedNormalTaskArgs, "when explicit context attachments exist, send should return to the normal model chain");
  assert.equal(controller.__capturedLocalTaskArgs, undefined, "attachments should prevent explicit web search from taking over the send chain");

  const fake = createFakeTaskRuntime();
  await controller.__capturedNormalTaskArgs[4](fake.runtime);
  assert.equal(fake.calls.modelCalls, 1, "attachments should run the normal bounded tool loop");
  assert.equal(controller.__webSearchTaskRuns, 0, "attachments should not enter the model-driven web search task");
}

async function assertKnowledgeBaseFeedbackStartsWithUserMessage(controller) {
  controller.__capturedLocalReplyArgs = undefined;
  controller.__capturedLocalTaskArgs = undefined;
  controller.__capturedNormalTaskArgs = undefined;
  controller.__capturedSendArgs = undefined;
  controller.getSelectedKnowledgeBaseState = () => ({
    mode: "all",
    indexPath: "__sidet_all_knowledge_bases__",
    displayName: "全部知识库",
    knowledgeBase: null
  });

  const leaf = {};
  await controller.sendMessageFromLeaf(leaf, "同步", []);

  assert.ok(controller.__capturedLocalReplyArgs, "knowledge base mode should use the local assistant reply chain");
  const sendOptions = controller.__capturedLocalReplyArgs[4];
  assert.deepEqual(
    sendOptions.knowledgeBaseRouting,
    {
      mode: "all",
      displayName: "全部知识库",
      status: "searching",
      resultCount: 0,
      hits: []
    },
    "the user message should carry visible knowledge-base search feedback before the async search starts"
  );
  assert.equal(controller.__capturedLocalTaskArgs, undefined);
  assert.equal(controller.__capturedSendArgs, undefined);
}

async function main() {
  try {
    const module = await loadBundledModule("src/workspace/workspace-controller.ts");
    const controller = createControllerHarness(module.WorkspaceController);
    await assertPureTextUsesWebSearch(controller);
    await assertAttachmentsBypassWebSearch(controller);
    await assertKnowledgeBaseFeedbackStartsWithUserMessage(controller);
    console.log("sidet web search routing logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
