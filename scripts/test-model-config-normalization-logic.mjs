import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-model-config-"));

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

function config(overrides) {
  return {
    id: "model-a",
    providerId: "mimo",
    model: "mimo-v2.5",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    reasoningEnabled: false,
    reasoningCompatibilityMode: "none",
    ...overrides
  };
}

async function main() {
  const { normalizeModelConfigs, resolveProviderFormDefaults } = await loadBundledModule("src/settings/model-configs.ts");

  // 新增模型表单：模型 ID 一律不预填，只留示例；自定义服务商名称 / 地址也留空。
  const providerIds = ["siliconflow", "mimo", "openai", "deepseek", "openrouter", "custom"];
  for (const providerId of providerIds) {
    const defaults = resolveProviderFormDefaults(providerId);
    assert.equal(defaults.model, "", `${providerId} 新增时不得预填模型 ID`);
    assert.ok(defaults.modelPlaceholder.trim().length > 0, `${providerId} 应提供模型示例`);
  }

  const customDefaults = resolveProviderFormDefaults("custom");
  assert.equal(customDefaults.providerLabel, "", "自定义服务商名称不预填");
  assert.equal(customDefaults.baseUrl, "", "自定义接口地址不预填");

  const siliconflowDefaults = resolveProviderFormDefaults("siliconflow");
  assert.equal(siliconflowDefaults.baseUrl, "https://api.siliconflow.cn/v1", "预设服务商保留接口地址");
  assert.ok(siliconflowDefaults.modelPlaceholder.includes("DeepSeek-V4.1-Flash"));
  assert.ok(resolveProviderFormDefaults("mimo").modelPlaceholder.includes("mimo-v2.6-pro"));
  assert.ok(resolveProviderFormDefaults("openai").modelPlaceholder.includes("gpt-6-luna"));
  assert.ok(resolveProviderFormDefaults("deepseek").modelPlaceholder.includes("deepseek-flash"));

  // 用户开关为 true：即使模型命中预设也保留（预设白名单已删除，不得覆盖）。
  const enabled = normalizeModelConfigs([
    config({ id: "enabled", supportsImageInput: true })
  ]).modelConfigs[0];
  assert.equal(enabled.supportsImageInput, true, "用户开启的图片能力必须保留");

  // 没有该字段：默认关闭。
  const missing = normalizeModelConfigs([
    config({ id: "missing" })
  ]).modelConfigs[0];
  assert.equal(missing.supportsImageInput, false, "缺省必须是关闭");

  // 显式 false：保持关闭。
  const disabled = normalizeModelConfigs([
    config({ id: "disabled", supportsImageInput: false })
  ]).modelConfigs[0];
  assert.equal(disabled.supportsImageInput, false);

  // 非布尔值不当作开启（只认严格 true）。
  const loose = normalizeModelConfigs([
    config({ id: "loose", supportsImageInput: "true" })
  ]).modelConfigs[0];
  assert.equal(loose.supportsImageInput, false, "字符串 / 数字等真值不算开启");

  // 旧数据迁移：没有开关字段时按关闭处理。
  const legacy = normalizeModelConfigs(undefined, {
    modelProviderId: "mimo",
    model: "mimo-v2.5",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1"
  }).modelConfigs[0];
  assert.equal(legacy.supportsImageInput, false, "旧数据默认关闭");

  // 旧数据显式开启：保留。
  const legacyEnabled = normalizeModelConfigs(undefined, {
    modelProviderId: "mimo",
    model: "mimo-v2.5",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    supportsImageInput: true
  }).modelConfigs[0];
  assert.equal(legacyEnabled.supportsImageInput, true);

  // 自动联网总开关：缺省与非法值都落到 auto，显式 off 必须保留。
  const { normalizeSettings } = await loadBundledModule("src/settings/model.ts");
  assert.equal(normalizeSettings({}).webSearchMode, "auto", "缺省应打开自动联网");
  assert.equal(normalizeSettings({ webSearchMode: "off" }).webSearchMode, "off");
  assert.equal(normalizeSettings({ webSearchMode: "bogus" }).webSearchMode, "auto");

  console.log("model config normalization logic: ok");
}

try {
  await main();
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
