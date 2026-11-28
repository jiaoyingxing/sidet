/**
 * 模型连通性探测的请求构造与响应解释（纯函数，零依赖，可直接单测）。
 *
 * 保存模型项前用当前地址 / 密钥 / 模型 ID 发一条最小对话请求：
 * 只验证「能不能连上、密钥是否有效、模型 ID 是否被接受」，不检查回答质量。
 * 请求体固定为一条 `ping`，默认 `max_tokens: 1`；部分新模型拒绝该参数时
 * 调用方会去掉限制重试一次（见 `model-connectivity.ts`）。
 */
export interface ModelConnectivityProbeInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ModelConnectivityProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ModelConnectivityProbeResult {
  ok: boolean;
  /** 失败时给用户看的短句；成功时为空字符串。 */
  message: string;
}

/** 错误正文里最多保留的字符数，避免把整段 HTML / JSON 塞进弹窗。 */
const MAX_MESSAGE_CHARS = 160;

export function buildModelConnectivityProbeRequest(
  input: ModelConnectivityProbeInput,
  options: { omitTokenLimit?: boolean } = {}
): ModelConnectivityProbeRequest {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/g, "");
  const payload: Record<string, unknown> = {
    model: input.model.trim(),
    messages: [{ role: "user", content: "ping" }],
    stream: false
  };
  if (options.omitTokenLimit !== true) {
    payload.max_tokens = 1;
  }
  return {
    url: `${baseUrl}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey.trim()}`
    },
    body: JSON.stringify(payload)
  };
}

/** 去掉密钥原文与常见的 `sk-` 片段，再压空白、截断。 */
export function sanitizeProviderMessage(text: string, secret?: string): string {
  let result = String(text ?? "");
  const trimmedSecret = secret?.trim();
  if (trimmedSecret) {
    result = result.split(trimmedSecret).join("***");
  }
  result = result.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, "sk-***");
  return result.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 非 2xx 时从 OpenAI 兼容错误体里取一句人话；取不到就用原文。 */
function extractProviderMessage(bodyText: string): string {
  const parsed = parseJson(bodyText);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
  }
  return bodyText;
}

/**
 * 2xx 但响应体不是有效对话响应：错误地址可能返回 200 HTML，部分服务商
 * 用 200 + `{code, message}` / `{success:false}` 表达业务错误。探测承诺
 * 「验证通过才落库」，因此这里必须校验到 OpenAI 兼容的 `choices` 数组。
 */
function extractSuccessBodyError(bodyText: string): string {
  const parsed = parseJson(bodyText);
  if (!parsed || typeof parsed !== "object") {
    return "接口返回的不是对话响应，请检查接口地址。";
  }
  const record = parsed as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  if (record.success === false) {
    const message = typeof record.message === "string" ? record.message.trim() : "";
    return message || "服务商返回失败状态。";
  }
  if (!Array.isArray(record.choices)) {
    const message = typeof record.message === "string" ? record.message.trim() : "";
    return message || "接口返回的不是对话响应，请检查接口地址。";
  }
  return "";
}

export function interpretModelConnectivityResponse(
  status: number,
  bodyText: string,
  secret?: string
): ModelConnectivityProbeResult {
  if (status >= 200 && status < 300) {
    const errorText = sanitizeProviderMessage(extractSuccessBodyError(bodyText), secret);
    if (errorText) {
      return {
        ok: false,
        message: errorText.startsWith("接口返回")
          ? errorText
          : `服务商返回错误：${errorText}`
      };
    }
    return { ok: true, message: "" };
  }

  const providerMessage = sanitizeProviderMessage(extractProviderMessage(bodyText), secret);
  if (status === 401 || status === 403) {
    return { ok: false, message: "API Key 无效或没有权限。" };
  }
  if (status === 404) {
    return { ok: false, message: "接口地址或模型 ID 不正确。" };
  }
  if (status === 429) {
    return { ok: false, message: "请求过于频繁或额度不足。" };
  }
  if (status >= 500) {
    return { ok: false, message: `服务商暂时不可用（${status}）。` };
  }
  if (status === 400) {
    return {
      ok: false,
      message: providerMessage
        ? `服务商拒绝了请求：${providerMessage}`
        : "服务商拒绝了请求，请检查模型 ID。"
    };
  }
  return {
    ok: false,
    message: providerMessage
      ? `连接失败（${status}）：${providerMessage}`
      : `连接失败（${status}）。`
  };
}
