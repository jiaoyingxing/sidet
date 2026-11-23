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

  assert.equal(module.shouldShowScrollBottomButton(true, false), true);
  assert.equal(module.shouldShowScrollBottomButton(true, true), false);
  assert.equal(module.shouldShowScrollBottomButton(false, false), false);
  assert.equal(module.shouldShowScrollBottomButton(false, true), false);

  console.log("chat view layout metrics logic test passed");
}

try {
  await main();
} finally {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
