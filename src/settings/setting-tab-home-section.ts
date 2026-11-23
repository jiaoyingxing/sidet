import { App, ButtonComponent, Modal, Notice, Setting, SettingGroup, setIcon, setTooltip } from "obsidian";
import {
  HOME_PINNED_COMMAND_LIMIT,
  SIDET_OPEN_CHAT_ACTION,
  SIDET_URL_LAUNCH_ACTION,
  URL_LAUNCHER_LIMIT
} from "../constants";
import { resolveRegisteredCommand, type RegisteredCommandInfo } from "../commands/command-registry";
import type SidetPlugin from "../main";
import type { HomePinnedCommandSetting, UrlLauncherSetting } from "../types";
import { HomePinnedCommandDragRuntime } from "./setting-tab-home-drag-runtime";
import { HomeCommandPickerModal, HomeIconPickerModal } from "./setting-tab-home-picker-modals";
import { normalizeHomePinnedCommands, normalizeUrlLaunchers } from "./model";

type CommandOption = RegisteredCommandInfo;

interface BuiltInUrlLauncher {
  id: "open-chat" | "clipboard-import";
  name: string;
  icon: string;
  clipboard: boolean;
}

const BUILT_IN_URL_LAUNCHERS: readonly BuiltInUrlLauncher[] = [
  {
    id: "open-chat",
    name: "打开新对话",
    icon: "message-circle-plus",
    clipboard: false
  },
  {
    id: "clipboard-import",
    name: "导入剪贴板",
    icon: "clipboard-paste",
    clipboard: true
  }
];

class DeleteSettingItemConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly description: string,
    private readonly onConfirm: () => Promise<void>
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: this.message
    });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: this.description
    });

    const actions = new Setting(this.contentEl);
    actions.setClass("sidet-model-config-actions-setting");
    actions.infoEl.remove();

    new ButtonComponent(actions.controlEl)
      .setButtonText("取消")
      .onClick(() => {
        this.close();
      });

    new ButtonComponent(actions.controlEl)
      .setWarning()
      .setButtonText("删除")
      .onClick(() => {
        void this.confirm();
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private async confirm(): Promise<void> {
    await this.onConfirm();
    this.close();
  }
}

export class HomePinnedCommandsSection {
  private homeCommandSetting: Setting | null = null;
  private homeCommandAddButton: ButtonComponent | null = null;
  private homeCommandListEl: HTMLElement | null = null;
  private urlLauncherSetting: Setting | null = null;
  private urlLauncherAddButton: ButtonComponent | null = null;
  private urlLauncherListEl: HTMLElement | null = null;
  private readonly dragRuntime: HomePinnedCommandDragRuntime;

  constructor(
    private readonly app: App,
    private readonly plugin: SidetPlugin,
    private readonly requestDisplay: () => void
  ) {
    this.dragRuntime = new HomePinnedCommandDragRuntime({
      canDrag: () => this.plugin.settings.homePinnedCommands.length > 1,
      onCommitOrder: async (rowsEl) => {
        await this.commitPinnedCommandDragOrder(rowsEl);
      }
    });
  }

  render(containerEl: HTMLElement): void {
    this.renderHomeGroup(containerEl);
    this.renderUrlLauncherGroup(containerEl);
  }

  private renderHomeGroup(containerEl: HTMLElement): void {
    const group = new SettingGroup(containerEl).setHeading("主页");
    group.addSetting((setting) => this.configureHomePinnedRow(setting));
  }

  /**
   * 主页行配置：display() 组路径与声明式子页「主页」页 render 回调共用（方案单 §四）。
   * 公开给 setting-tab 页定义复用；每次挂载重置行/列表句柄。
   */
  configureHomePinnedRow(setting: Setting): void {
    this.homeCommandSetting = setting;
    setting
      .setName("主页快捷方式")
      .setDesc(this.getHomePinnedCommandDescription())
      .setClass("sidet-settings-home-command-setting")
      .addButton((button) => {
        this.homeCommandAddButton = button;
        button
          .setCta()
          .onClick(() => {
            this.openHomeCommandPicker();
          });
        this.syncHomePinnedCommandAddButton();
      });

    const listEl = setting.settingEl.createDiv({ cls: "sidet-settings-home-command-list" });
    this.homeCommandListEl = listEl;
    this.renderHomePinnedCommandListContents(listEl);
  }

  private renderUrlLauncherGroup(containerEl: HTMLElement): void {
    const group = new SettingGroup(containerEl).setHeading("URL 启动");
    group.addSetting((setting) => this.configureUrlLauncherRow(setting));
  }

  /** URL 行配置（与上同理，两轨道共用）。 */
  configureUrlLauncherRow(setting: Setting): void {
    this.urlLauncherSetting = setting;
    setting
      .setName("URL 启动入口")
      .setDesc(this.getUrlLauncherDescription())
      .setClass("sidet-settings-home-command-setting")
      .addButton((button) => {
        this.urlLauncherAddButton = button;
        button
          .setCta()
          .onClick(() => {
            this.openUrlLauncherCommandPicker();
          });
        this.syncUrlLauncherAddButton();
      });

    const listEl = setting.settingEl.createDiv({ cls: "sidet-settings-home-command-list" });
    this.urlLauncherListEl = listEl;
    this.renderUrlLauncherListContents(listEl);
  }

  /** 页入口 desc（声明式「主页」页 def 读取；页内行挂载后仍由 refresh 保持一致）。 */
  getHomePinnedCommandDescription(): string {
    return `已固定 ${this.plugin.settings.homePinnedCommands.length} / ${HOME_PINNED_COMMAND_LIMIT} 个。`;
  }

  private syncHomePinnedCommandAddButton(): void {
    if (!this.homeCommandAddButton) {
      return;
    }
    const isFull = this.plugin.settings.homePinnedCommands.length >= HOME_PINNED_COMMAND_LIMIT;
    this.homeCommandAddButton
      .setButtonText(isFull ? "已满" : "添加命令")
      .setDisabled(isFull);
  }

  /** 页入口 desc（声明式「URL 启动」页 def 读取）。 */
  getUrlLauncherDescription(): string {
    return `内置 2 条；已设置 ${this.plugin.settings.urlLaunchers.length} / ${URL_LAUNCHER_LIMIT} 条自定义入口。`;
  }

  private syncUrlLauncherAddButton(): void {
    if (!this.urlLauncherAddButton) {
      return;
    }
    const isFull = this.plugin.settings.urlLaunchers.length >= URL_LAUNCHER_LIMIT;
    this.urlLauncherAddButton
      .setButtonText(isFull ? "已满" : "添加链接")
      .setDisabled(isFull);
  }

  private refreshHomePinnedCommandSection(): void {
    if (!this.homeCommandSetting || !this.homeCommandListEl) {
      this.requestDisplay();
      return;
    }
    this.homeCommandSetting.descEl.setText(this.getHomePinnedCommandDescription());
    this.syncHomePinnedCommandAddButton();
    this.renderHomePinnedCommandListContents(this.homeCommandListEl);
  }

  private refreshUrlLauncherSection(): void {
    if (!this.urlLauncherSetting || !this.urlLauncherListEl) {
      this.requestDisplay();
      return;
    }
    this.urlLauncherSetting.descEl.setText(this.getUrlLauncherDescription());
    this.syncUrlLauncherAddButton();
    this.renderUrlLauncherListContents(this.urlLauncherListEl);
  }

  private renderHomePinnedCommandListContents(listEl: HTMLElement): void {
    const commands = this.plugin.settings.homePinnedCommands;
    listEl.empty();
    if (commands.length === 0) {
      listEl.createDiv({
        cls: "sidet-settings-home-command-empty",
        text: "暂无固定快捷方式。"
      });
      return;
    }

    const rowsEl = listEl.createDiv({ cls: "sidet-settings-home-command-rows" });
    for (const [index, command] of commands.entries()) {
      this.renderPinnedCommandRow(rowsEl, command, index);
    }
  }

  private renderPinnedCommandRow(
    parent: HTMLElement,
    command: HomePinnedCommandSetting,
    index: number
  ): void {
    const commandInfo = this.resolveCommandOption(command.commandId);
    const iconId = command.iconOverride || commandInfo?.icon || "command";
    const rowEl = parent.createDiv({
      cls: `sidet-settings-home-command-row${commandInfo ? "" : " is-missing"}`
    });
    rowEl.dataset.commandId = command.commandId;
    rowEl.dataset.index = String(index);

    const dragHandleEl = rowEl.createEl("button", {
      cls: "clickable-icon sidet-settings-home-command-drag-handle",
      attr: {
        type: "button",
        "aria-label": "拖动排序"
      }
    });
    setIcon(dragHandleEl, "grip-vertical");
    setTooltip(dragHandleEl, "按住拖动排序");
    this.dragRuntime.bindHandle(dragHandleEl, rowEl, parent);

    const identityEl = rowEl.createDiv({ cls: "sidet-settings-home-command-identity" });
    const iconEl = identityEl.createEl("button", {
      cls: "sidet-settings-home-command-icon sidet-settings-home-command-icon-button",
      attr: {
        type: "button",
        "aria-label": "选择图标"
      }
    });
    setIcon(iconEl, iconId);
    setTooltip(iconEl, "选择图标");
    iconEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openIconPicker(command.commandId);
    });
    const textEl = identityEl.createDiv({ cls: "sidet-settings-home-command-text" });
    textEl.createDiv({
      cls: "sidet-settings-home-command-name",
      text: commandInfo?.name ?? command.commandId
    });
    textEl.createDiv({
      cls: `sidet-settings-home-command-meta${commandInfo ? "" : " is-missing"}`,
      text: commandInfo ? `${commandInfo.source.label} · ${command.commandId}` : `命令不可用 · ${command.commandId}`
    });

    const actionsEl = rowEl.createDiv({ cls: "sidet-settings-home-command-actions" });
    this.createLightIconButton(actionsEl, "image", "选择图标", () => {
      this.openIconPicker(command.commandId);
    });
    this.createLightIconButton(actionsEl, "trash-2", "移除", () => {
      this.openRemovePinnedCommandConfirm(command.commandId);
    }, "is-danger");
  }

  private renderUrlLauncherListContents(listEl: HTMLElement): void {
    const launchers = this.plugin.settings.urlLaunchers;
    listEl.empty();

    const rowsEl = listEl.createDiv({ cls: "sidet-settings-home-command-rows" });
    for (const launcher of BUILT_IN_URL_LAUNCHERS) {
      this.renderBuiltInUrlLauncherRow(rowsEl, launcher);
    }
    for (const launcher of launchers) {
      this.renderUrlLauncherRow(rowsEl, launcher);
    }
  }

  private renderBuiltInUrlLauncherRow(
    parent: HTMLElement,
    launcher: BuiltInUrlLauncher
  ): void {
    const href = this.buildBuiltInUrlLauncherHref(launcher);
    const rowEl = parent.createDiv({
      cls: "sidet-settings-home-command-row sidet-settings-home-url-row is-builtin"
    });
    rowEl.dataset.builtinLauncherId = launcher.id;

    const identityEl = rowEl.createDiv({ cls: "sidet-settings-home-command-identity" });
    const iconEl = identityEl.createDiv({ cls: "sidet-settings-home-command-icon" });
    setIcon(iconEl, launcher.icon);

    const textEl = identityEl.createDiv({ cls: "sidet-settings-home-command-text" });
    textEl.createDiv({
      cls: "sidet-settings-home-command-name",
      text: launcher.name
    });
    textEl.createDiv({
      cls: "sidet-settings-home-command-meta",
      text: `默认链接 · ${href}`
    });

    const actionsEl = rowEl.createDiv({ cls: "sidet-settings-home-command-actions" });
    this.createLightIconButton(actionsEl, "link", "复制链接", () => {
      void this.copyTextToClipboard(href);
    });
  }

  private renderUrlLauncherRow(parent: HTMLElement, launcher: UrlLauncherSetting): void {
    const commandInfo = this.resolveCommandOption(launcher.commandId);
    const iconId = commandInfo?.icon || "command";
    const rowEl = parent.createDiv({
      cls: `sidet-settings-home-command-row sidet-settings-home-url-row${commandInfo ? "" : " is-missing"}`
    });
    rowEl.dataset.commandId = launcher.commandId;
    rowEl.dataset.slot = String(launcher.slot);

    const identityEl = rowEl.createDiv({ cls: "sidet-settings-home-command-identity" });
    const iconEl = identityEl.createDiv({ cls: "sidet-settings-home-command-icon" });
    setIcon(iconEl, iconId);

    const textEl = identityEl.createDiv({ cls: "sidet-settings-home-command-text" });
    textEl.createDiv({
      cls: "sidet-settings-home-command-name",
      text: commandInfo?.name ?? launcher.commandId
    });
    textEl.createDiv({
      cls: `sidet-settings-home-command-meta${commandInfo ? "" : " is-missing"}`,
      text: commandInfo
        ? this.buildUrlLauncherHref(launcher.slot)
        : `命令不可用 · ${this.buildUrlLauncherHref(launcher.slot)}`
    });

    const actionsEl = rowEl.createDiv({ cls: "sidet-settings-home-command-actions" });
    this.createLightIconButton(actionsEl, "link", "复制链接", () => {
      void this.copyTextToClipboard(this.buildUrlLauncherHref(launcher.slot));
    });
    this.createLightIconButton(actionsEl, "trash-2", "移除", () => {
      this.openRemoveUrlLauncherConfirm(launcher);
    }, "is-danger");
  }

  private createLightIconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
    extraClass = ""
  ): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: `clickable-icon sidet-settings-home-command-action${extraClass ? ` ${extraClass}` : ""}`,
      attr: {
        type: "button",
        "aria-label": label
      }
    });
    setIcon(button, icon);
    setTooltip(button, label);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  private openHomeCommandPicker(): void {
    if (this.plugin.settings.homePinnedCommands.length >= HOME_PINNED_COMMAND_LIMIT) {
      new Notice("主页快捷方式最多只能固定 8 个。", 2600);
      return;
    }

    new HomeCommandPickerModal(this.app, new Set(this.plugin.settings.homePinnedCommands.map((command) => command.commandId)), async (command) => {
      await this.addPinnedCommand(command.id);
    }).open();
  }

  private openUrlLauncherCommandPicker(): void {
    if (this.plugin.settings.urlLaunchers.length >= URL_LAUNCHER_LIMIT) {
      new Notice("URL 启动入口最多只能设置 8 条。", 2600);
      return;
    }

    new HomeCommandPickerModal(
      this.app,
      new Set(this.plugin.settings.urlLaunchers.map((item) => item.commandId)),
      async (command) => {
        await this.addUrlLauncher(command.id);
      },
      {
        placeholder: "搜索要绑定到 URL 的命令、插件名或 ID",
        emptyStateText: "没有可添加的 URL 启动命令"
      }
    ).open();
  }

  private async setPinnedCommands(
    commands: HomePinnedCommandSetting[],
    options: { rerender?: boolean; refreshSection?: boolean } = {}
  ): Promise<void> {
    this.plugin.settings.homePinnedCommands = normalizeHomePinnedCommands(commands);
    await this.plugin.savePluginSettings();
    if (options.rerender === false) {
      return;
    }
    if (options.refreshSection) {
      this.refreshHomePinnedCommandSection();
      return;
    }
    this.requestDisplay();
  }

  private async setUrlLaunchers(
    launchers: UrlLauncherSetting[],
    options: { refreshSection?: boolean } = {}
  ): Promise<void> {
    this.plugin.settings.urlLaunchers = normalizeUrlLaunchers(launchers);
    await this.plugin.savePluginSettings();
    if (options.refreshSection) {
      this.refreshUrlLauncherSection();
      return;
    }
    this.requestDisplay();
  }

  private resolveCommandOption(commandId: string): CommandOption | null {
    return resolveRegisteredCommand(this.app, commandId);
  }

  private getNextAvailableUrlLauncherSlot(): number | null {
    const usedSlots = new Set(this.plugin.settings.urlLaunchers.map((item) => item.slot));
    for (let slot = 1; slot <= URL_LAUNCHER_LIMIT; slot += 1) {
      if (!usedSlots.has(slot)) {
        return slot;
      }
    }
    return null;
  }

  private buildUrlLauncherHref(slot: number): string {
    const params = new URLSearchParams();
    params.set("vault", this.app.vault.getName());
    params.set("slot", String(slot));
    return `obsidian://${SIDET_URL_LAUNCH_ACTION}?${params.toString()}`;
  }

  private buildBuiltInUrlLauncherHref(launcher: BuiltInUrlLauncher): string {
    const params = new URLSearchParams();
    params.set("vault", this.app.vault.getName());
    if (launcher.clipboard) {
      params.set("clipboard", "1");
    }
    return `obsidian://${SIDET_OPEN_CHAT_ACTION}?${params.toString()}`;
  }

  private async copyTextToClipboard(text: string): Promise<void> {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        new Notice("已复制", 1200);
        return;
      }
    } catch (error) {
      console.warn("Sidet：设置页复制失败，尝试降级。", error);
    }

    const textareaEl = createEl("textarea");
    textareaEl.value = text;
    textareaEl.setAttribute("readonly", "true");
    textareaEl.setCssProps({
      position: "fixed",
      left: "-9999px",
      top: "0",
      opacity: "0"
    });
    document.body.appendChild(textareaEl);
    textareaEl.select();
    const copied = document.execCommand("copy");
    textareaEl.remove();

    if (!copied) {
      new Notice("复制失败", 1800);
      return;
    }
    new Notice("已复制", 1200);
  }

  private async updatePinnedCommand(
    commandId: string,
    nextCommand: HomePinnedCommandSetting,
    options: { rerender?: boolean } = {}
  ): Promise<void> {
    const nextCommands = [...this.plugin.settings.homePinnedCommands];
    const index = nextCommands.findIndex((command) => command.commandId === commandId);
    if (index < 0) {
      return;
    }
    nextCommands[index] = nextCommand;
    await this.setPinnedCommands(nextCommands, {
      rerender: options.rerender,
      refreshSection: options.rerender !== false
    });
    if (options.rerender === false) {
      return;
    }
  }

  private async removePinnedCommand(commandId: string): Promise<void> {
    await this.setPinnedCommands(
      this.plugin.settings.homePinnedCommands.filter((command) => command.commandId !== commandId),
      { refreshSection: true }
    );
  }

  private openRemovePinnedCommandConfirm(commandId: string): void {
    const commandInfo = this.resolveCommandOption(commandId);
    const commandName = commandInfo?.name ?? commandId;
    new DeleteSettingItemConfirmModal(
      this.app,
      "移除主页快捷方式",
      `确定移除“${commandName}”吗？`,
      "这只会把它从主页移除，不会影响 URL 启动入口里的同名命令。",
      async () => {
        await this.removePinnedCommand(commandId);
      }
    ).open();
  }

  private async addPinnedCommand(commandId: string): Promise<void> {
    if (this.plugin.settings.homePinnedCommands.some((command) => command.commandId === commandId)) {
      new Notice("这个命令已经固定到主页。", 2600);
      return;
    }
    if (this.plugin.settings.homePinnedCommands.length >= HOME_PINNED_COMMAND_LIMIT) {
      new Notice("主页快捷方式最多只能固定 8 个。", 2600);
      return;
    }
    await this.setPinnedCommands(
      [
        ...this.plugin.settings.homePinnedCommands,
        {
          commandId,
          labelOverride: "",
          iconOverride: ""
        }
      ],
      { refreshSection: true }
    );
  }

  private async addUrlLauncher(commandId: string): Promise<void> {
    if (this.plugin.settings.urlLaunchers.some((item) => item.commandId === commandId)) {
      new Notice("这个命令已经绑定到 URL 启动入口。", 2600);
      return;
    }
    if (this.plugin.settings.urlLaunchers.length >= URL_LAUNCHER_LIMIT) {
      new Notice("URL 启动入口最多只能设置 8 条。", 2600);
      return;
    }
    const slot = this.getNextAvailableUrlLauncherSlot();
    if (!slot) {
      new Notice("没有可用的 URL 启动槽位。", 2600);
      return;
    }

    await this.setUrlLaunchers(
      [
        ...this.plugin.settings.urlLaunchers,
        {
          slot,
          commandId
        }
      ],
      { refreshSection: true }
    );
  }

  private async removeUrlLauncher(slot: number): Promise<void> {
    await this.setUrlLaunchers(
      this.plugin.settings.urlLaunchers.filter((item) => item.slot !== slot),
      { refreshSection: true }
    );
  }

  private openRemoveUrlLauncherConfirm(launcher: UrlLauncherSetting): void {
    const commandInfo = this.resolveCommandOption(launcher.commandId);
    const commandName = commandInfo?.name ?? launcher.commandId;
    new DeleteSettingItemConfirmModal(
      this.app,
      "删除 URL 启动入口",
      `确定删除“${commandName}”的 URL 启动入口吗？`,
      "删除后，这条固定链接会失效，但不会影响主页快捷方式里的同名命令。",
      async () => {
        await this.removeUrlLauncher(launcher.slot);
      }
    ).open();
  }

  private openIconPicker(commandId: string): void {
    const current = this.plugin.settings.homePinnedCommands.find((command) => command.commandId === commandId);
    if (!current) {
      return;
    }

    new HomeIconPickerModal(this.app, async (iconId) => {
      await this.updatePinnedCommand(commandId, {
        ...current,
        iconOverride: iconId
      });
    }).open();
  }

  private async commitPinnedCommandDragOrder(rowsEl: HTMLElement): Promise<void> {
    const currentCommands = this.plugin.settings.homePinnedCommands;
    const commandById = new Map(currentCommands.map((command) => [command.commandId, command]));
    const nextCommands = Array.from(rowsEl.querySelectorAll<HTMLElement>(".sidet-settings-home-command-row"))
      .map((row) => row.dataset.commandId ?? "")
      .map((commandId) => commandById.get(commandId))
      .filter((command): command is HomePinnedCommandSetting => Boolean(command));
    if (nextCommands.length !== currentCommands.length) {
      this.requestDisplay();
      return;
    }
    if (nextCommands.every((command, index) => command.commandId === currentCommands[index]?.commandId)) {
      return;
    }
    this.syncPinnedCommandRowIndexes(rowsEl);
    await this.setPinnedCommands(nextCommands, { rerender: false });
  }

  private syncPinnedCommandRowIndexes(rowsEl: HTMLElement): void {
    Array.from(rowsEl.querySelectorAll<HTMLElement>(".sidet-settings-home-command-row"))
      .forEach((row, index) => {
        row.dataset.index = String(index);
      });
  }
}
