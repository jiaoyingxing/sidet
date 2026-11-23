import { App, FuzzySuggestModal, getIconIds, setIcon, type FuzzyMatch } from "obsidian";
import { getRegisteredCommands, type RegisteredCommandInfo } from "../commands/command-registry";
import { compareHomeCommandOptions, isHomeLauncherCommand } from "./home-command-rules";

type CommandOption = RegisteredCommandInfo;

interface HomeCommandPickerModalOptions {
  placeholder?: string;
  emptyStateText?: string;
}

interface IconOption {
  id: string;
  label: string;
  isClear?: boolean;
}

export class HomeCommandPickerModal extends FuzzySuggestModal<CommandOption> {
  constructor(
    app: App,
    private readonly excludedCommandIds: Set<string>,
    private readonly onChoose: (command: CommandOption) => void | Promise<void>,
    options: HomeCommandPickerModalOptions = {}
  ) {
    super(app);
    this.setPlaceholder(options.placeholder ?? "搜索主页功能、插件名或 ID");
    this.emptyStateText = options.emptyStateText ?? "没有可添加的主页快捷方式";
    this.limit = 80;
  }

  override getItems(): CommandOption[] {
    return getRegisteredCommands(this.app)
      .filter((command) => !this.excludedCommandIds.has(command.id))
      .filter(isHomeLauncherCommand)
      .sort(compareHomeCommandOptions);
  }

  override getItemText(item: CommandOption): string {
    return item.searchText;
  }

  override renderSuggestion(item: FuzzyMatch<CommandOption>, el: HTMLElement): void {
    const command = item.item;
    const row = el.createDiv({ cls: "sidet-command-picker-row" });
    const iconEl = row.createSpan({ cls: "sidet-command-picker-icon" });
    setIcon(iconEl, command.icon);
    const textEl = row.createDiv({ cls: "sidet-command-picker-text" });
    const headingEl = textEl.createDiv({ cls: "sidet-command-picker-heading" });
    headingEl.createSpan({ cls: "sidet-command-picker-name", text: command.name });
    headingEl.createSpan({
      cls: `sidet-command-picker-source is-${command.source.type}`,
      text: command.source.label
    });
    textEl.createDiv({ cls: "sidet-command-picker-id", text: command.id });
  }

  override onChooseItem(item: CommandOption): void {
    void this.onChoose(item);
  }
}

export class HomeIconPickerModal extends FuzzySuggestModal<IconOption> {
  private readonly icons: IconOption[];

  constructor(
    app: App,
    private readonly onChoose: (iconId: string) => void | Promise<void>
  ) {
    super(app);
    this.icons = [
      {
        id: "",
        label: "使用命令自带图标",
        isClear: true
      },
      ...getIconIds()
        .map((id) => ({
          id,
          label: id
        }))
        .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }))
    ];
    this.setPlaceholder("搜索 Obsidian 图标");
    this.emptyStateText = "没有匹配的图标";
    this.limit = 80;
  }

  override getItems(): IconOption[] {
    return this.icons;
  }

  override getItemText(item: IconOption): string {
    return item.label;
  }

  override renderSuggestion(item: FuzzyMatch<IconOption>, el: HTMLElement): void {
    const icon = item.item;
    const row = el.createDiv({ cls: "sidet-icon-picker-row" });
    const iconEl = row.createSpan({ cls: "sidet-icon-picker-icon" });
    if (icon.isClear) {
      setIcon(iconEl, "rotate-ccw");
    } else {
      setIcon(iconEl, icon.id);
    }
    row.createSpan({ cls: "sidet-icon-picker-label", text: icon.label });
  }

  override onChooseItem(item: IconOption): void {
    void this.onChoose(item.id);
  }
}
