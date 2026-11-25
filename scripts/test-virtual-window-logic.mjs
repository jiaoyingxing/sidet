import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-virtual-window-"));
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

function buildRects(count, height = 100, gap = 10) {
  return Array.from({ length: count }, (_, index) => {
    const top = index * (height + gap);
    return { index, top, bottom: top + height };
  });
}

function baseMessage(overrides = {}) {
  return {
    role: "assistant",
    text: "回答",
    status: "done",
    ...overrides
  };
}

async function main() {
  try {
    const virtual = await loadBundledModule("src/workspace/chat-view-virtual-window.ts");
    const rects = buildRects(20, 100, 10);

    assert.deepEqual(
      virtual.resolveVirtualMountRange({
        rects,
        viewportTop: 420,
        viewportBottom: 820
      }),
      { startIndex: 0, endIndex: 18 },
      "overscan should include messages before and after the viewport"
    );

    assert.deepEqual(
      virtual.resolveVirtualMountRange({
        rects,
        viewportTop: 420,
        viewportBottom: 820,
        overscanPx: 0
      }),
      { startIndex: 3, endIndex: 7 },
      "zero overscan should only include messages intersecting the viewport"
    );

    assert.equal(
      virtual.resolveVirtualMountRange({
        rects,
        viewportTop: 10_000,
        viewportBottom: 10_400
      }),
      null,
      "an empty window should return null instead of an inverted range"
    );

    assert.deepEqual(
      virtual.resolveVirtualMountRange({
        rects: [
          { index: 2, top: 0, bottom: 100 },
          { index: 5, top: 110, bottom: 210 }
        ],
        viewportTop: 0,
        viewportBottom: 200,
        overscanPx: 0
      }),
      { startIndex: 2, endIndex: 5 },
      "hidden messages should not make the range collapse to consecutive indices"
    );

    assert.equal(
      virtual.shouldUnmountVirtualItem({
        rect: rects[0],
        viewportTop: 4000,
        viewportBottom: 5000
      }),
      true,
      "a message far above the viewport should unmount"
    );
    assert.equal(
      virtual.shouldUnmountVirtualItem({
        rect: rects[10],
        viewportTop: 3000,
        viewportBottom: 4000
      }),
      false,
      "a message beyond the mount overscan but inside the unmount margin should stay mounted"
    );

    const userShort = virtual.estimateVirtualMessageHeight(
      baseMessage({ role: "user", text: "你好" })
    );
    const userLong = virtual.estimateVirtualMessageHeight(
      baseMessage({ role: "user", text: "长".repeat(420) })
    );
    assert.ok(userLong > userShort, "longer user messages should estimate taller");
    assert.ok(
      virtual.estimateVirtualMessageHeight(
        baseMessage({ text: "回答".repeat(640) })
      )
        > virtual.estimateVirtualMessageHeight(baseMessage({ text: "回答" })),
      "longer assistant messages should estimate taller"
    );
    assert.equal(
      virtual.estimateVirtualMessageHeight(
        baseMessage({ status: "streaming", text: "" })
      ),
      48,
      "an empty streaming answer should reserve the placeholder height"
    );
    assert.ok(
      virtual.estimateVirtualMessageHeight(
        baseMessage({ metaPanels: [{ kind: "thinking", label: "思考", text: "推理" }], sources: [{}] })
      )
        > virtual.estimateVirtualMessageHeight(baseMessage()),
      "meta panels and source footers should add estimated height"
    );
    assert.ok(
      virtual.estimateVirtualMessageHeight(
        baseMessage({ text: "超长".repeat(20_000) })
      ) <= virtual.VIRTUAL_WINDOW_MAX_ESTIMATE_HEIGHT_PX,
      "estimates must stay bounded for extremely long messages"
    );

    const message = baseMessage({ text: "第一版", status: "done" });
    const signature = virtual.buildVirtualMessageHeightSignature(message);
    assert.equal(
      virtual.buildVirtualMessageHeightSignature({ ...message }),
      signature,
      "unchanged messages should keep the same height signature"
    );
    assert.notEqual(
      virtual.buildVirtualMessageHeightSignature({ ...message, text: "第一版续" }),
      signature,
      "text growth should invalidate the height cache"
    );
    assert.notEqual(
      virtual.buildVirtualMessageHeightSignature({
        ...message,
        activeAnswerVariantIndex: 1,
        answerVariants: [{ id: "variant-1", text: "旧版", status: "done", createdAt: 1 }]
      }),
      signature,
      "version switches should invalidate the height cache"
    );
    assert.notEqual(
      virtual.buildVirtualMessageHeightSignature({
        ...message,
        metaPanels: [{ kind: "thinking", label: "思考", text: "更新后的推理" }]
      }),
      signature,
      "same-length meta panel changes should invalidate the height cache"
    );
    assert.equal(
      virtual.buildVirtualMessageHeightSignature({
        ...message,
        sources: [{ title: "来源", url: "https://example.com" }]
      }),
      virtual.buildVirtualMessageHeightSignature({
        ...message,
        sources: [{ title: "另一个", url: "https://example.com/2" }]
      }),
      "source titles do not change the footer height; only the count should"
    );
    const routingMessage = {
      ...message,
      knowledgeBaseRouting: {
        mode: "single",
        displayName: "测试库",
        status: "complete",
        resultCount: 1,
        hits: []
      }
    };
    assert.notEqual(
      virtual.buildVirtualMessageHeightSignature({
        ...routingMessage,
        knowledgeBaseRouting: { ...routingMessage.knowledgeBaseRouting, resultCount: 2 }
      }),
      virtual.buildVirtualMessageHeightSignature(routingMessage),
      "knowledge base routing result growth should invalidate the height cache"
    );

    console.log("virtual window logic passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
