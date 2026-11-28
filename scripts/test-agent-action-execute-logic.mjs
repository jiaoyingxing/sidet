import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

/**
 * 执行器与测试必须共享同一个 obsidian stub 里的 TFile 类，`instanceof TFile`
 * 才会成立；用 stdin 入口把执行器与 stub 打进同一个 bundle。
 */
async function loadHarness() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-agent-action-execute-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, "agent-action-execute-harness.mjs");

  await build({
    stdin: {
      contents: [
        `export { AgentActionExecutor, AgentActionStaleTargetError, normalizeAgentActionTargetPath } from "./src/agent/actions/agent-action";`,
        `export { TFile } from "obsidian";`
      ].join("\n"),
      resolveDir: rootDir,
      sourcefile: "agent-action-execute-test-entry.ts",
      loader: "ts"
    },
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

function createVault(Harness, documents) {
  const contents = new Map(documents);
  const files = [];

  function addFile(filePath, content) {
    const file = new Harness.TFile();
    file.path = filePath;
    file.basename = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
    file.extension = filePath.slice(filePath.lastIndexOf(".") + 1);
    files.push(file);
    contents.set(filePath, content);
    return file;
  }

  const vault = {
    getAbstractFileByPath(filePath) {
      return files.find((file) => file.path === filePath) ?? null;
    },
    async create(filePath, content) {
      if (vault.getAbstractFileByPath(filePath)) {
        throw new Error("File already exists.");
      }
      return addFile(filePath, content);
    },
    async process(file, transform) {
      const next = transform(contents.get(file.path) ?? "");
      contents.set(file.path, next);
      return next;
    },
    async read(file) {
      return contents.get(file.path) ?? "";
    },
    async cachedRead(file) {
      return contents.get(file.path) ?? "";
    },
    adapter: {
      async exists() {
        return true;
      },
      async mkdir() {
        // no-op: 目录由测试里的文件路径隐式存在
      }
    }
  };

  for (const [filePath, content] of contents) {
    if (!vault.getAbstractFileByPath(filePath)) {
      addFile(filePath, content);
    }
  }

  return { vault, contents };
}

function createPreview(overrides) {
  return {
    kind: "replace-note",
    title: "测试动作",
    targetPath: "Notes/Target.md",
    content: "新内容",
    sourceLabel: "测试",
    riskNotes: [],
    confirmLabel: "确认",
    successMessage: "已完成",
    ...overrides
  };
}

async function assertLiteralReplacement(Harness) {
  const original = "开头\nOLD-SELECTION\n结尾\n";
  const { vault, contents } = createVault(Harness, new Map([["Notes/Target.md", original]]));
  const executor = new Harness.AgentActionExecutor({ vault });
  const replacement = "代价 $& 前缀 $` 后缀 $' 和 $$ 都保持字面量";
  const preview = createPreview({
    kind: "replace-selection",
    selectionText: "OLD-SELECTION"
  });

  await executor.execute(preview, {
    targetPath: "Notes/Target.md",
    content: replacement,
    expectedExistingContent: original
  });

  assert.equal(
    contents.get("Notes/Target.md"),
    `开头\n${replacement}\n结尾\n`,
    "替换正文里的 $ 模式不能被 String.replace 展开"
  );
}

async function assertStaleTargetRejected(Harness) {
  const { vault, contents } = createVault(Harness, new Map([["Notes/Target.md", "旧内容\n"]]));
  const executor = new Harness.AgentActionExecutor({ vault });

  await assert.rejects(
    () => executor.execute(createPreview({ kind: "replace-note" }), {
      targetPath: "Notes/Target.md",
      content: "新内容",
      expectedExistingContent: "卡片打开时的内容\n"
    }),
    (error) => error instanceof Harness.AgentActionStaleTargetError
  );
  assert.equal(contents.get("Notes/Target.md"), "旧内容\n", "stale 时不得写入");
}

async function assertNonUniqueSelectionRejected(Harness) {
  const original = "重复段落\n中间\n重复段落\n";
  const { vault, contents } = createVault(Harness, new Map([["Notes/Target.md", original]]));
  const executor = new Harness.AgentActionExecutor({ vault });

  await assert.rejects(
    () => executor.execute(
      createPreview({ kind: "replace-selection", selectionText: "重复段落" }),
      {
        targetPath: "Notes/Target.md",
        content: "替换",
        expectedExistingContent: original
      }
    ),
    /不是唯一匹配/
  );
  assert.equal(contents.get("Notes/Target.md"), original, "非唯一匹配时不得写入");
}

async function assertAppendKeepsExistingText(Harness) {
  const original = "第一段\n\n";
  const { vault, contents } = createVault(Harness, new Map([["Notes/Target.md", original]]));
  const executor = new Harness.AgentActionExecutor({ vault });

  await executor.execute(createPreview({ kind: "append-note", content: "追加段" }), {
    targetPath: "Notes/Target.md",
    content: "追加段",
    expectedExistingContent: original
  });

  assert.equal(contents.get("Notes/Target.md"), "第一段\n\n追加段\n");
}

async function assertCreateRejectsExistingPath(Harness) {
  const { vault } = createVault(Harness, new Map([["Notes/Target.md", "已存在\n"]]));
  const executor = new Harness.AgentActionExecutor({ vault });

  await assert.rejects(
    () => executor.execute(createPreview({ kind: "create-note" }), {
      targetPath: "Notes/Target.md",
      content: "新内容"
    }),
    /目标路径已存在/
  );
}

function assertTargetPathGuard(Harness) {
  assert.equal(Harness.normalizeAgentActionTargetPath("Notes/Target"), "Notes/Target.md");
  assert.equal(Harness.normalizeAgentActionTargetPath("Notes\\Target.md"), "Notes/Target.md");
  assert.equal(Harness.normalizeAgentActionTargetPath("../Outside.md"), "", "不得允许 .. 越出 vault");
  assert.equal(Harness.normalizeAgentActionTargetPath("Notes/../../Outside.md"), "", "不得允许中间 .. 段");
  assert.equal(Harness.normalizeAgentActionTargetPath("   "), "", "空路径判无效");
}

const Harness = await loadHarness();

try {
  await assertLiteralReplacement(Harness);
  await assertStaleTargetRejected(Harness);
  await assertNonUniqueSelectionRejected(Harness);
  await assertAppendKeepsExistingText(Harness);
  await assertCreateRejectsExistingPath(Harness);
  assertTargetPathGuard(Harness);
  console.log("agent action execute logic test passed");
} finally {
  for (const tempDir of tempDirs) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
