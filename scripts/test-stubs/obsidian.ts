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

/** 测试桩：只提供链式配置与可点击按钮元素，不模拟宿主样式。 */
export class ButtonComponent {
  buttonEl = {
    addEventListener: () => undefined,
    setAttr: () => undefined,
    disabled: false,
    addClass: () => undefined,
    removeClass: () => undefined
  };

  setButtonText(_text: string): this {
    return this;
  }

  setClass(_cls: string): this {
    return this;
  }

  setCta(): this {
    return this;
  }

  setWarning(): this {
    return this;
  }

  setDisabled(_disabled: boolean): this {
    return this;
  }

  onClick(_callback: (event: MouseEvent) => unknown): this {
    return this;
  }
}

export class TFile {
  path = "";
  basename = "";
  extension = "";
  stat = {
    ctime: 0,
    mtime: 0,
    size: 0
  };
}
export class TFolder {}
export class WorkspaceLeaf {}
export class WorkspaceSidedock {}

export interface StubSearchResult {
  score: number;
  matches: Array<[number, number]>;
}

/**
 * 测试桩：按空格切词、全词大小写不敏感命中；只提供工具层所需的可预测语义。
 * 不模拟宿主 prepareSimpleSearch 的模糊匹配细节。
 */
export function prepareSimpleSearch(query: string): (text: string) => StubSearchResult | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (text: string) => {
    if (terms.length === 0) {
      return null;
    }
    const lower = text.toLowerCase();
    const matches: Array<[number, number]> = [];
    for (const term of terms) {
      let searchIndex = 0;
      let found = false;
      while (searchIndex <= lower.length) {
        const index = lower.indexOf(term, searchIndex);
        if (index < 0) {
          break;
        }
        matches.push([index, index + term.length]);
        searchIndex = index + term.length;
        found = true;
      }
      if (!found) {
        return null;
      }
    }
    matches.sort((left, right) => left[0] - right[0]);
    return {
      score: matches.length,
      matches
    };
  };
}

/**
 * 测试桩：内存 vault，只实现工具层读取所需的最小面。
 */
export class Vault {
  constructor(
    private readonly files: TFile[] = [],
    private readonly contents: Map<string, string> = new Map()
  ) {}

  getMarkdownFiles(): TFile[] {
    return this.files.filter((file) => file.extension === "md");
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.files.find((file) => file.path === path) ?? null;
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.contents.get(file.path) ?? "";
  }
}

/**
 * 测试桩：只提供 getFileCache / getFirstLinkpathDest / resolvedLinks。
 */
export class MetadataCache {
  resolvedLinks: Record<string, Record<string, number>> = {};

  constructor(
    private readonly caches: Map<string, unknown> = new Map(),
    private readonly resolveLink: (linkpath: string, sourcePath: string) => TFile | null = () => null
  ) {}

  getFileCache(file: TFile): unknown {
    return this.caches.get(file.path) ?? null;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    return this.resolveLink(linkpath, sourcePath);
  }
}

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
