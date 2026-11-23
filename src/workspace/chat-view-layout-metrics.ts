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

export function shouldShowScrollBottomButton(
  hasConversationMessages: boolean,
  scrollPinnedToBottom: boolean
): boolean {
  return hasConversationMessages && !scrollPinnedToBottom;
}
