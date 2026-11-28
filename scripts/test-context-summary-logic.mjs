import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-context-summary-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, `${path.basename(relativePath, ".ts")}.mjs`);

  await build({
    entryPoints: [path.join(rootDir, relativePath)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
    alias: {
      obsidian: path.join(rootDir, "scripts", "test-stubs", "obsidian.ts")
    }
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

let messageSequence = 0;

function message(role, text, attachments = []) {
  messageSequence += 1;
  return {
    id: `message-${messageSequence}`,
    role,
    text,
    createdAt: messageSequence,
    status: "done",
    attachments: attachments.length > 0 ? attachments : undefined
  };
}

function conversation(messages, contextSummary) {
  return {
    id: "conversation-1",
    title: "摘要测试",
    createdAt: 1,
    updatedAt: 1,
    isPinned: false,
    isArchived: false,
    archivedAt: null,
    folderId: null,
    modelConfigId: null,
    messages,
    contextSummary
  };
}

function alternatingMessages(count) {
  return Array.from({ length: count }, (_value, index) => {
    return message(index % 2 === 0 ? "user" : "assistant", `消息 ${index}`);
  });
}

async function main() {
  try {
    const module = await loadBundledModule("src/conversations/conversation-context-summary.ts");

    assert.equal(module.CONTEXT_SUMMARY_RAW_MESSAGE_COUNT, 16);
    assert.equal(module.CONTEXT_SUMMARY_MIN_NEW_MESSAGES, 6);

    const noRange = conversation(alternatingMessages(16));
    assert.equal(module.findContextSummaryRange(noRange), null, "a conversation inside the raw window has nothing to summarize");

    const messages = alternatingMessages(40);
    const range = module.findContextSummaryRange(conversation(messages));
    assert.ok(range);
    assert.equal(range.startIndex, 0);
    assert.equal(range.endIndex, 23);
    assert.equal(range.endMessage.id, messages[23].id);
    assert.equal(range.messages.length, 24);
    assert.equal(range.previousSummary, null);

    const previousSummary = {
      text: "旧摘要",
      summarizedThroughMessageId: messages[10].id,
      updatedAt: 1
    };
    const incremental = module.findContextSummaryRange(conversation(messages, previousSummary));
    assert.ok(incremental);
    assert.equal(incremental.startIndex, 11);
    assert.equal(incremental.messages.length, 13);
    assert.deepEqual(incremental.previousSummary, previousSummary);

    const tooFew = module.findContextSummaryRange(conversation(messages, {
      text: "旧摘要",
      summarizedThroughMessageId: messages[20].id,
      updatedAt: 1
    }));
    assert.equal(tooFew, null, "fewer than the minimum new messages should not trigger another summary");

    const missingAnchor = module.findContextSummaryRange(conversation(messages, {
      text: "旧摘要",
      summarizedThroughMessageId: "missing-message",
      updatedAt: 1
    }));
    assert.equal(missingAnchor.startIndex, 0, "a missing anchor should restart the summary range");

    const inputMessages = [
      message("user", "请继续整理计划"),
      message("assistant", "好的\n```sidet-research\nquery: 测试\n```\n结论是 A。"),
      message("user", "补充", [{
        id: "markdown-1",
        type: "markdown",
        name: "计划.md",
        path: "计划.md",
        content: "内容",
        truncated: false,
        size: 2
      }])
    ];
    const input = module.buildContextSummaryInput({
      previousSummary,
      startIndex: 0,
      endIndex: inputMessages.length - 1,
      endMessage: inputMessages[inputMessages.length - 1],
      messages: inputMessages
    });
    assert.match(input, /已有背景摘要/);
    assert.match(input, /旧摘要/);
    assert.match(input, /用户：请继续整理计划/);
    assert.match(input, /结论是 A/);
    assert.doesNotMatch(input, /sidet-research/);
    assert.match(input, /\[笔记 计划\.md\]/);

    const hugeInput = module.buildContextSummaryInput({
      previousSummary: null,
      startIndex: 0,
      endIndex: 0,
      endMessage: message("assistant", "x".repeat(30000)),
      messages: [message("assistant", "x".repeat(30000))]
    });
    assert.ok(
      hugeInput.length <= module.CONTEXT_SUMMARY_MAX_INPUT_CHARS + 20,
      "oversized summary input should be clipped"
    );
    assert.match(hugeInput, /^（较早内容已省略）/);

    const requestMessages = module.buildContextSummaryRequestMessages("输入");
    assert.equal(requestMessages.length, 2);
    assert.equal(requestMessages[0].role, "system");
    assert.equal(requestMessages[1].role, "user");
    assert.match(requestMessages[0].text, /对话压缩器/);

    assert.equal(module.normalizeContextSummaryText("  "), null);
    assert.equal(
      module.normalizeContextSummaryText("```md\n摘要正文\n```"),
      "摘要正文",
      "code fences should be stripped from summary output"
    );
    const longSummary = module.normalizeContextSummaryText("y".repeat(2000));
    assert.equal(longSummary.length, module.CONTEXT_SUMMARY_MAX_OUTPUT_CHARS);
    assert.match(longSummary, /…$/);

    const selectionMessages = alternatingMessages(6);
    const selection = module.selectProviderMessagesWithContextSummary(selectionMessages, {
      text: "背景",
      summarizedThroughMessageId: selectionMessages[2].id,
      updatedAt: 1
    });
    assert.ok(selection);
    assert.match(selection.summaryMessage.text, /较早对话摘要/);
    assert.match(selection.summaryMessage.text, /背景/);
    assert.deepEqual(
      selection.recentMessages.map((item) => item.id),
      selectionMessages.slice(3).map((item) => item.id)
    );
    assert.equal(
      module.selectProviderMessagesWithContextSummary(selectionMessages, {
        text: "背景",
        summarizedThroughMessageId: "missing",
        updatedAt: 1
      }),
      null,
      "a missing summary anchor should fall back to raw history"
    );

    console.log("context summary logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
