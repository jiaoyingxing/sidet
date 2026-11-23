export interface DeferredSettingInputComponent {
  inputEl: HTMLInputElement | HTMLTextAreaElement;
  onChange(callback: (value: string) => void): DeferredSettingInputComponent;
}

export function disableTextAssistance(inputEl: HTMLInputElement | HTMLTextAreaElement): void {
  inputEl.spellcheck = false;
  inputEl.autocomplete = "off";
  inputEl.setAttr("autocapitalize", "off");
  inputEl.setAttr("autocorrect", "off");
}

export function hardenSensitiveField(inputEl: HTMLInputElement | HTMLTextAreaElement): void {
  disableTextAssistance(inputEl);
  inputEl.setAttr("data-lpignore", "true");
  inputEl.setAttr("data-1p-ignore", "true");

  if (inputEl instanceof HTMLInputElement) {
    inputEl.type = "password";
  } else {
    inputEl.addClass("sidet-sensitive-textarea");
  }
}

export function bindDeferredSettingInput(
  component: DeferredSettingInputComponent,
  onCommit: (value: string) => void | Promise<void>,
  options: { delayMs?: number } = {}
): void {
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 360));
  let timerId: number | null = null;
  let isFlushing = false;
  let lastCommittedValue = component.inputEl.value;
  let pendingValue = lastCommittedValue;

  const clearTimer = (): void => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  const scheduleFlush = (): void => {
    clearTimer();
    timerId = window.setTimeout(() => {
      void flush();
    }, delayMs);
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    if (isFlushing || pendingValue === lastCommittedValue) {
      return;
    }

    const valueToCommit = pendingValue;
    isFlushing = true;
    try {
      await onCommit(valueToCommit);
      lastCommittedValue = valueToCommit;
    } finally {
      isFlushing = false;
      if (pendingValue !== lastCommittedValue) {
        scheduleFlush();
      }
    }
  };

  component.onChange((value) => {
    pendingValue = value;
    if (pendingValue === lastCommittedValue) {
      clearTimer();
      return;
    }
    scheduleFlush();
  });

  component.inputEl.addEventListener("blur", () => {
    void flush();
  });
}
