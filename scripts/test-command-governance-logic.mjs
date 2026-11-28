import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-command-governance-"));

async function loadModule(relativePath, outputName) {
  const outfile = path.join(tempDir, outputName);
  await build({
    entryPoints: [path.join(rootDir, relativePath)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function assertPublicCommandCatalog() {
  const source = readFileSync(path.join(rootDir, "src", "main.ts"), "utf8");
  const settingsSource = readFileSync(path.join(rootDir, "src", "settings", "setting-tab.ts"), "utf8");
  const commandIds = [...source.matchAll(/this\.addCommand\(\{\s*id:\s*"([^"]+)"/g)]
    .map((match) => match[1]);

  // 6 条公共产品命令之外，只允许显式登记的排障命令；新增产品意图仍然只能进这 6 条。
  const diagnosticCommandIds = ["export-mobile-input-diagnostic"];
  assert.deepEqual(
    commandIds.filter((id) => !diagnosticCommandIds.includes(id)),
    [
      "open-sidet-workspace",
      "open-sidet-conversation-list",
      "new-sidet-conversation",
      "export-current-sidet-conversation",
      "insert-active-note-into-sidet-draft",
      "insert-active-selection-into-sidet-draft"
    ]
  );
  assert.deepEqual(
    commandIds.filter((id) => diagnosticCommandIds.includes(id)),
    diagnosticCommandIds,
    "diagnostic commands must be explicitly allowlisted"
  );
  assert.match(source, /id:\s*"open-sidet-workspace"[\s\S]*?name:\s*"打开 Sidet"/);
}

function assertHomeCommandBoundary(rules) {
  const allowedSidetCommands = [
    "sidet:open-sidet-workspace",
    "sidet:open-sidet-conversation-list",
    "sidet:new-sidet-conversation"
  ];
  const contextBoundSidetCommands = [
    "sidet:export-current-sidet-conversation",
    "sidet:insert-active-note-into-sidet-draft",
    "sidet:insert-active-selection-into-sidet-draft",
    "sidet:create-knowledge-base-index-for-folder",
    "sidet:generate-wiki-memory-from-current-sidet-conversation",
    "sidet:generate-wiki-from-current-markdown-note",
    "sidet:insert-related-notes-into-sidet-draft",
    "sidet:insert-markdown-folder-summary-into-sidet-draft",
    "sidet:repair-sidet-wiki-notes"
  ];

  for (const commandId of allowedSidetCommands) {
    assert.equal(rules.isHomeLauncherCommandId(commandId), true, commandId);
  }
  for (const commandId of contextBoundSidetCommands) {
    assert.equal(rules.isHomeLauncherCommandId(commandId), false, commandId);
  }
  assert.equal(rules.isHomeLauncherCommandId("workspace:new-tab"), true);
  assert.equal(rules.isHomeLauncherCommandId("bookmarks:open"), true);
  assert.equal(rules.isHomeLauncherCommandId("editor:toggle-bold"), false);
  assert.equal(
    rules.migrateHomeLauncherCommandId("sidet:open-native-new-tab"),
    "workspace:new-tab"
  );
}

function assertSavedLauncherMigration(model) {
  assert.deepEqual(
    model.normalizeHomePinnedCommands([
      { commandId: "sidet:open-native-new-tab", labelOverride: "空白页" },
      { commandId: "workspace:new-tab" },
      { commandId: "sidet:open-sidet-conversation-list" },
      { commandId: "sidet:generate-wiki-from-current-markdown-note" },
      { commandId: "bookmarks:open" }
    ]),
    [
      { commandId: "workspace:new-tab", labelOverride: "空白页", iconOverride: "" },
      { commandId: "sidet:open-sidet-conversation-list", labelOverride: "", iconOverride: "" },
      { commandId: "bookmarks:open", labelOverride: "", iconOverride: "" }
    ]
  );

  assert.deepEqual(
    model.normalizeUrlLaunchers([
      { slot: 1, commandId: "sidet:open-native-new-tab" },
      { slot: 2, commandId: "sidet:repair-sidet-wiki-notes" },
      { slot: 3, commandId: "sidet:new-sidet-conversation" }
    ]),
    [
      { slot: 1, commandId: "workspace:new-tab" },
      { slot: 3, commandId: "sidet:new-sidet-conversation" }
    ]
  );
}

async function main() {
  try {
    const rules = await loadModule("src/settings/home-command-rules.ts", "rules.mjs");
    const model = await loadModule("src/settings/model.ts", "model.mjs");
    assertPublicCommandCatalog();
    assertHomeCommandBoundary(rules);
    assertSavedLauncherMigration(model);
    console.log("command governance logic test passed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
