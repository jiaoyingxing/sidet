import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-context-budget-"));
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

let nextMessageIndex = 0;

function message(role, textLength, attachments = []) {
  nextMessageIndex += 1;
  return {
    id: `message-${nextMessageIndex}`,
    role,
    text: "x".repeat(textLength),
    createdAt: nextMessageIndex,
    status: "done",
    attachments: attachments.length > 0 ? attachments : undefined
  };
}

function imageAttachment() {
  return {
    id: "image-1",
    type: "image",
    name: "image.png",
    mimeType: "image/png",
    size: 1,
    dataUrl: "data:image/png;base64," + "A".repeat(100000)
  };
}

function markdownAttachment(contentLength) {
  return {
    id: "markdown-1",
    type: "markdown",
    name: "note.md",
    path: "note.md",
    content: "y".repeat(contentLength),
    truncated: false,
    size: contentLength
  };
}

async function main() {
  try {
    const module = await loadBundledModule("src/conversations/conversation-context-budget.ts");
    assert.equal(
      module.resolveModelContextWindowTokens({
        providerId: "openai",
        presetId: "openai-gpt-4o",
        model: "gpt-4o"
      }),
      128000,
      "known presets should resolve their declared context window"
    );
    assert.equal(
      module.resolveModelContextWindowTokens({
        providerId: "siliconflow",
        presetId: null,
        model: "custom-model"
      }),
      32000,
      "unknown custom models should fall back to the conservative default window"
    );
    const options = (maxChars, reservedChars = 0) => ({
      maxChars,
      reservedChars,
      imageCostChars: 4000
    });

    const shortMessages = [
      message("user", 10),
      message("assistant", 10),
      message("user", 10)
    ];
    assert.deepEqual(
      module.trimProviderMessagesForBudget(shortMessages, options(100)),
      {
        messages: shortMessages,
        omittedCount: 0,
        truncated: false
      },
      "messages under budget should pass through unchanged"
    );

    const conversation = [
      message("user", 100),
      message("assistant", 100),
      message("user", 100),
      message("assistant", 100),
      message("user", 100)
    ];
    const tight = module.trimProviderMessagesForBudget(conversation, options(250));
    assert.deepEqual(
      tight.messages.map((item) => item.id),
      [conversation[4].id],
      "a suffix starting with an orphan assistant should drop that assistant"
    );
    assert.equal(tight.omittedCount, 4);
    assert.equal(tight.truncated, true);

    const medium = module.trimProviderMessagesForBudget(conversation, options(350));
    assert.deepEqual(
      medium.messages.map((item) => item.id),
      [conversation[2].id, conversation[3].id, conversation[4].id],
      "the selected suffix should start at a user message and keep the newest turns"
    );
    assert.equal(medium.omittedCount, 2);

    const onlyLast = module.trimProviderMessagesForBudget(
      [message("user", 500), message("user", 500)],
      options(100)
    );
    assert.deepEqual(
      onlyLast.messages.map((item) => item.id).length,
      1,
      "the last message must always be kept even when it exceeds the budget"
    );

    const reserved = module.trimProviderMessagesForBudget(conversation, options(350, 200));
    assert.deepEqual(
      reserved.messages.map((item) => item.id),
      [conversation[4].id],
      "reserved request context should shrink the history budget"
    );

    assert.equal(
      module.estimateProviderMessageChars(
        message("user", 3, [imageAttachment()]),
        4000
      ),
      4003,
      "images should use a fixed context cost instead of the data URL length"
    );
    assert.equal(
      module.estimateProviderMessageChars(
        message("user", 3, [markdownAttachment(600)]),
        4000
      ),
      603,
      "markdown attachments should count their content length"
    );

    const imageConversation = [
      message("user", 1, [imageAttachment()]),
      message("assistant", 1),
      message("user", 1)
    ];
    const imageTrimmed = module.trimProviderMessagesForBudget(imageConversation, options(1000));
    assert.deepEqual(
      imageTrimmed.messages.map((item) => item.id),
      [imageConversation[2].id],
      "an older image message should be dropped when its fixed cost exceeds the budget"
    );

    const assistantOnly = [
      message("assistant", 100),
      message("assistant", 100)
    ];
    const assistantOnlyTrimmed = module.trimProviderMessagesForBudget(assistantOnly, options(150));
    assert.deepEqual(
      assistantOnlyTrimmed.messages.map((item) => item.id),
      [assistantOnly[1].id],
      "an assistant-only history should keep its newest message"
    );

    assert.deepEqual(
      module.trimProviderMessagesForBudget([], options(100)),
      { messages: [], omittedCount: 0, truncated: false },
      "empty histories should stay empty"
    );

    console.log("context budget logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
