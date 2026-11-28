import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-conversation-search-"));
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

function createConversations() {
  return [
    {
      id: "conversation-1",
      title: "检索边界",
      createdAt: 1,
      updatedAt: 100,
      isPinned: false,
      isArchived: false,
      archivedAt: null,
      folderId: "folder-1",
      modelConfigId: null,
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "Sidet 的检索边界是什么？",
          createdAt: 10,
          status: "done"
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: [
            "## 答案",
            "",
            "检索边界是只在选中的知识库范围内检索。",
            "",
            "```sidet-research",
            "query: 检索",
            "```"
          ].join("\n"),
          createdAt: 20,
          status: "done"
        },
        {
          id: "user-2",
          role: "user",
          text: "再换一种说法",
          createdAt: 30,
          status: "done"
        },
        {
          id: "assistant-2",
          role: "assistant",
          text: "另一种说法：知识库与联网互斥。",
          createdAt: 40,
          status: "done"
        }
      ]
    },
    {
      id: "conversation-2",
      title: "周会记录",
      createdAt: 4,
      updatedAt: 200,
      isPinned: false,
      isArchived: false,
      archivedAt: null,
      folderId: null,
      modelConfigId: null,
      messages: [
        {
          id: "user-3",
          role: "user",
          text: "今天讨论了检索速度",
          createdAt: 50,
          status: "done"
        },
        {
          id: "assistant-3",
          role: "assistant",
          text: "检索速度需要继续观察。",
          createdAt: 60,
          status: "done"
        }
      ]
    },
    {
      id: "conversation-archived",
      title: "归档对话",
      createdAt: 5,
      updatedAt: 300,
      isPinned: false,
      isArchived: true,
      archivedAt: 300,
      folderId: null,
      modelConfigId: null,
      messages: [
        {
          id: "user-archived",
          role: "user",
          text: "归档里的检索记录",
          createdAt: 70,
          status: "done"
        }
      ]
    }
  ];
}

function assertSearchCore(module) {
  assert.deepEqual(
    module.normalizeConversationSearchTerms("  检索   边界 "),
    ["检索", "边界"],
    "search terms should be lowercased, whitespace-split and deduped"
  );
  assert.equal(module.matchesConversationSearchQuery("Sidet 检索边界", "检索 边界"), true);
  assert.equal(module.matchesConversationSearchQuery("Sidet 检索边界", "检索 不存在"), false);
  assert.equal(module.matchesConversationSearchQuery("Sidet 检索边界", "   "), true);

  const conversations = createConversations();
  const results = module.searchConversationMessages(conversations, "检索", {
    folderNames: new Map([["folder-1", "研究"]])
  });

  assert.deepEqual(
    results.map((hit) => `${hit.conversationId}:${hit.messageId}`),
    [
      "conversation-2:assistant-3",
      "conversation-2:user-3",
      "conversation-1:assistant-1",
      "conversation-1:user-1"
    ],
    "results should be ordered by conversation updatedAt and newest message first"
  );
  assert.equal(results[0].folderName, null, "root conversations should have no folder name");
  assert.equal(results[2].folderName, "研究", "folder names should resolve for hits inside folders");
  assert.equal(results[2].role, "assistant");
  assert.equal(results[2].conversationTitle, "检索边界");

  const boundaryHit = results.find((hit) => hit.messageId === "user-1");
  assert.ok(boundaryHit.snippet.includes("检索"), "snippet should contain the matched term");
  const boundaryRange = boundaryHit.matchRanges.find((range) => {
    return boundaryHit.snippet.slice(range.start, range.end).includes("检索");
  });
  assert.ok(boundaryRange, "match ranges should point at the matched term inside the snippet");

  const protocolResults = module.searchConversationMessages(conversations, "sidet-research");
  assert.deepEqual(protocolResults, [], "protocol blocks should not be searchable");

  const answerResults = module.searchConversationMessages(conversations, "答案");
  assert.equal(answerResults.length, 1);
  assert.equal(
    answerResults[0].snippet.startsWith("##"),
    false,
    "heading markers should be stripped from message snippets"
  );

  const multiTermResults = module.searchConversationMessages(conversations, "知识库 互斥");
  assert.deepEqual(
    multiTermResults.map((hit) => hit.messageId),
    ["assistant-2"],
    "multi-term search should require every term"
  );

  const archivedHidden = module.searchConversationMessages(conversations, "归档");
  assert.deepEqual(archivedHidden, [], "archived conversations should be excluded by default");
  const archivedIncluded = module.searchConversationMessages(conversations, "归档", {
    includeArchived: true
  });
  assert.deepEqual(
    archivedIncluded.map((hit) => hit.conversationId),
    ["conversation-archived"],
    "includeArchived should opt archived conversations back in"
  );

  const perConversation = module.searchConversationMessages(conversations, "检索", {
    perConversationLimit: 1
  });
  assert.equal(perConversation.length, 2, "perConversationLimit should cap hits per conversation");
  assert.equal(perConversation[0].conversationId, "conversation-2");
  assert.equal(perConversation[1].conversationId, "conversation-1");

  const limited = module.searchConversationMessages(conversations, "检索", { limit: 1 });
  assert.deepEqual(limited.map((hit) => hit.messageId), ["assistant-3"], "limit should cap total results");

  const variantConversation = [
    {
      id: "conversation-variant",
      title: "版本",
      createdAt: 1,
      updatedAt: 1,
      isPinned: false,
      isArchived: false,
      archivedAt: null,
      folderId: null,
      modelConfigId: null,
      messages: [
        {
          id: "assistant-variant",
          role: "assistant",
          text: "当前版本正文",
          createdAt: 1,
          status: "done",
          answerVariants: [
            {
              id: "assistant-old",
              text: "旧版本正文",
              status: "done",
              createdAt: 0
            }
          ],
          activeAnswerVariantIndex: 1
        }
      ]
    }
  ];
  assert.deepEqual(
    module.searchConversationMessages(variantConversation, "旧版本"),
    [],
    "inactive answer variants should not be searchable"
  );
  assert.deepEqual(
    module.searchConversationMessages(variantConversation, "当前版本").map((hit) => hit.messageId),
    ["assistant-variant"],
    "the active answer should be searchable"
  );
}

async function main() {
  try {
    const module = await loadBundledModule("src/conversations/conversation-search.ts");
    assertSearchCore(module);
    console.log("conversation search logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
