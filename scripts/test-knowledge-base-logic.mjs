import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkScriptPath = path.join(rootDir, "scripts", "check-knowledge-bases.mjs");

function writeMarkdown(vaultRoot, relativePath, content) {
  const fullPath = path.join(vaultRoot, relativePath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function runCheck(args) {
  const result = spawnSync(process.execPath, [checkScriptPath, ...args, "--json"], {
    cwd: rootDir,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "knowledge base check failed");
  return JSON.parse(result.stdout);
}

function buildFixtureVault() {
  const vaultRoot = mkdtempSync(path.join(os.tmpdir(), "sidet-kb-logic-"));

  writeMarkdown(vaultRoot, "Sidet/Wiki/Index.md", `---
sidet_type: knowledge-base
aliases:
  - Sidet Wiki
summary: Sidet 默认知识库
---

# Index

## 先读
- [[ChatView]]
`);

  writeMarkdown(vaultRoot, "Sidet/Wiki/ChatView.md", `---
sidet_type: concept-page
summary: ChatView 负责聊天主视图、滚动和消息渲染编排。
keywords:
  - chat-view
  - scroll
  - message
related:
  - Composer
---

# ChatView

## Scroll Host
- messagesEl 是桌面滚动宿主。
`);

  writeMarkdown(vaultRoot, "Sidet/Wiki/Composer.md", `---
sidet_type: supporting-note
summary: 输入区 composer 负责消息输入、附件条和发送动作。
keywords:
  - composer
  - input
---

# Composer

输入区顶部有附件条。
`);

  writeMarkdown(vaultRoot, "obsidian-help-zh/Index.md", `---
sidet_type: knowledge-base
aliases:
  - Obsidian 帮助
summary: 外部帮助知识库
---

# Index
`);

  writeMarkdown(vaultRoot, "obsidian-help-zh/Canvas.md", `---
sidet_type: concept-page
summary: Canvas 用于可视化连接笔记内容。
keywords:
  - canvas
  - whiteboard
---

# Canvas

Canvas 提供白板式布局。
`);

  return vaultRoot;
}

function assertKnowledgeBaseRecognition(summary) {
  assert.equal(summary.knowledgeBases.length, 2, "should recognize two knowledge bases");
  const names = summary.knowledgeBases.map((item) => item.displayName).sort();
  assert.deepEqual(names, ["Obsidian 帮助", "Sidet Wiki"]);
}

function assertScopedSearch(vaultRoot) {
  const scoped = runCheck([
    "--vault-root",
    vaultRoot,
    "--knowledge-base",
    "Sidet Wiki",
    "--query",
    "chat view scroll message",
    "--limit",
    "5"
  ]);
  assert.equal(scoped.knowledgeBases.length, 1, "scoped search should only include one knowledge base");
  const results = scoped.searchResults[scoped.knowledgeBases[0].indexPath] ?? [];
  assert.ok(results.length > 0, "scoped search should return matches");
  assert.ok(results.some((item) => item.path === "Sidet/Wiki/ChatView.md"), "should hit ChatView note");
  assert.ok(results.every((item) => item.path.startsWith("Sidet/Wiki/")), "results must stay inside selected root");
}

function assertCrossKnowledgeBaseIsolation(vaultRoot) {
  const scoped = runCheck([
    "--vault-root",
    vaultRoot,
    "--knowledge-base",
    "Obsidian 帮助",
    "--query",
    "chat view scroll message",
    "--limit",
    "5"
  ]);
  const results = scoped.searchResults[scoped.knowledgeBases[0].indexPath] ?? [];
  assert.equal(results.length, 0, "query should not leak into another knowledge base");
}

function main() {
  const vaultRoot = buildFixtureVault();
  try {
    const summary = runCheck(["--vault-root", vaultRoot]);
    assertKnowledgeBaseRecognition(summary);
    assertScopedSearch(vaultRoot);
    assertCrossKnowledgeBaseIsolation(vaultRoot);
    console.log("knowledge base logic test passed");
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
}

main();
