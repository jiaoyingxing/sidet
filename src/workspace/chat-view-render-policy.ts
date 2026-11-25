export const META_PANEL_PREVIEW_THROTTLE_MS = 160;
export const META_PANEL_BODY_THROTTLE_MS = 140;
export const STREAMING_MARKDOWN_MIN_INTERVAL_MS = 140;
export const STREAMING_MARKDOWN_MIN_CHARS = 60;
export const DEFERRED_MARKDOWN_TAIL_COUNT = 12;

export interface MetaPanelSignatureInput {
  label: string;
  textSignature: string;
  sections?: Array<{
    label?: string;
    textSignature: string;
    sourceCount: number;
  }>;
  sources?: Array<{
    title: string;
    url?: string;
  }>;
}

/**
 * 面板正文的轻量内容签名。
 *
 * 流式阶段只比较长度和尾部字符（文本只追加，O(48)）；终态比较全文哈希，
 * 这样同长度的版本切换也能被识别，不必每帧扫描整段推理。
 */
export function buildMetaPanelTextSignature(text: string | undefined, streaming: boolean): string {
  const value = text ?? "";
  if (!streaming) {
    return `${value.length}:${hashText(value)}`;
  }
  return `${value.length}:${value.slice(-48)}`;
}

/** 只比较会影响面板显示的内容，不比较 DOM 结构。 */
export function buildMetaPanelSignature(panel: MetaPanelSignatureInput): string {
  const sectionPart = (panel.sections ?? [])
    .map((section) => `${section.label ?? ""}:${section.textSignature}:${section.sourceCount}`)
    .join("|");
  const sourcePart = (panel.sources ?? [])
    .map((source) => `${source.title}:${source.url ?? ""}`)
    .join("|");
  return `${panel.label}:${panel.textSignature}:${sectionPart}:${sourcePart}`;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function shouldUpdateMetaPanelPreview(input: {
  signatureChanged: boolean;
  elapsedMs: number;
  streaming: boolean;
}): boolean {
  if (!input.signatureChanged) {
    return false;
  }
  if (!input.streaming) {
    return true;
  }
  return input.elapsedMs >= META_PANEL_PREVIEW_THROTTLE_MS;
}

export function shouldRenderMetaPanelBody(input: {
  signatureChanged: boolean;
  open: boolean;
  elapsedMs: number;
  streaming: boolean;
}): boolean {
  if (!input.signatureChanged || !input.open) {
    return false;
  }
  if (!input.streaming) {
    return true;
  }
  return input.elapsedMs >= META_PANEL_BODY_THROTTLE_MS;
}

/**
 * 流式 Markdown 只在可见或仍贴底时刷新；单次增长达到 60 字立即追帧，
 * 否则最多 140ms 刷新一次，避免每帧全量重渲染。
 */
export function shouldFlushStreamingMarkdown(input: {
  charsSinceLastFlush: number;
  elapsedMs: number;
  visible: boolean;
  pinnedToBottom: boolean;
}): boolean {
  if (!input.visible && !input.pinnedToBottom) {
    return false;
  }
  return input.charsSinceLastFlush >= STREAMING_MARKDOWN_MIN_CHARS
    || input.elapsedMs >= STREAMING_MARKDOWN_MIN_INTERVAL_MS;
}

export function isElementVerticallyVisible(input: {
  itemTop: number;
  itemBottom: number;
  hostTop: number;
  hostBottom: number;
}): boolean {
  return input.itemBottom >= input.hostTop && input.itemTop <= input.hostBottom;
}

/**
 * 打开会话时只立即渲染最后 N 条消息的 Markdown，其余先保留纯文本占位，
 * 由视口观察器按需水合。定位请求会强制全部水合。
 */
export function shouldDeferMessageMarkdown(input: {
  messageIndex: number;
  messageCount: number;
  tailCount?: number;
  forceHydrateAll: boolean;
}): boolean {
  if (input.forceHydrateAll) {
    return false;
  }
  const tailCount = Math.max(0, input.tailCount ?? DEFERRED_MARKDOWN_TAIL_COUNT);
  return input.messageCount - input.messageIndex > tailCount;
}
