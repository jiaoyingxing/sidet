import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-answer-presentation-"));
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

function createMessage(overrides = {}) {
  return {
    id: "assistant-1",
    role: "assistant",
    text: "回答",
    createdAt: 1,
    status: "done",
    ...overrides
  };
}

async function main() {
  const module = await loadBundledModule("src/workspace/chat-view-answer-presentation.ts");

  assert.deepEqual(module.getAnswerActionPlan(createMessage()), {
    mode: "done",
    actions: ["copy", "regenerate", "more"]
  });

  assert.deepEqual(module.getAnswerActionPlan(createMessage({ status: "streaming", text: "" })), {
    mode: "none",
    actions: []
  });

  assert.deepEqual(module.getAnswerActionPlan(createMessage({ role: "user" })), {
    mode: "none",
    actions: []
  });

  assert.deepEqual(
    module.getAnswerActionPlan(createMessage({
      status: "error",
      text: "请先在模型设置里填写这条模型的 API Key。",
      errorText: "请先在模型设置里填写这条模型的 API Key。"
    })),
    {
      mode: "error",
      actions: ["open-settings", "retry", "copy-error"]
    }
  );

  assert.deepEqual(
    module.getAnswerActionPlan(createMessage({
      status: "error",
      text: "回答到一半",
      errorText: "网络连接中断"
    })),
    {
      mode: "error",
      actions: ["retry", "copy-error"]
    }
  );

  const messages = [
    createMessage({ id: "user-1", role: "user", text: "问题" }),
    createMessage({ id: "assistant-1" })
  ];
  assert.equal(module.isLatestAssistantMessage(messages, messages[1]), true);
  assert.equal(module.isLatestAssistantMessage(messages, messages[0]), false);
  assert.equal(module.isLatestAssistantMessage([], messages[1]), false);

  assert.equal(module.hasPartialErrorContent(createMessage({
    status: "error",
    text: "回答到一半",
    errorText: "网络连接中断"
  })), true);
  assert.equal(module.hasPartialErrorContent(createMessage({
    status: "error",
    text: "网络连接中断",
    errorText: "网络连接中断"
  })), false);
  assert.equal(module.hasPartialErrorContent(createMessage({ status: "done" })), false);

  assert.deepEqual(module.getAnswerVersionInfo(createMessage()), {
    total: 1,
    index: 0,
    hasMultiple: false,
    label: "1 / 1"
  });
  assert.deepEqual(
    module.getAnswerVersionInfo(createMessage({
      answerVariants: [
        { id: "assistant-0", text: "第一版", status: "done", createdAt: 1 }
      ],
      activeAnswerVariantIndex: 1
    })),
    {
      total: 2,
      index: 1,
      hasMultiple: true,
      label: "2 / 2"
    }
  );
  assert.deepEqual(
    module.getAnswerVersionInfo(createMessage({
      answerVariants: [
        { id: "assistant-0", text: "第一版", status: "done", createdAt: 1 }
      ],
      activeAnswerVariantIndex: 5
    })),
    {
      total: 2,
      index: 1,
      hasMultiple: true,
      label: "2 / 2"
    },
    "out-of-range active indexes should fall back to the newest version"
  );

  const regenerateConversation = (messages) => ({
    id: "conversation-1",
    title: "重新生成",
    createdAt: 1,
    updatedAt: 1,
    isPinned: false,
    isArchived: false,
    archivedAt: null,
    folderId: null,
    modelConfigId: null,
    messages
  });
  const regenerateUser = createMessage({ id: "user-1", role: "user", text: "问题" });
  assert.deepEqual(
    module.resolveRegenerateAnswerTarget(regenerateConversation([
      regenerateUser,
      createMessage({ id: "assistant-1", role: "assistant", text: "回答", status: "done" })
    ])),
    {
      userMessage: regenerateUser,
      variantOfMessageId: "assistant-1"
    },
    "a done answer should be kept as a version on regenerate"
  );
  assert.equal(
    module.resolveRegenerateAnswerTarget(regenerateConversation([
      regenerateUser,
      createMessage({ id: "assistant-1", role: "assistant", text: "失败的说明", status: "error" })
    ])).variantOfMessageId,
    null,
    "a plain failed answer should be replaced rather than versioned"
  );
  assert.equal(
    module.resolveRegenerateAnswerTarget(regenerateConversation([
      regenerateUser,
      createMessage({
        id: "assistant-1",
        role: "assistant",
        text: "错误版本",
        status: "error",
        answerVariants: [{ id: "assistant-0", text: "旧回答", status: "done", createdAt: 1 }],
        activeAnswerVariantIndex: 1
      })
    ])).variantOfMessageId,
    "assistant-1",
    "an error that is already part of a version history should keep that history"
  );
  assert.throws(
    () => module.resolveRegenerateAnswerTarget(regenerateConversation([
      regenerateUser,
      createMessage({ id: "assistant-1", role: "assistant", text: "", status: "streaming" })
    ])),
    /最后一条已完成/
  );
  assert.throws(
    () => module.resolveRegenerateAnswerTarget(regenerateConversation([regenerateUser])),
    /最后一条已完成/
  );
  assert.throws(
    () => module.resolveRegenerateAnswerTarget(regenerateConversation([
      createMessage({ id: "assistant-1", role: "assistant", text: "回答", status: "done" })
    ])),
    /用户消息/
  );
  assert.throws(
    () => module.resolveRegenerateAnswerTarget(regenerateConversation([
      createMessage({
        id: "user-1",
        role: "user",
        text: "知识库问题",
        knowledgeBaseRouting: {
          mode: "all",
          displayName: "全部知识库",
          status: "complete",
          resultCount: 1,
          hits: []
        }
      }),
      createMessage({ id: "assistant-1", role: "assistant", text: "回答", status: "done" })
    ])),
    /知识库/
  );

  const fullSource = { title: "全文", url: "https://a.example", readDepth: "full" };
  const summarySource = { title: "摘要", url: "https://b.example", readDepth: "summary" };
  const unmarkedSource = { title: "未标记" };
  assert.deepEqual(module.getSourceSummary([fullSource, summarySource, unmarkedSource]), {
    total: 3,
    fullCount: 1,
    summaryCount: 2,
    label: "1 篇已读全文 · 2 条摘要"
  });
  assert.deepEqual(module.getSourceSummary([fullSource]), {
    total: 1,
    fullCount: 1,
    summaryCount: 0,
    label: "1 篇已读全文"
  });
  assert.deepEqual(module.getSourceSummary([summarySource, unmarkedSource]), {
    total: 2,
    fullCount: 0,
    summaryCount: 2,
    label: "2 条摘要 · 未逐页核对"
  });
  assert.deepEqual(module.getSourceSummary([]), {
    total: 0,
    fullCount: 0,
    summaryCount: 0,
    label: ""
  });

  assert.deepEqual(module.splitCitationSegments("甲[1]乙[2]丙", 2), [
    { type: "text", text: "甲" },
    { type: "citation", index: 1, raw: "[1]" },
    { type: "text", text: "乙" },
    { type: "citation", index: 2, raw: "[2]" },
    { type: "text", text: "丙" }
  ]);
  assert.deepEqual(module.splitCitationSegments("未知[9]编号[0]", 2), [
    { type: "text", text: "未知[9]编号[0]" }
  ]);
  assert.deepEqual(module.splitCitationSegments("没有引用", 2), [
    { type: "text", text: "没有引用" }
  ]);
  assert.deepEqual(module.splitCitationSegments("连续[1][2]", 2), [
    { type: "text", text: "连续" },
    { type: "citation", index: 1, raw: "[1]" },
    { type: "citation", index: 2, raw: "[2]" }
  ]);

  assert.equal(module.classifyAssistantError("请先在模型设置里填写这条模型的 API Key。").kind, "auth");
  assert.equal(module.classifyAssistantError("HTTP 429 Too Many Requests").kind, "rate-limit");
  assert.equal(module.classifyAssistantError("等待生成超时").kind, "timeout");
  assert.equal(module.classifyAssistantError("TypeError: Failed to fetch").kind, "network");
  assert.equal(module.classifyAssistantError("接口未返回可读流。").kind, "protocol");
  assert.equal(module.classifyAssistantError("未知错误").kind, "unknown");
  assert.deepEqual(module.classifyAssistantError("网络连接中断").actions, ["retry", "copy-error"]);

  console.log("answer presentation logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
