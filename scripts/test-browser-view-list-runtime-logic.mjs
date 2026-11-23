import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
    ]
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

  console.log("browser view list runtime logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
