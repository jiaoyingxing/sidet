import { stripSidetActionAndFollowing } from "../agent/actions/agent-tool-protocol";
import { stripSidetProtocolBlocks } from "../agent/web-search/sidet-protocol";
import { stripTrailingUnclosedFence } from "../shared/markdown-fence";
import type { MessageRecord } from "../types";

/**
 * assistant 消息的「可显示正文」。
 *
 * 事件流消息把推理、工具动作和动作之间的正文都追加在 `message.text` 里；
 * 界面只把最后一个动作之后的正文当最终回答。复制、搜索、摘要和 provider
 * 上下文必须复用同一切口，不能直接读整条 `message.text`。
 */

/** 只有生成时记录了事件边界的消息才走新布局；旧消息保持原分组。 */
export function supportsProcessStream(message: MessageRecord): boolean {
  if (message.role !== "assistant" || message.processStreamVersion !== 1) {
    return false;
  }
  return (message.metaPanels ?? []).every((panel) => (
    panel.display === "status"
    || (panel.reasoningBefore !== undefined && panel.textBefore !== undefined)
  ));
}

/** 最终回答容器的起点：最后一个动作面板创建时的正文长度。 */
export function getAssistantTrailingTextOffset(message: MessageRecord): number {
  if (!supportsProcessStream(message)) {
    return 0;
  }
  let offset = 0;
  for (const panel of message.metaPanels ?? []) {
    if (panel.display === "status" || panel.textBefore === undefined) {
      continue;
    }
    offset = Math.max(offset, Math.min(panel.textBefore, message.text.length));
  }
  return offset;
}

/**
 * 去掉协议块后的可显示正文；最终回答与动作之间的正文段共用。
 *
 * 旧消息可能残留流式阶段的半截围栏（协议块标签还没到就落库），这里统一
 * 清掉，避免历史对话继续显示空代码块。
 */
export function stripAssistantProcessText(text: string): string {
  return stripTrailingUnclosedFence(
    stripSidetActionAndFollowing(stripSidetProtocolBlocks(text))
  );
}

export function getAssistantDisplayText(message: MessageRecord): string {
  return stripAssistantProcessText(
    message.text.slice(getAssistantTrailingTextOffset(message))
  );
}
