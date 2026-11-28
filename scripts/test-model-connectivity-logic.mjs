import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-model-connectivity-"));

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

async function main() {
  const {
    buildModelConnectivityProbeRequest,
    interpretModelConnectivityResponse,
    sanitizeProviderMessage
  } = await loadBundledModule("src/provider/model-connectivity-request.ts");

  const input = {
    baseUrl: "https://api.example.com/v1/",
    model: "demo-model",
    apiKey: "sk-secret-key"
  };

  // 请求构造：地址去尾斜杠后拼 chat/completions，密钥只进 Authorization。
  const request = buildModelConnectivityProbeRequest(input);
  assert.equal(request.url, "https://api.example.com/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer sk-secret-key");
  assert.equal(request.headers["Content-Type"], "application/json");
  const body = JSON.parse(request.body);
  assert.equal(body.model, "demo-model");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 1);
  assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
  assert.equal(request.body.includes("sk-secret-key"), false, "密钥不得进入请求体");

  // o 系列等不接受 max_tokens 的模型：去掉限制重试。
  const retryBody = JSON.parse(
    buildModelConnectivityProbeRequest(input, { omitTokenLimit: true }).body
  );
  assert.equal("max_tokens" in retryBody, false);
  assert.equal(retryBody.model, "demo-model");

  // 2xx 必须是有效对话响应；2xx 里带 error / 业务错误 / HTML 都视为失败。
  assert.equal(
    interpretModelConnectivityResponse(
      200,
      JSON.stringify({ choices: [] }),
      input.apiKey
    ).ok,
    true
  );
  const bodyError = interpretModelConnectivityResponse(
    200,
    JSON.stringify({ error: { message: "bad gateway" } }),
    input.apiKey
  );
  assert.equal(bodyError.ok, false);
  assert.match(bodyError.message, /bad gateway/);
  const businessError = interpretModelConnectivityResponse(
    200,
    JSON.stringify({ code: 401, message: "invalid key" }),
    input.apiKey
  );
  assert.equal(businessError.ok, false);
  assert.match(businessError.message, /invalid key/);
  const htmlSuccess = interpretModelConnectivityResponse(
    200,
    "<!doctype html><html><body>ok</body></html>",
    input.apiKey
  );
  assert.equal(htmlSuccess.ok, false);
  assert.match(htmlSuccess.message, /不是对话响应/);

  // 常见状态码的人话分类。
  assert.equal(
    interpretModelConnectivityResponse(401, "", input.apiKey).message,
    "API Key 无效或没有权限。"
  );
  assert.equal(
    interpretModelConnectivityResponse(404, "", input.apiKey).message,
    "接口地址或模型 ID 不正确。"
  );
  assert.equal(
    interpretModelConnectivityResponse(429, "", input.apiKey).message,
    "请求过于频繁或额度不足。"
  );
  assert.match(
    interpretModelConnectivityResponse(503, "", input.apiKey).message,
    /503/
  );

  // 400 优先展示服务商原文，并抹掉密钥。
  const rejected = interpretModelConnectivityResponse(
    400,
    JSON.stringify({ error: { message: `model missing for key ${input.apiKey}` } }),
    input.apiKey
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /服务商拒绝了请求/);
  assert.match(rejected.message, /model missing/);
  assert.equal(rejected.message.includes(input.apiKey), false, "错误不得回显密钥");

  // 非 JSON 正文：错误消息压缩空白并截断。
  const raw = interpretModelConnectivityResponse(418, "line one\n\nline two", input.apiKey);
  assert.match(raw.message, /^连接失败（418）：line one line two/);
  const long = sanitizeProviderMessage("x".repeat(300), input.apiKey);
  assert.equal(long.length, 160);

  // sk- 片段即使不是当前密钥也要脱敏。
  assert.equal(
    sanitizeProviderMessage("bad key sk-abcdef12", input.apiKey).includes("sk-abcdef12"),
    false
  );

  console.log("model connectivity logic: ok");
}

try {
  await main();
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
