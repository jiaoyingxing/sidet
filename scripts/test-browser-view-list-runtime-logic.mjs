import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-browser-list-"));
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

function createRow() {
  const state = {
    classes: new Set(),
    attrs: new Map()
  };
  const toggleClass = (name, enabled) => {
    if (enabled) state.classes.add(name);
    else state.classes.delete(name);
  };
  return {
    state,
    item: { toggleClass },
    navTarget: {
      toggleClass,
      setAttr(name, value) {
        state.attrs.set(name, value);
      },
      removeAttribute(name) {
        state.attrs.delete(name);
      }
    }
  };
}

function entries({ title = "Alpha", pinned = false, folderId = null, folderName = "工作", folderCount = 1 } = {}) {
  return {
    folders: [
      {
        id: "folder-1",
        name: folderName,
        conversationCount: folderCount
      }
    ],
    summaries: [
      {
        id: "conversation-a",
        title,
        folderId,
        isPinned: pinned
      },
      {
        id: "conversation-b",
        title: "Beta",
        folderId: null,
        isPinned: false
      }
    ],
    messageHits: []
  };
}

async function main() {
  const module = await loadBundledModule("src/workspace/browser-view-list-runtime.ts");
  const runtime = new module.BrowserViewListRuntime({});
  const rows = new Map([
    ["conversation-a", createRow()],
    ["conversation-b", createRow()]
  ]);

  const initial = entries();
  runtime.markRendered(initial, "conversation-a");

  // Same list signature + new active row: patch succeeds and only active state changes.
  assert.equal(runtime.tryPatchRenderedActiveConversation(initial, "conversation-b", rows), true);
  assert.equal(rows.get("conversation-a").state.classes.has("is-active"), false);
  assert.equal(rows.get("conversation-a").state.attrs.get("aria-selected"), "false");
  assert.equal(rows.get("conversation-a").state.attrs.has("aria-current"), false);
  assert.equal(rows.get("conversation-b").state.classes.has("is-active"), true);
  assert.equal(rows.get("conversation-b").state.attrs.get("aria-selected"), "true");
  assert.equal(rows.get("conversation-b").state.attrs.get("aria-current"), "page");

  // Same signature + same active row: no-op patch.
  assert.equal(runtime.tryPatchRenderedActiveConversation(initial, "conversation-b", rows), true);

  // Title change must force a full render, not a patch.
  assert.equal(runtime.tryPatchRenderedActiveConversation(entries({ title: "Alpha renamed" }), "conversation-b", rows), false);

  // Pinned change must force a full render.
  assert.equal(runtime.tryPatchRenderedActiveConversation(entries({ pinned: true }), "conversation-b", rows), false);

  // Folder name / count change must force a full render.
  assert.equal(runtime.tryPatchRenderedActiveConversation(entries({ folderName: "工作 2" }), "conversation-b", rows), false);
  assert.equal(runtime.tryPatchRenderedActiveConversation(entries({ folderCount: 2 }), "conversation-b", rows), false);

  // Conversation folder change must force a full render.
  assert.equal(runtime.tryPatchRenderedActiveConversation(entries({ folderId: "folder-1" }), "conversation-b", rows), false);

  // Row order change must force a full render.
  const reordered = entries();
  reordered.summaries = [...reordered.summaries].reverse();
  assert.equal(runtime.tryPatchRenderedActiveConversation(reordered, "conversation-b", rows), false);

  // Missing row must be tolerated; the active id still advances.
  const sparseRows = new Map([["conversation-a", createRow()]]);
  assert.equal(runtime.tryPatchRenderedActiveConversation(initial, "conversation-b", sparseRows), true);
  assert.equal(runtime.tryPatchRenderedActiveConversation(initial, "conversation-b", sparseRows), true);

  // Message hit changes must force a full render, not an active-row patch.
  const searchEntries = {
    folders: [],
    summaries: [
      {
        id: "conversation-a",
        title: "检索边界",
        folderId: "folder-1",
        isPinned: false
      }
    ],
    messageHits: [
      {
        conversationId: "conversation-a",
        conversationTitle: "检索边界",
        messageId: "message-1",
        role: "user",
        snippet: "…检索边界…",
        matchRanges: [{ start: 1, end: 3 }],
        messageCreatedAt: 2,
        updatedAt: 3,
        folderId: "folder-1",
        folderName: "研究",
        isArchived: false
      }
    ]
  };
  runtime.markRendered(searchEntries, "conversation-a");
  const changedHitEntries = {
    ...searchEntries,
    messageHits: [
      {
        ...searchEntries.messageHits[0],
        snippet: "…另一个片段…"
      }
    ]
  };
  assert.equal(
    runtime.tryPatchRenderedActiveConversation(changedHitEntries, "conversation-a", rows),
    false,
    "message hit changes must invalidate the rendered list signature"
  );
  assert.equal(runtime.buildEmptyText(true), "没有匹配的对话、文件夹或消息。");

  // Query mode searches titles globally and returns message hits from the store.
  const searchRuntime = new module.BrowserViewListRuntime({
    isConversationStoreReady: () => true,
    store: {
      getAllSummaries: () => [
        {
          id: "conversation-a",
          title: "检索边界",
          folderId: "folder-1",
          isPinned: false,
          isArchived: false,
          messageCount: 4
        },
        {
          id: "conversation-b",
          title: "周会记录",
          folderId: null,
          isPinned: false,
          isArchived: false,
          messageCount: 2
        }
      ],
      getFolderSummaries: () => [
        {
          id: "folder-1",
          name: "研究计划",
          conversationCount: 1
        }
      ],
      getSummariesInFolder: () => [],
      searchMessageContent: () => searchEntries.messageHits
    }
  });
  searchRuntime.setSearchQuery("检索");
  const visible = searchRuntime.getVisibleEntries();
  assert.equal(visible.folders.length, 0, "a non-matching folder name should stay hidden");
  assert.deepEqual(
    visible.summaries.map((summary) => summary.id),
    ["conversation-a"],
    "search mode should filter titles globally"
  );
  assert.equal(visible.messageHits.length, 1, "search mode should expose message hits");
  assert.equal(visible.messageHits[0].messageId, "message-1");

  searchRuntime.setSearchQuery("研究");
  const folderVisible = searchRuntime.getVisibleEntries();
  assert.deepEqual(
    folderVisible.folders.map((folder) => folder.id),
    ["folder-1"],
    "folder names should remain searchable"
  );
  assert.equal(folderVisible.summaries.length, 0, "title matches should stay empty for a folder-only query");

  // Sidebar surface contract: the browser view must ride the host leaf/drawer
  // color instead of painting the main-area primary surface over it.
  const stylesSource = readFileSync(path.join(rootDir, "styles.css"), "utf8");
  const browserViewRule = stylesSource.match(/^\.sidet-browser-view \{[^}]*\}/m)?.[0] ?? "";
  assert.match(
    browserViewRule,
    /background: transparent;/,
    "the browser sidebar view must stay transparent so the host leaf / drawer surface shows through"
  );
  assert.doesNotMatch(
    browserViewRule,
    /background:\s*var\(--background-primary\)/,
    "the browser sidebar view must not paint the main-area primary background"
  );
  const toolbarRule = stylesSource.match(/^\.sidet-browser-toolbar \{[^}]*\}/m)?.[0] ?? "";
  assert.match(
    toolbarRule,
    /background: var\(--mobile-sidebar-background, var\(--background-secondary\)\);/,
    "the sticky browser toolbar must use the host sidebar surface"
  );
  const searchRule = stylesSource.match(/^\.sidet-browser-search-input \{[^}]*\}/m)?.[0] ?? "";
  assert.match(
    searchRule,
    /background: var\(--background-modifier-form-field\);/,
    "the browser search field must use the host form-field surface"
  );

  console.log("browser view list runtime logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
