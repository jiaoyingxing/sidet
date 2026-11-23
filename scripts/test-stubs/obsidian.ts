export class App {}

export class Modal {
  containerEl = {
    addClass: () => undefined
  };
  modalEl = {
    addClass: () => undefined
  };
  contentEl = {
    empty: () => undefined,
    addClass: () => undefined,
    createEl: () => ({
      addEventListener: () => undefined,
      setAttr: () => undefined
    }),
    createDiv: () => ({
      addClass: () => undefined,
      createDiv: () => ({
        addClass: () => undefined,
        createDiv: () => undefined,
        createEl: () => ({
          addEventListener: () => undefined,
          setAttr: () => undefined
        })
      }),
      createEl: () => ({
        addEventListener: () => undefined,
        setAttr: () => undefined
      })
    })
  };

  constructor(public readonly app: App) {}

  open(): void {
    // no-op for logic tests
  }

  close(): void {
    // no-op for logic tests
  }
}

export class Component {
  unload(): void {
    // no-op for logic tests
  }
}

export class Notice {
  constructor(
    public readonly message: string,
    public readonly timeout?: number
  ) {}
}

export class TFile {}
export class TFolder {}
export class WorkspaceLeaf {}
export class WorkspaceSidedock {}

export const Platform = {
  isMobile: false
};

export const MarkdownRenderer = {
  async render(
    _app: App,
    markdown: string,
    el: { setText?: (text: string) => void; textContent?: string | null },
    _sourcePath: string,
    _component: Component
  ): Promise<void> {
    if (typeof el.setText === "function") {
      el.setText(markdown);
      return;
    }
    el.textContent = markdown;
  }
};

export function setIcon(): void {
  // no-op for logic tests
}

export function setTooltip(): void {
  // no-op for logic tests
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export async function requestUrl(): Promise<never> {
  throw new Error("requestUrl is not available in test stub");
}
