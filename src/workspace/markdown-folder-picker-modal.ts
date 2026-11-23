import { App, FuzzySuggestModal, Platform, TFolder } from "obsidian";

interface MarkdownFolderPickerOptions {
  placeholder?: string;
  includeRoot?: boolean;
}

export class MarkdownFolderPickerModal extends FuzzySuggestModal<TFolder> {
  private readonly folders: TFolder[];
  private didChoose = false;

  constructor(
    app: App,
    private readonly onChoose: (folder: TFolder) => void,
    private readonly onCancel?: () => void,
    options: MarkdownFolderPickerOptions = {}
  ) {
    super(app);
    this.setPlaceholder(options.placeholder ?? "搜索要引用的文件夹");
    this.containerEl.addClass("sidet-markdown-context-picker-container");
    this.modalEl.addClass("sidet-markdown-context-picker-modal");
    if (Platform.isMobile || Platform.isPhone) {
      this.containerEl.addClass("is-sidet-mobile-picker");
      this.modalEl.addClass("is-sidet-mobile-picker");
    }
    this.folders = app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && (options.includeRoot || !isVaultRootFolder(file)))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(folder: TFolder): string {
    return isVaultRootFolder(folder)
      ? `${folder.name || "当前笔记库"}（笔记库根目录）`
      : folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.didChoose = true;
    this.onChoose(folder);
  }

  override onClose(): void {
    if (!this.didChoose) {
      this.onCancel?.();
    }
  }
}

function isVaultRootFolder(folder: TFolder): boolean {
  return folder.path.trim() === "/" || folder.path.trim() === "";
}
