import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-render-policy-"));
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

async function main() {
  try {
    const policy = await loadBundledModule("src/workspace/chat-view-render-policy.ts");

    const basePanel = {
      label: "深度思考",
      textSignature: policy.buildMetaPanelTextSignature("推理内容".repeat(30), false),
      sections: [
        {
          label: "步骤一",
          textSignature: policy.buildMetaPanelTextSignature("步骤正文".repeat(10), false),
          sourceCount: 1
        }
      ],
      sources: [
        { title: "来源一", url: "https://example.com/1" }
      ]
    };
    const baseSignature = policy.buildMetaPanelSignature(basePanel);
    assert.equal(
      policy.buildMetaPanelSignature({ ...basePanel }),
      baseSignature,
      "the panel signature should be stable for identical content"
    );
    assert.notEqual(
      policy.buildMetaPanelSignature({
        ...basePanel,
        textSignature: policy.buildMetaPanelTextSignature("推理内容".repeat(30) + "继续", false)
      }),
      baseSignature,
      "text growth should change the panel signature"
    );
    assert.notEqual(
      policy.buildMetaPanelSignature({
        ...basePanel,
        sections: [{
          label: "步骤一",
          textSignature: policy.buildMetaPanelTextSignature("步骤正文".repeat(10), false),
          sourceCount: 2
        }]
      }),
      baseSignature,
      "section source changes should change the panel signature"
    );
    assert.notEqual(
      policy.buildMetaPanelSignature({
        ...basePanel,
        sources: [{ title: "来源二", url: "https://example.com/2" }]
      }),
      baseSignature,
      "source changes should change the panel signature"
    );

    const sameLengthA = "甲乙丙丁".repeat(20);
    const sameLengthB = "甲乙丙戊".repeat(20);
    assert.equal(sameLengthA.length, sameLengthB.length);
    assert.notEqual(
      policy.buildMetaPanelTextSignature(sameLengthA, false),
      policy.buildMetaPanelTextSignature(sameLengthB, false),
      "terminal signatures must detect same-length content changes (version switches)"
    );
    assert.equal(
      policy.buildMetaPanelTextSignature("abcdef", true),
      "6:abcdef",
      "streaming signatures should stay cheap and include the tail"
    );

    assert.equal(
      policy.shouldUpdateMetaPanelPreview({
        signatureChanged: false,
        elapsedMs: 1000,
        streaming: true
      }),
      false,
      "unchanged preview content should be skipped"
    );
    assert.equal(
      policy.shouldUpdateMetaPanelPreview({
        signatureChanged: true,
        elapsedMs: 50,
        streaming: true
      }),
      false,
      "a streaming panel should throttle preview updates even when expanded"
    );
    assert.equal(
      policy.shouldUpdateMetaPanelPreview({
        signatureChanged: true,
        elapsedMs: 200,
        streaming: true
      }),
      true,
      "a streaming panel should update after the preview throttle"
    );
    assert.equal(
      policy.shouldUpdateMetaPanelPreview({
        signatureChanged: true,
        elapsedMs: 0,
        streaming: false
      }),
      true,
      "a terminal panel should update its preview without throttling"
    );

    assert.equal(
      policy.shouldRenderMetaPanelBody({
        signatureChanged: true,
        open: false,
        elapsedMs: 1000,
        streaming: true
      }),
      false,
      "collapsed panels must not render their bodies"
    );
    assert.equal(
      policy.shouldRenderMetaPanelBody({
        signatureChanged: false,
        open: true,
        elapsedMs: 1000,
        streaming: true
      }),
      false,
      "unchanged open panels should not rebuild their bodies"
    );
    assert.equal(
      policy.shouldRenderMetaPanelBody({
        signatureChanged: true,
        open: true,
        elapsedMs: 50,
        streaming: true
      }),
      false,
      "open streaming panels should throttle body rebuilds"
    );
    assert.equal(
      policy.shouldRenderMetaPanelBody({
        signatureChanged: true,
        open: true,
        elapsedMs: 200,
        streaming: true
      }),
      true,
      "open streaming panels should rebuild after the body throttle"
    );
    assert.equal(
      policy.shouldRenderMetaPanelBody({
        signatureChanged: true,
        open: true,
        elapsedMs: 0,
        streaming: false
      }),
      true,
      "terminal panels should always rebuild stale bodies"
    );

    assert.equal(
      policy.shouldFlushStreamingMarkdown({
        charsSinceLastFlush: 500,
        elapsedMs: 200,
        visible: false,
        pinnedToBottom: false
      }),
      false,
      "off-screen streaming markdown should wait until the user returns"
    );
    assert.equal(
      policy.shouldFlushStreamingMarkdown({
        charsSinceLastFlush: 60,
        elapsedMs: 10,
        visible: true,
        pinnedToBottom: false
      }),
      true,
      "a 60-character burst should flush immediately"
    );
    assert.equal(
      policy.shouldFlushStreamingMarkdown({
        charsSinceLastFlush: 10,
        elapsedMs: 140,
        visible: true,
        pinnedToBottom: false
      }),
      true,
      "the 140ms interval should flush small increments"
    );
    assert.equal(
      policy.shouldFlushStreamingMarkdown({
        charsSinceLastFlush: 10,
        elapsedMs: 50,
        visible: true,
        pinnedToBottom: false
      }),
      false,
      "small increments should wait for the interval"
    );
    assert.equal(
      policy.shouldFlushStreamingMarkdown({
        charsSinceLastFlush: 10,
        elapsedMs: 140,
        visible: false,
        pinnedToBottom: true
      }),
      true,
      "pinned-to-bottom messages should keep flushing even when only partly visible"
    );

    assert.equal(
      policy.isElementVerticallyVisible({
        itemTop: 200,
        itemBottom: 300,
        hostTop: 100,
        hostBottom: 400
      }),
      true
    );
    assert.equal(
      policy.isElementVerticallyVisible({
        itemTop: 50,
        itemBottom: 90,
        hostTop: 100,
        hostBottom: 400
      }),
      false
    );

    assert.equal(
      policy.shouldDeferMessageMarkdown({
        messageIndex: 0,
        messageCount: 40,
        forceHydrateAll: false
      }),
      true,
      "older messages outside the tail should defer Markdown"
    );
    assert.equal(
      policy.shouldDeferMessageMarkdown({
        messageIndex: 27,
        messageCount: 40,
        forceHydrateAll: false
      }),
      true,
      "the 13th message from the end should still defer"
    );
    assert.equal(
      policy.shouldDeferMessageMarkdown({
        messageIndex: 28,
        messageCount: 40,
        forceHydrateAll: false
      }),
      false,
      "the last 12 messages should render immediately"
    );
    assert.equal(
      policy.shouldDeferMessageMarkdown({
        messageIndex: 0,
        messageCount: 40,
        forceHydrateAll: true
      }),
      false,
      "a reveal request should force all messages to hydrate"
    );
    assert.equal(
      policy.shouldDeferMessageMarkdown({
        messageIndex: 0,
        messageCount: 4,
        tailCount: 3,
        forceHydrateAll: false
      }),
      true
    );
    assert.equal(
      policy.shouldDeferMessageMarkdown({
        messageIndex: 1,
        messageCount: 4,
        tailCount: 3,
        forceHydrateAll: false
      }),
      false
    );

    console.log("render policy logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
