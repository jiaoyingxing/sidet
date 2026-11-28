import type { MessageRecord } from "../types";

/** 进入视口外这段距离时提前挂载消息内容。 */
export const VIRTUAL_WINDOW_MOUNT_OVERSCAN_PX = 1200;
/** 离开视口超过这段距离后才卸载消息内容，避免边界反复挂载。 */
export const VIRTUAL_WINDOW_UNMOUNT_OVERSCAN_PX = 2600;
export const VIRTUAL_WINDOW_MIN_HEIGHT_PX = 24;
export const VIRTUAL_WINDOW_MAX_ESTIMATE_HEIGHT_PX = 3200;

export interface VirtualMessageRect {
  /** 消息在窗口列表中的顺序下标，用于返回挂载范围。 */
  index: number;
  top: number;
  bottom: number;
}

export interface VirtualMountRange {
  startIndex: number;
  endIndex: number;
}

/**
 * 取与视口（含 overscan）相交的消息下标范围。rects 必须按 index 升序；
 * 没有相交项时返回 null。
 */
export function resolveVirtualMountRange(input: {
  rects: readonly VirtualMessageRect[];
  viewportTop: number;
  viewportBottom: number;
  overscanPx?: number;
}): VirtualMountRange | null {
  const overscanPx = input.overscanPx ?? VIRTUAL_WINDOW_MOUNT_OVERSCAN_PX;
  const top = input.viewportTop - overscanPx;
  const bottom = input.viewportBottom + overscanPx;
  let startIndex = -1;
  let endIndex = -1;
  for (const rect of input.rects) {
    if (rect.bottom < top || rect.top > bottom) {
      continue;
    }
    if (startIndex < 0) {
      startIndex = rect.index;
    }
    endIndex = rect.index;
  }
  return startIndex < 0 ? null : { startIndex, endIndex };
}

/** 消息完全离开视口（含卸载 overscan）后才允许卸载。 */
export function shouldUnmountVirtualItem(input: {
  rect: VirtualMessageRect;
  viewportTop: number;
  viewportBottom: number;
  overscanPx?: number;
}): boolean {
  const overscanPx = input.overscanPx ?? VIRTUAL_WINDOW_UNMOUNT_OVERSCAN_PX;
  return (
    input.rect.bottom < input.viewportTop - overscanPx
    || input.rect.top > input.viewportBottom + overscanPx
  );
}

/**
 * 消息壳还没有真实高度时的保守估计：宁可略高，避免向上滚动时列表被
 * 大幅撑高。真实高度在消息卸载时写回缓存。
 */
export function estimateVirtualMessageHeight(
  message: Pick<
    MessageRecord,
    "role" | "text" | "status" | "attachments" | "metaPanels" | "sources"
  >
): number {
  const textLength = message.text?.length ?? 0;
  const attachmentHeight = (message.attachments?.length ?? 0) * 72;
  if (message.role === "user") {
    // 用户气泡在桌面和手机上都按字符折行；显式换行也计入字符数，
    // 用字符斜率比“固定行高 × 行数”更接近实际高度。
    return clampEstimateHeight(30 + textLength * 1.33 + attachmentHeight);
  }
  if (message.status === "streaming" && textLength === 0) {
    return 48;
  }
  const metaPanelHeight = (message.metaPanels?.length ?? 0) * 34;
  const sourceFooterHeight = (message.sources?.length ?? 0) > 0 ? 30 : 0;
  return clampEstimateHeight(
    118
    + textLength * 0.98
    + metaPanelHeight
    + sourceFooterHeight
    + attachmentHeight
  );
}

/**
 * 高度缓存失效签名。长度变化、版本切换、状态或附件变化都会换签名；
 * 只比较内容形状，不在每次渲染时读取全文哈希。
 */
export function buildVirtualMessageHeightSignature(
  message: Pick<
    MessageRecord,
    | "text"
    | "status"
    | "reasoningText"
    | "metaPanels"
    | "sources"
    | "attachments"
    | "activeAnswerVariantIndex"
    | "answerVariants"
    | "errorText"
  >
): string {
  const metaPanelTotal = message.metaPanels?.reduce((total, panel) => {
    return total + (panel.text?.length ?? 0) + (panel.sources?.length ?? 0);
  }, 0) ?? 0;
  return [
    message.status,
    message.text.length,
    message.reasoningText?.length ?? 0,
    metaPanelTotal,
    message.sources?.length ?? 0,
    message.attachments?.length ?? 0,
    message.activeAnswerVariantIndex ?? 0,
    message.answerVariants?.length ?? 0,
    message.errorText?.length ?? 0
  ].join("~");
}

function clampEstimateHeight(height: number): number {
  return Math.min(
    VIRTUAL_WINDOW_MAX_ESTIMATE_HEIGHT_PX,
    Math.max(VIRTUAL_WINDOW_MIN_HEIGHT_PX, Math.round(height))
  );
}
