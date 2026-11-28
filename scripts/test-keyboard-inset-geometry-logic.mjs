import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-keyboard-inset-"));

async function loadBundledModule(relativePath) {
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

/** 模拟真实滚动段：长表单内容本身就溢出。 */
const CONTENT = 1353;
const VIEW = 588;
const NATIVE_MAX = CONTENT - VIEW;

async function main() {
  const { planKeyboardInset } = await loadBundledModule(
    "src/shared/modal/keyboard-inset-geometry.ts"
  );

  // 首次补锚：锚挂在内容真实底边，可滚上限精确 +N（回归：曾为 +0）。
  const first = planKeyboardInset({
    scrollHeight: CONTENT,
    appliedInset: 0,
    clientHeight: VIEW,
    targetScrollTop: NATIVE_MAX + 150
  });
  assert.equal(first.contentBottom, CONTENT);
  assert.equal(first.anchorTop, CONTENT);
  assert.equal(first.inset, 150);
  assert.equal(first.anchorTop + first.inset - VIEW, NATIVE_MAX + 150);
  assert.equal(first.scrollTop, NATIVE_MAX + 150);

  // 已挂锚的原始读数反算内容底边，不漂也不累积。
  const reapplied = planKeyboardInset({
    scrollHeight: CONTENT + 150,
    appliedInset: 150,
    clientHeight: VIEW,
    targetScrollTop: NATIVE_MAX + 150
  });
  assert.equal(reapplied.contentBottom, CONTENT);
  assert.equal(reapplied.anchorTop, CONTENT);
  assert.equal(reapplied.inset, 150);

  // 目标变大时按需增补，不是再加一遍。
  const larger = planKeyboardInset({
    scrollHeight: CONTENT,
    appliedInset: 0,
    clientHeight: VIEW,
    targetScrollTop: NATIVE_MAX + 400
  });
  assert.equal(larger.inset, 400);
  assert.equal(larger.scrollTop, NATIVE_MAX + 400);

  // 不需要避让时零动作：锚高 0、只前滚到目标。
  const noInset = planKeyboardInset({
    scrollHeight: CONTENT,
    appliedInset: 0,
    clientHeight: VIEW,
    targetScrollTop: NATIVE_MAX - 40
  });
  assert.equal(noInset.inset, 0);
  assert.equal(noInset.anchorTop, CONTENT);
  assert.equal(noInset.scrollTop, NATIVE_MAX - 40);

  // 短内容（装得下）也不误补。
  const shortContent = planKeyboardInset({
    scrollHeight: 274,
    appliedInset: 0,
    clientHeight: 274,
    targetScrollTop: 0
  });
  assert.equal(shortContent.inset, 0);
  assert.equal(shortContent.anchorTop, 274);
  assert.equal(shortContent.scrollTop, 0);

  // 收起回收：目标被压回自然上限、锚高归零。
  const reclaim = planKeyboardInset({
    scrollHeight: CONTENT + 300,
    appliedInset: 300,
    clientHeight: VIEW,
    targetScrollTop: NATIVE_MAX + 250,
    reclaim: true
  });
  assert.equal(reclaim.inset, 0);
  assert.equal(reclaim.scrollTop, NATIVE_MAX);

  // 回收与补锚不能同时生效（回收优先，避免残留余量）。
  const reclaimFirst = planKeyboardInset({
    scrollHeight: CONTENT,
    appliedInset: 0,
    clientHeight: VIEW,
    targetScrollTop: NATIVE_MAX + 500,
    reclaim: true
  });
  assert.equal(reclaimFirst.inset, 0);
  assert.equal(reclaimFirst.scrollTop, NATIVE_MAX);

  // 负目标与小容器不产生负余量（防御）。
  const zero = planKeyboardInset({
    scrollHeight: 100,
    appliedInset: 0,
    clientHeight: 588,
    targetScrollTop: -50
  });
  assert.equal(zero.inset, 0);
  assert.equal(zero.scrollTop, 0);
  assert.equal(zero.anchorTop, 100);

  const negative = planKeyboardInset({
    scrollHeight: -10,
    appliedInset: -10,
    clientHeight: -10,
    targetScrollTop: 0
  });
  assert.equal(negative.anchorTop, 0);
  assert.equal(negative.inset, 0);

  console.log("keyboard inset geometry logic: ok");
}

try {
  await main();
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
