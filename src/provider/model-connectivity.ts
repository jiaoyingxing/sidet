/**
 * 保存模型项前的连通性探测（2026-11-27）。
 *
 * 用当前地址 / 密钥 / 模型 ID 发一条最小对话请求；失败抛 `ModelConnectivityError`，
 * 由弹窗把原因显示在底栏上方并留在弹窗里。宿主管 `requestUrl` 没有 AbortSignal，
 * 超时只是停止等待，底层请求可能照常跑完；调用方用 guard 决定探测返回后是否落库。
 */
import { requestUrl } from "obsidian";
import {
  buildModelConnectivityProbeRequest,
  interpretModelConnectivityResponse,
  type ModelConnectivityProbeInput
} from "./model-connectivity-request";

const PROBE_TIMEOUT_MS = 20000;

class ProbeTimeoutError extends Error {
  constructor() {
    super("model connectivity probe timed out");
    this.name = "ProbeTimeoutError";
  }
}

export class ModelConnectivityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConnectivityError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new ProbeTimeoutError());
    }, timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

async function sendProbe(
  input: ModelConnectivityProbeInput,
  options: { omitTokenLimit?: boolean } = {}
): Promise<{ status: number; text: string }> {
  const request = buildModelConnectivityProbeRequest(input, options);
  const response = await withTimeout(requestUrl({
    url: request.url,
    method: "POST",
    headers: request.headers,
    body: request.body,
    // 非 2xx 也要拿到状态与正文，交给统一解释层分类。
    throw: false
  }), PROBE_TIMEOUT_MS);
  return { status: response.status, text: response.text };
}

/**
 * 探测失败抛 `ModelConnectivityError`（消息可直接给用户看）；
 * 成功返回 void。
 */
export async function testModelConnectivity(input: ModelConnectivityProbeInput): Promise<void> {
  let response: { status: number; text: string };
  try {
    response = await sendProbe(input);
  } catch (error) {
    if (error instanceof ProbeTimeoutError) {
      throw new ModelConnectivityError("连接超时，请检查接口地址或网络。");
    }
    throw new ModelConnectivityError("无法连接到服务商，请检查接口地址和网络。");
  }

  // 部分模型（如 o 系列）不接受 `max_tokens`：400 时去掉限制再试一次，
  // 避免「参数不兼容」被误判成「连不上」。第一次已被拒，没有生成成本。
  if (response.status === 400) {
    try {
      response = await sendProbe(input, { omitTokenLimit: true });
    } catch (error) {
      if (error instanceof ProbeTimeoutError) {
        throw new ModelConnectivityError("连接超时，请检查接口地址或网络。");
      }
      throw new ModelConnectivityError("无法连接到服务商，请检查接口地址和网络。");
    }
  }

  const result = interpretModelConnectivityResponse(response.status, response.text, input.apiKey);
  if (!result.ok) {
    throw new ModelConnectivityError(result.message);
  }
}
