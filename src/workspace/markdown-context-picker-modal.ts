import { App, FuzzySuggestModal, Platform, TFile } from "obsidian";

export class MarkdownContextPickerModal extends FuzzySuggestModal<TFile> {
  private readonly files: TFile[];
  private didChoose = false;

  constructor(
    app: App,
    private readonly onChoose: (file: TFile) => void,
    private readonly onCancel?: () => void,
    placeholder = "搜索要引用的 Markdown 笔记"
  ) {
    super(app);
    this.setPlaceholder(placeholder);
    this.containerEl.addClass("sidet-markdown-context-picker-container");
    this.modalEl.addClass("sidet-markdown-context-picker-modal");
    if (Platform.isMobile || Platform.isPhone) {
      this.containerEl.addClass("is-sidet-mobile-picker");
      this.modalEl.addClass("is-sidet-mobile-picker");
    }
    this.files = app.vault.getMarkdownFiles().sort((left, right) => left.path.localeCompare(right.path));
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.didChoose = true;
    this.onChoose(file);
  }

  override onClose(): void {
    if (!this.didChoose) {
      this.onCancel?.();
    }
  }
}
