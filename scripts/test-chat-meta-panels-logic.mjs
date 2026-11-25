import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-chat-meta-panels-"));
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

function createRenderingHarness(ChatViewAssistantRendering) {
  return new ChatViewAssistantRendering({
    getApp: () => ({}),
    addChild: () => undefined,
    trackMessageRenderComponent: () => undefined,
    getScrollHost: () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
    setScrollHostTop: () => undefined,
    syncScrollAffordances: () => undefined,
    getScrollBottomTarget: () => 0,
    getScrollPinnedToBottom: () => true,
    setScrollPinnedToBottom: () => undefined,
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
    renderWikiMaintenancePlanAction: () => undefined,
    renderAnswerSources: () => undefined,
    renderAnswerActions: () => undefined,
    importWebSearchResultUrl: () => undefined,
    openSourceModal: () => undefined
  });
}

function createMockElement(tagName = "div") {
  return {
    tagName,
    textContent: "",
    classes: [],
    children: [],
    empty() {
      this.children = [];
      this.textContent = "";
    },
    addClass(cls) {
      this.classes.push(cls);
    },
    setText(text) {
      this.textContent = text;
    },
    createDiv(options = {}) {
      const child = createMockElement("div");
      if (options.cls) {
        child.classes.push(options.cls);
      }
      if (options.text) {
        child.textContent = options.text;
      }
      this.children.push(child);
      return child;
    },
    createEl(tag, options = {}) {
      const child = createMockElement(tag);
      if (options.cls) {
        child.classes.push(options.cls);
      }
      if (options.text) {
        child.textContent = options.text;
      }
      if (options.href) {
        child.href = options.href;
      }
      this.children.push(child);
      return child;
    }
  };
}

function assertWebSearchPanelsSplitFromDeepThinking(module) {
  const rendering = createRenderingHarness(module.ChatViewAssistantRendering);
  const layout = rendering.buildMetaLayout({
    id: "assistant-1",
    role: "assistant",
    text: "最终回答",
    reasoningText: "今天是 2026 年 6 月 2 日。",
    createdAt: Date.now(),
    status: "done",
    metaPanels: [
      {
        kind: "web-step-search-1",
        label: "网页搜索",
        display: "step",
        group: "web-search",
        groupLabel: "联网搜索",
        text: "我先看一下最新新闻。",
        sources: [
          {
            title: "新闻 1",
            url: "https://example.com/news"
          }
        ]
      },
      {
        kind: "other",
        label: "引用来源",
        text: "保留独立面板。"
      }
    ]
  });

  assert.equal(layout.statusLines.length, 0, "web search flow should no longer emit separate outer status lines");
  assert.equal(layout.panels.length, 3, "reasoning, web search, and unrelated panels should stay separate");
  assert.equal(layout.panels[0].kind, "group:deep-thinking");
  assert.equal(layout.panels[0].label, "深度思考");
  assert.equal(
    layout.panels[0].sections?.length ?? 0,
    1,
    "deep thinking panel should only keep model reasoning"
  );
  assert.equal(layout.panels[1].kind, "group:web-search");
  assert.equal(layout.panels[1].label, "联网搜索");
  assert.equal(
    layout.panels[1].sections?.length ?? 0,
    1,
    "web search panel should keep its own ordered steps"
  );
  assert.equal(layout.panels[1].sections?.[0]?.label, "网页搜索");
  assert.equal(layout.panels[1].sections?.[0]?.sources?.length ?? 0, 1, "search result sources should stay on the matching step");
  assert.equal(layout.panels[2].label, "引用来源", "unrelated panels should remain separate");

  const bodyEl = createMockElement();
  rendering.renderMetaPanelBody(bodyEl, layout.panels[1]);
  const renderedLabels = [];
  const stack = [...bodyEl.children];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }
    if (node.classes.includes("sidet-message-meta-panel-step-label")) {
      renderedLabels.push(node.textContent);
    }
    stack.unshift(...node.children);
  }

  assert.deepEqual(renderedLabels, [], "generic web-search step labels should stay hidden inside the web-search module");
}

function assertLegacyWebProcessPanelMapsToWebSearch(module) {
  const rendering = createRenderingHarness(module.ChatViewAssistantRendering);
  const layout = rendering.buildMetaLayout({
    id: "assistant-legacy",
    role: "assistant",
    text: "最终回答",
    createdAt: Date.now(),
    status: "done",
    metaPanels: [
      {
        kind: "web-process",
        label: "联网过程",
        text: "正在搜索",
        sources: [
          {
            title: "历史来源",
            url: "https://example.com/legacy"
          }
        ]
      }
    ]
  });

  assert.equal(layout.panels.length, 1, "legacy web-process panel should still render one grouped module");
  assert.equal(layout.panels[0].kind, "group:web-search");
  assert.equal(layout.panels[0].label, "联网搜索");
  assert.equal(layout.panels[0].sections?.[0]?.label, "联网过程");
  assert.equal(layout.panels[0].sections?.[0]?.text, "正在搜索");
}

function assertReasoningFallbackLabelIsHidden(module) {
  const rendering = createRenderingHarness(module.ChatViewAssistantRendering);
  const layout = rendering.buildMetaLayout({
    id: "assistant-2",
    role: "assistant",
    text: "最终回答",
    reasoningText: "这是正常的思考内容。",
    createdAt: Date.now(),
    status: "done",
    metaPanels: []
  });

  assert.equal(layout.panels.length, 1, "reasoning-only assistant reply should still render one deep thinking panel");
  assert.equal(layout.panels[0].label, "深度思考");
  assert.equal(layout.panels[0].sections?.[0]?.label ?? "", "", "reasoning-only step should not inject a fallback subheading");

  const bodyEl = createMockElement();
  rendering.renderMetaPanelBody(bodyEl, layout.panels[0]);

  const renderedLabels = [];
  const stack = [...bodyEl.children];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }
    if (node.classes.includes("sidet-message-meta-panel-step-label")) {
      renderedLabels.push(node.textContent);
    }
    stack.unshift(...node.children);
  }

  assert.deepEqual(renderedLabels, [], "reasoning-only panel should not render a visible fallback label");
}

function assertCustomStepLabelStillRenders(module) {
  const rendering = createRenderingHarness(module.ChatViewAssistantRendering);
  const bodyEl = createMockElement();
  rendering.renderMetaPanelBody(bodyEl, {
    kind: "group:deep-thinking",
    label: "深度思考",
    sections: [
      {
        kind: "custom-step",
        label: "换个搜索词再试一次",
        text: "这一步不是泛标签，应该继续显示。"
      }
    ]
  });

  const renderedLabels = [];
  const stack = [...bodyEl.children];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }
    if (node.classes.includes("sidet-message-meta-panel-step-label")) {
      renderedLabels.push(node.textContent);
    }
    stack.unshift(...node.children);
  }

  assert.deepEqual(renderedLabels, ["换个搜索词再试一次"], "custom step labels should still render");
}

async function main() {
  try {
    const module = await loadBundledModule("src/workspace/chat-view-assistant-rendering.ts");
    assertWebSearchPanelsSplitFromDeepThinking(module);
    assertLegacyWebProcessPanelMapsToWebSearch(module);
    assertReasoningFallbackLabelIsHidden(module);
    assertCustomStepLabelStillRenders(module);
    console.log("chat meta panels logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
