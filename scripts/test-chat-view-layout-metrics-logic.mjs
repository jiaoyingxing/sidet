import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-layout-metrics-"));
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

function rect({ left = 0, right = 0, top = 0, width = 0, height = 0 } = {}) {
  return { left, right, top, width, height };
}

async function main() {
  const module = await loadBundledModule("src/workspace/chat-view-layout-metrics.ts");

  assert.deepEqual(
    module.resolveHomeComposerInline(rect({ left: 12, right: 300 }), rect({ left: 10, right: 340 })),
    { left: "2px", right: "40px" }
  );
  assert.deepEqual(
    module.resolveHomeComposerInline(rect({ left: 10, right: 500 }), rect({ left: 10, right: 340 })),
    { left: "0px", right: "0px" }
  );

  assert.deepEqual(
    module.resolveHomeComposerSlot(rect({ top: 120, left: 30, width: 200.4 }), rect({ top: 100, left: 20 }), 50),
    { top: "70px", left: "10px", width: "200px" }
  );
  assert.deepEqual(
    module.resolveHomeComposerSlot(rect({ top: 10, left: 20, width: 100 }), rect({ top: 20, left: 20 }), 0),
    { top: "-10px", left: "0px", width: "100px" }
  );

  assert.equal(module.resolveHomeComposerSlotHeight(rect({ height: 54 })), "54px");
  assert.equal(module.resolveHomeComposerSlotHeight(rect({ height: 54.1 })), "55px");

  assert.equal(module.resolveScrollBottomTarget(1000, 400), 600);
  assert.equal(module.resolveScrollBottomTarget(300, 400), 0);
  assert.equal(module.resolveScrollBottomTarget(0, 0), 0);

  assert.equal(
    module.computeMessageRevealScrollTop({
      hostScrollTop: 200,
      hostTop: 100,
      itemTop: 600
    }),
    688,
    "message reveal should align the item top with a 12px breathing gap"
  );
  assert.equal(
    module.computeMessageRevealScrollTop({
      hostScrollTop: 0,
      hostTop: 100,
      itemTop: 90
    }),
    0,
    "message reveal must not produce a negative scroll top"
  );
  assert.equal(
    module.computeMessageRevealScrollTop({
      hostScrollTop: 50,
      hostTop: 100,
      itemTop: 300,
      padding: 0
    }),
    250,
    "message reveal padding should be configurable"
  );

  assert.equal(module.shouldShowScrollBottomButton(true, false), true);
  assert.equal(module.shouldShowScrollBottomButton(true, true), false);
  assert.equal(module.shouldShowScrollBottomButton(false, false), false);
  assert.equal(module.shouldShowScrollBottomButton(false, true), false);

  // 移动输入框悬空时，留白要含输入框到底缘的位移，而不是只加自身高度。
  assert.equal(
    module.resolveMobileComposerReservedSpace({
      scrollContentBottom: 810,
      composerTop: 690,
      gap: 8
    }),
    128
  );
  assert.equal(
    module.resolveMobileComposerReservedSpace({
      scrollContentBottom: 810,
      composerTop: 694.4,
      gap: 8
    }),
    124
  );
  // 输入框不再覆盖内容时留白归零，不产生负值或多余空白。
  assert.equal(
    module.resolveMobileComposerReservedSpace({
      scrollContentBottom: 700,
      composerTop: 760,
      gap: 8
    }),
    0
  );

  console.log("chat view layout metrics logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
