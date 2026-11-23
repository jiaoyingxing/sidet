import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPaths = [
  path.join(rootDir, "scripts", "test-knowledge-base-logic.mjs"),
  path.join(rootDir, "scripts", "test-conversation-store-logic.mjs"),
  path.join(rootDir, "scripts", "test-sidet-protocol-logic.mjs"),
  path.join(rootDir, "scripts", "test-sidet-prompt-context-logic.mjs"),
  path.join(rootDir, "scripts", "test-knowledge-command-routing-logic.mjs"),
  path.join(rootDir, "scripts", "test-sidet-agent-prompts-logic.mjs"),
  path.join(rootDir, "scripts", "test-sidet-context-bundles-logic.mjs"),
  path.join(rootDir, "scripts", "test-external-io-boundaries-logic.mjs"),
  path.join(rootDir, "scripts", "test-sidet-web-search-runtime-policy-logic.mjs"),
  path.join(rootDir, "scripts", "test-web-search-provider-logic.mjs"),
  path.join(rootDir, "scripts", "test-sidet-web-search-answering-logic.mjs"),
  path.join(rootDir, "scripts", "test-sidet-web-search-routing-logic.mjs"),
  path.join(rootDir, "scripts", "test-displayable-answer-stream-logic.mjs"),
  path.join(rootDir, "scripts", "test-user-skill-index-logic.mjs"),
  path.join(rootDir, "scripts", "test-chat-meta-panels-logic.mjs"),
  path.join(rootDir, "scripts", "test-chat-scroll-logic.mjs"),
  path.join(rootDir, "scripts", "test-assistant-message-dom-logic.mjs"),
  path.join(rootDir, "scripts", "test-chat-view-layout-metrics-logic.mjs"),
  path.join(rootDir, "scripts", "test-chat-home-logic.mjs"),
  path.join(rootDir, "scripts", "test-command-governance-logic.mjs"),
  path.join(rootDir, "scripts", "test-mobile-composer-layer-logic.mjs"),
  path.join(rootDir, "scripts", "test-mobile-keyboard-follow-logic.mjs"),
  path.join(rootDir, "scripts", "test-chat-draft-runtime-logic.mjs"),
  path.join(rootDir, "scripts", "test-chat-leaf-navigation-logic.mjs"),
  path.join(rootDir, "scripts", "test-chat-leaf-mode-rules-logic.mjs"),
  path.join(rootDir, "scripts", "test-model-selection-rules-logic.mjs"),
  path.join(rootDir, "scripts", "test-browser-view-list-runtime-logic.mjs"),
  path.join(rootDir, "scripts", "test-local-assistant-stream-logic.mjs"),
  path.join(rootDir, "scripts", "test-secret-storage-logic.mjs"),
  path.join(rootDir, "scripts", "test-settings-track-logic.mjs")
];

for (const scriptPath of scriptPaths) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: rootDir,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || `logic test failed: ${path.basename(scriptPath)}`);
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
}

console.log(`logic test suite passed (${scriptPaths.length} scripts)`);
