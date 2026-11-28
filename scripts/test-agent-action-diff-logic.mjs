import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath, options = {}) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-agent-action-diff-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, `${path.basename(relativePath, ".ts")}.mjs`);

  await build({
    entryPoints: [path.join(rootDir, relativePath)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
    alias: options.alias
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function lineTexts(diff) {
  return diff.entries
    .filter((entry) => entry.kind === "line")
    .map((entry) => `${entry.line.type}:${entry.line.text}`);
}

function assertPathDisplay(module) {
  const folder = module.formatAgentActionPath("Sidet/Wiki/Resojot Todo.md");
  assert.equal(folder.folder, "Sidet/Wiki/");
  assert.equal(folder.fileName, "Resojot Todo.md");
  assert.equal(folder.fullPath, "Sidet/Wiki/Resojot Todo.md");
  assert.equal(folder.isRoot, false);

  const root = module.formatAgentActionPath("Resojot Todo.md");
  assert.equal(root.folder, "");
  assert.equal(root.fileName, "Resojot Todo.md");
  assert.equal(root.isRoot, true);

  const windowsPath = module.formatAgentActionPath("\\Sidet\\\\Wiki\\\\Resojot Todo.md");
  assert.equal(windowsPath.fullPath, "Sidet/Wiki/Resojot Todo.md");
  assert.equal(windowsPath.folder, "Sidet/Wiki/");

  const relative = module.formatAgentActionPath("./Sidet/Wiki/Resojot Todo.md");
  assert.equal(relative.fullPath, "Sidet/Wiki/Resojot Todo.md");
}

function assertLineDiff(module) {
  const existing = [
    "# 待办清单",
    "- [ ] 不能拍录音",
    "- [ ] 开始录音",
    "- [ ] 扫一扫地上的羽绒服毛",
    "- [ ] 测试电脑音频录制"
  ].join("\n");
  const next = [
    "# 待办清单",
    "- [ ] 不能拍录音",
    "- [x] 开始录音（今天已完成）",
    "- [ ] 扫一扫地上的羽绒服毛",
    "- [ ] 测试电脑音频录制",
    "- [ ] 试一下 Cloud Code"
  ].join("\n");

  const diff = module.computeAgentActionDiff(existing, next);
  assert.equal(diff.truncated, false);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.deepEqual(lineTexts(diff), [
    "context:# 待办清单",
    "context:- [ ] 不能拍录音",
    "remove:- [ ] 开始录音",
    "add:- [x] 开始录音（今天已完成）",
    "context:- [ ] 扫一扫地上的羽绒服毛",
    "context:- [ ] 测试电脑音频录制",
    "add:- [ ] 试一下 Cloud Code"
  ]);
}

function assertGapEntries(module) {
  const existing = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const next = existing.map((line, index) => index === 9 ? `${line} changed` : line);
  const diff = module.computeAgentActionDiff(existing.join("\n"), next.join("\n"));
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  const gaps = diff.entries.filter((entry) => entry.kind === "gap");
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].skipped, 6);
  assert.equal(gaps[1].skipped, 7);
}

function assertAppendDiff(module) {
  const existing = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n");
  const next = ["新条目一", "新条目二"].join("\n");
  const diff = module.buildAgentActionAppendDiff(existing, next);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 0);
  const gap = diff.entries.find((entry) => entry.kind === "gap");
  assert.ok(gap);
  assert.equal(gap.skipped, 7);
  assert.equal(gap.label, "… 原文前面 7 行未变 …");
  assert.deepEqual(lineTexts(diff), [
    "context:line 8",
    "context:line 9",
    "context:line 10",
    "add:新条目一",
    "add:新条目二"
  ]);
}

function assertNoChange(module) {
  const diff = module.computeAgentActionDiff("a\nb", "a\nb");
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  assert.deepEqual(diff.entries, []);
  assert.equal(module.countAgentActionLines("a\nb\n"), 2);
  assert.equal(module.countAgentActionLines(""), 0);
}

function assertTruncatedFallback(module) {
  const existing = Array.from({ length: 2100 }, (_, index) => `old ${index}`).join("\n");
  const next = Array.from({ length: 2100 }, (_, index) => `new ${index}`).join("\n");
  const diff = module.computeAgentActionDiff(existing, next);
  assert.equal(diff.truncated, true);
  assert.deepEqual(diff.entries, []);
  assert.equal(diff.added, 2100);
  assert.equal(diff.removed, 2100);
}

function assertFrontmatter(module) {
  const withFrontmatter = module.splitAgentActionFrontmatter([
    "---",
    'sidet_type: "draft"',
    "---",
    "# 标题",
    "正文"
  ].join("\n"));
  assert.equal(withFrontmatter.frontmatter, 'sidet_type: "draft"');
  assert.equal(withFrontmatter.body, "# 标题\n正文");

  const withoutFrontmatter = module.splitAgentActionFrontmatter("# 标题\n正文");
  assert.equal(withoutFrontmatter.frontmatter, null);
  assert.equal(withoutFrontmatter.body, "# 标题\n正文");

  const broken = module.splitAgentActionFrontmatter("---\n未闭合\n正文");
  assert.equal(broken.frontmatter, null);
  assert.equal(broken.body, "---\n未闭合\n正文");
}

function assertSignature(module) {
  const base = {
    kind: "replace-note",
    targetPath: "Sidet/Wiki/Resojot Todo.md",
    content: "# 待办"
  };
  const signature = module.buildAgentActionSignature(base);
  assert.equal(module.buildAgentActionSignature(base), signature);
  assert.notEqual(module.buildAgentActionSignature({ ...base, content: "# 待办 2" }), signature);
  assert.notEqual(module.buildAgentActionSignature({ ...base, targetPath: "Sidet/Wiki/Other.md" }), signature);
  assert.notEqual(module.buildAgentActionSignature({ ...base, kind: "append-note" }), signature);
}

function assertStaleGuard(actionModule) {
  assert.doesNotThrow(() => actionModule.assertAgentActionExpectedContent("a\nb", "a\nb"));
  assert.doesNotThrow(() => actionModule.assertAgentActionExpectedContent("a\nb", undefined));
  assert.throws(
    () => actionModule.assertAgentActionExpectedContent("a\nb", "a\nc"),
    (error) => error instanceof actionModule.AgentActionStaleTargetError
      && error.message === actionModule.AGENT_ACTION_STALE_TARGET_MESSAGE
  );
}

async function main() {
  const module = await loadBundledModule("src/agent/actions/agent-action-diff.ts");
  assertPathDisplay(module);
  assertLineDiff(module);
  assertGapEntries(module);
  assertAppendDiff(module);
  assertNoChange(module);
  assertTruncatedFallback(module);
  assertFrontmatter(module);
  assertSignature(module);

  const actionModule = await loadBundledModule("src/agent/actions/agent-action.ts", {
    alias: {
      obsidian: path.join(rootDir, "scripts", "test-stubs", "obsidian.ts")
    }
  });
  assertStaleGuard(actionModule);
  console.log("agent action diff logic passed");
}

try {
  await main();
} finally {
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
