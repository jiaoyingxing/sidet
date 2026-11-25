export const MOBILE_SCROLL_MOMENTUM_HALT_CLASS =
  "is-mobile-scroll-momentum-halted";

/**
 * 手机 WebView 的原生惯性不会因为设置 `scrollTop` 而停下；用户点“回到底部”
 * 后，残留动量仍会把内容带离底部。
 *
 * 先把滚动容器停一帧让 WebView 提交“不可滚动”并丢掉动量，再恢复布局执行
 * 跳转：停滚动期间滚动条消失可能改变内容高度，跳转目标必须在恢复后的布局
 * 上计算，否则会停在离底部差一截的位置。
 */
export function haltMobileScrollMomentum(
  scrollHost: HTMLElement,
  run: () => void
): void {
  const alreadyHalted = scrollHost.classList.contains(
    MOBILE_SCROLL_MOMENTUM_HALT_CLASS
  );
  scrollHost.classList.add(MOBILE_SCROLL_MOMENTUM_HALT_CLASS);
  // 同步读一次布局，确保“不可滚动”状态在下一帧绘制前被提交。
  void scrollHost.scrollHeight;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!alreadyHalted) {
        scrollHost.classList.remove(MOBILE_SCROLL_MOMENTUM_HALT_CLASS);
      }
      run();
    });
  });
}
