/**
 * 软键盘避让的滚动几何（纯计算，零依赖，可直接单测）。
 *
 * 2026-11-27 按 Resojot 同件移植。唯一踩过的坑：锚的 `top` 必须等于**内容真实
 * 底边**；若写成「内容底边 − 本次余量」，锚底边恰好落回内容底边，滚动范围
 * 一毫米不增。因此本件接收原始读数（`scrollHeight` 与上一次已应用的锚高），
 * 内容底边由这里反算——调用点拿不到「底边」这个中间量，就没有再算错的机会。
 *
 * 本件只回答一个问题：想让 `targetScrollTop` 可达，锚要挂在哪、要补多高、
 * 最终停在哪个滚动位置。DOM 读写、键盘信号与呼吸位在 `keyboard-inset.ts`。
 */
interface KeyboardInsetGeometryInput {
  /** 滚动段当前 `scrollHeight` 实测值。**已含**上一次写入的锚（未挂锚时为内容高）。 */
  scrollHeight: number;
  /** 上一次已应用到样式上的锚高（px）；从未挂过锚时为 0。 */
  appliedInset: number;
  /** 滚动段可视高度（`clientHeight`）。 */
  clientHeight: number;
  /** 希望滚到的目标位置（px）。 */
  targetScrollTop: number;
  /**
   * 键盘正在收起 / 失焦回收：把目标压回自然可滚上限，让锚归零、滚动退回自然区。
   * 必须由这里判断，不能让调用点自己拿「自然上限」去比较。
   */
  reclaim?: boolean;
}

export interface KeyboardInsetGeometry {
  /** 内容真实底边（px）＝锚该挂的位置。**不能**再减去 `inset`。 */
  contentBottom: number;
  /** 锚的 `top`（px）＝内容真实底边，直接写进 `--sidet-keyboard-anchor-top`。 */
  anchorTop: number;
  /** 锚高（px）＝本次需要补出的额外可滚范围。 */
  inset: number;
  /** 写入后的滚动位置（不会超过新可滚上限）。 */
  scrollTop: number;
}

export function planKeyboardInset(
  input: KeyboardInsetGeometryInput
): KeyboardInsetGeometry {
  // `scrollHeight` 含**上一次**的锚，减掉它才是内容底边——与锚高同沿的精确逆运算，
  // 内容是否溢出都成立。绝不能用本次新算出的余量来减（那会把自己抵消掉）。
  const contentBottom = Math.max(
    0,
    Math.max(0, input.scrollHeight) - Math.max(0, input.appliedInset)
  );
  // 不挂锚时的自然可滚上限：锚补的是超出它的那段，不超前补。
  const nativeMaxScroll = Math.max(
    0,
    contentBottom - Math.max(0, input.clientHeight)
  );
  const target = Math.max(0, input.targetScrollTop);
  // 收起 / 失焦回收：目标压回自然上限，于是 inset 归 0，锚与滚动一起退回自然区。
  const requested = input.reclaim ? Math.min(target, nativeMaxScroll) : target;
  const inset = Math.max(0, Math.ceil(requested - nativeMaxScroll));
  // 挂锚后的新上限：native + inset，目标落在这里面，写入后一次到位。
  const maxScroll = nativeMaxScroll + inset;
  return {
    contentBottom,
    anchorTop: contentBottom,
    inset,
    scrollTop: Math.min(requested, maxScroll)
  };
}
