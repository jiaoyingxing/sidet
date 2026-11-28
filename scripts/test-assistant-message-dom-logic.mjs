import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-assistant-dom-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, `${path.basename(relativePath, ".ts")}.mjs`);

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

function createRoot({ single = {}, many = {} } = {}) {
  const calls = [];
  return {
    calls,
    querySelector(selector) {
      calls.push(selector);
      return single[selector] ?? null;
    },
    querySelectorAll(selector) {
      calls.push(selector);
      return many[selector] ?? [];
    }
  };
}

async function main() {
  const module = await loadBundledModule("src/workspace/assistant-message-dom.ts");
  const content = { name: "content" };
  const inlineA = { name: "inline-a" };
  const inlineB = { name: "inline-b" };
  const answerSources = { name: "answer-sources" };
  const answerVersions = { name: "answer-versions" };
  const answerActions = { name: "answer-actions" };
  const status = { name: "status" };
  const panel = { name: "panel" };
  const link = { name: "link" };
  const icon = { name: "icon" };
  const preview = { name: "preview" };
  const body = { name: "body" };
  const label = { name: "label" };

  const root = createRoot({
    single: {
      ".sidet-message-content": content,
      ".sidet-message-meta-panel-icon": icon,
      ".sidet-message-meta-panel-preview": preview,
      ".sidet-message-meta-panel-body": body,
      ".sidet-message-meta-panel-label": label
    },
    many: {
      ".sidet-agent-inline-action": [inlineA, inlineB],
      ".sidet-answer-sources": [answerSources],
      ".sidet-answer-versions": [answerVersions],
      ".sidet-answer-actions, .sidet-answer-error": [answerActions],
      ".sidet-message-status-line": [status],
      ".sidet-message-meta-panel": [panel],
      "a[href]": [link]
    }
  });

  assert.equal(module.findAssistantMessageContent(root), content);
  assert.deepEqual(module.findAssistantInlineActions(root), [inlineA, inlineB]);
  assert.deepEqual(module.findAssistantAnswerSources(root), [answerSources]);
  assert.deepEqual(module.findAssistantAnswerVersions(root), [answerVersions]);
  assert.deepEqual(module.findAssistantAnswerActions(root), [answerActions]);
  assert.deepEqual(module.findAssistantStatusLines(root), [status]);
  assert.deepEqual(module.findAssistantMetaPanels(root), [panel]);
  assert.deepEqual(module.findAssistantLinks(root), [link]);
  assert.deepEqual(module.findAssistantMetaPanelParts(root), { iconEl: icon, previewEl: preview, bodyEl: body, labelEl: label });

  const empty = createRoot();
  assert.equal(module.findAssistantMessageContent(empty), null);
  assert.deepEqual(module.findAssistantInlineActions(empty), []);
  assert.deepEqual(module.findAssistantAnswerSources(empty), []);
  assert.deepEqual(module.findAssistantAnswerVersions(empty), []);
  assert.deepEqual(module.findAssistantAnswerActions(empty), []);
  assert.deepEqual(module.findAssistantStatusLines(empty), []);
  assert.deepEqual(module.findAssistantMetaPanels(empty), []);
  assert.deepEqual(module.findAssistantLinks(empty), []);
  assert.deepEqual(module.findAssistantMetaPanelParts(empty), {
    iconEl: null,
    previewEl: null,
    bodyEl: null,
    labelEl: null
  });

  console.log("assistant message dom logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
