export interface LayoutRect {
  left: number;
  right: number;
  top: number;
  width: number;
  height: number;
}

export interface HomeComposerInlineMetrics {
  left: string;
  right: string;
}

export interface HomeComposerSlotMetrics {
  top: string;
  left: string;
  width: string;
}

export function resolveHomeComposerInline(
  homeRect: LayoutRect,
  contentRect: LayoutRect
): HomeComposerInlineMetrics {
  return {
    left: `${Math.round(homeRect.left - contentRect.left)}px`,
    right: `${Math.round(Math.max(0, contentRect.right - homeRect.right))}px`
  };
}

export function resolveHomeComposerSlot(
  slotRect: LayoutRect,
  rootRect: LayoutRect,
  scrollTop: number
): HomeComposerSlotMetrics {
  return {
    top: `${Math.round(slotRect.top - rootRect.top + scrollTop)}px`,
    left: `${Math.round(slotRect.left - rootRect.left)}px`,
    width: `${Math.round(slotRect.width)}px`
  };
}

export function resolveHomeComposerSlotHeight(
  composerRect: Pick<LayoutRect, "height">
): string {
  return `${Math.ceil(composerRect.height)}px`;
}

export function resolveScrollBottomTarget(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/** 消息定位：把视口坐标系里的消息顶边换算成滚动容器的 scrollTop，并留出呼吸距离。 */
export function computeMessageRevealScrollTop(input: {
  hostScrollTop: number;
  hostTop: number;
  itemTop: number;
  padding?: number;
}): number {
  const padding = input.padding ?? 12;
  return Math.max(0, input.hostScrollTop + input.itemTop - input.hostTop - padding);
}

/**
 * 移动输入框悬在宿主底栏上方，底部留白要同时覆盖输入框高度和它到滚动内容
 * 底缘的位移；只按高度计算会让最后一行压在输入框下面。
 */
export function resolveMobileComposerReservedSpace(input: {
  scrollContentBottom: number;
  composerTop: number;
  gap: number;
}): number {
  const overlap = input.scrollContentBottom - input.composerTop;
  return Math.max(0, Math.round(overlap) + input.gap);
}

export function shouldShowScrollBottomButton(
  hasConversationMessages: boolean,
  scrollPinnedToBottom: boolean
): boolean {
  return hasConversationMessages && !scrollPinnedToBottom;
}
