import type { MessageMetaPanel, MessageRecord } from "../types";
import { supportsProcessStream } from "../conversations/assistant-visible-text";

export {
  getAssistantDisplayText,
  getAssistantTrailingTextOffset,
  stripAssistantProcessText,
  supportsProcessStream
} from "../conversations/assistant-visible-text";

/**
 * 新 assistant 消息的过程事件流。
 *
 * 生成时每个动作面板会记下 `reasoningBefore` / `textBefore`，这里把推理、动作、
 * 正文段按真实发生顺序排开；旧消息没有边界，继续走按类型分组的渲染。
 */
export interface ProcessStreamReasoningEvent {
  type: "reasoning";
  key: string;
  label: string;
  text: string;
}

export interface ProcessStreamPanelEvent {
  type: "panel";
  key: string;
  panel: MessageMetaPanel;
}

export interface ProcessStreamTextEvent {
  type: "text";
  key: string;
  text: string;
}

export type ProcessStreamEvent =
  | ProcessStreamReasoningEvent
  | ProcessStreamPanelEvent
  | ProcessStreamTextEvent;

export interface ProcessStreamStatusLine {
  kind: string;
  text: string;
}

export interface ProcessStreamLayout {
  events: ProcessStreamEvent[];
  statusLines: ProcessStreamStatusLine[];
  /** 最后一个动作之后的正文起点；这段作为最终回答留在正文容器里。 */
  trailingTextOffset: number;
}

/** 纯函数：把一条消息切成「推理 / 动作 / 正文段」的有序事件。 */
export function buildProcessStreamLayout(message: MessageRecord): ProcessStreamLayout {
  if (!supportsProcessStream(message)) {
    return {
      events: [],
      statusLines: [],
      trailingTextOffset: 0
    };
  }

  const reasoningText = message.reasoningText ?? "";
  const fullText = message.text;
  const reasoningLabel = message.reasoningLabel?.trim() || "深度思考";
  const events: ProcessStreamEvent[] = [];
  const statusLines: ProcessStreamStatusLine[] = [];
  let reasoningCursor = 0;
  let textCursor = 0;
  let reasoningIndex = 0;
  let textIndex = 0;

  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(value, max));

  const pushReasoning = (end: number): void => {
    const nextEnd = clamp(end, reasoningCursor, reasoningText.length);
    if (nextEnd <= reasoningCursor) {
      return;
    }
    const text = reasoningText.slice(reasoningCursor, nextEnd).trim();
    reasoningCursor = nextEnd;
    if (!text) {
      return;
    }
    events.push({
      type: "reasoning",
      key: `reasoning-${reasoningIndex}`,
      label: reasoningLabel,
      text
    });
    reasoningIndex += 1;
  };

  const pushText = (end: number): void => {
    const nextEnd = clamp(end, textCursor, fullText.length);
    if (nextEnd <= textCursor) {
      return;
    }
    const text = fullText.slice(textCursor, nextEnd);
    textCursor = nextEnd;
    if (!text.trim()) {
      return;
    }
    events.push({
      type: "text",
      key: `text-${textIndex}`,
      text
    });
    textIndex += 1;
  };

  for (const panel of message.metaPanels ?? []) {
    if (panel.display === "status") {
      const text = panel.text?.trim() ?? "";
      if (text) {
        statusLines.push({ kind: panel.kind, text });
      }
      continue;
    }

    pushReasoning(panel.reasoningBefore ?? reasoningCursor);
    pushText(panel.textBefore ?? textCursor);
    events.push({
      type: "panel",
      key: `panel:${panel.kind}`,
      panel
    });
  }

  // 最后一个动作之后的推理（通常是最终回答前的思考）仍在正文之前。
  pushReasoning(reasoningText.length);
  return {
    events,
    statusLines,
    trailingTextOffset: textCursor
  };
}
