/**
 * 弹框「未保存就关」的关闭守卫（2026-11-27 按 Resojot 共享件移植）。
 *
 * 判断顺序：
 * 1. 刚保存成功 → 放行，不再问；
 * 2. 保存 / 提交在途 → 直接关闭（沿用「关闭＝放弃本次保存」语义）；
 * 3. 内容与打开时一致 → 直接关闭，不打扰；
 * 4. 否则问一次：确认放弃就关，取消就留在原地。
 *
 * 不依赖 obsidian：提示文案与确认框由调用方注入，便于行为测试。
 */
export type ModalCloseOutcome = "closed" | "cancelled" | "blocked";

interface ModalCloseGuardOptions {
  /** 当前内容是否与打开时不同。 */
  isDirty: () => boolean;
  /** 正在保存 / 提交：关闭直接算放弃本次保存，不弹提示。 */
  isBusy?: () => boolean;
  /** 问用户「要不要放弃」，返回是否确认放弃。 */
  confirmDiscard: () => Promise<boolean>;
  /** 真正关闭（调用方传自己的 super.close()）。 */
  close: () => void;
}

export class ModalCloseGuard {
  private prompting = false;
  private allowNext = false;

  constructor(private readonly options: ModalCloseGuardOptions) {}

  /** 保存成功路径：下一次关闭不再询问。 */
  allowNextClose(): void {
    this.allowNext = true;
  }

  async requestClose(): Promise<ModalCloseOutcome> {
    if (this.allowNext) {
      this.allowNext = false;
      this.options.close();
      return "closed";
    }
    if (this.options.isBusy?.()) {
      this.options.close();
      return "closed";
    }
    if (!this.options.isDirty()) {
      this.options.close();
      return "closed";
    }
    if (this.prompting) {
      return "blocked";
    }
    this.prompting = true;
    let confirmed = false;
    try {
      confirmed = await this.options.confirmDiscard();
    } finally {
      this.prompting = false;
    }
    if (!confirmed) {
      return "cancelled";
    }
    this.options.close();
    return "closed";
  }
}
