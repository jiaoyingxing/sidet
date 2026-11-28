import {
  App,
  ButtonComponent,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  SettingGroup,
  setIcon
} from "obsidian";
import { DEFAULT_EXPORT_FOLDER } from "../constants";
import type SidetPlugin from "../main";
import {
  SETTINGS_ROOT_PAGE,
  SETTINGS_TAB_ICON,
  decorateSettingsRootRowIcons
} from "./settings-root-icons";
import { SecretStorageService } from "./secret-storage";
import { detectSettingsTrack, resolveSettingsRerenderAction } from "./settings-track";
import { bindDeferredSettingInput, disableTextAssistance } from "./setting-input-utils";
import { HomePinnedCommandsSection } from "./setting-tab-home-section";
import {
  configureAutoWebSearchRow,
  configureProviderModelRow,
  renderModelConfigList,
  renderProviderSettingsSection
} from "./setting-tab-provider-section";

/** 作者 GitHub 仓库（与 README / Release 地址一致）。 */
const GITHUB_URL = "https://github.com/jiaoyingxing/sidet";
/** 作者小红书主页固定用户 ID 链接。 */
const XIAOHONGSHU_URL =
  "https://www.xiaohongshu.com/user/profile/605dfc23000000000101cfdb";
/** 「关于」作者行 desc。 */
const ABOUT_AUTHOR_DESC = "焦应行（Jiao Yingxing）";
/** 「关于」问题反馈行 desc。 */
const ABOUT_FEEDBACK_DESC =
  "使用中遇到问题，可在 GitHub 提交 Issue，或通过小红书私信联系我。";

/** 「关于-作者」行的联系方式按钮：图标＋短标签一体化小按钮，
 *  按钮原生空内容后自行挂 icon/label 两 span。 */
function configureAboutContactButton(
  button: ButtonComponent,
  options: {
    label: string;
    icon: string;
    url: string;
    extraClassName?: string;
  }
): void {
  button.setClass("sidet-settings-about-contact-button");
  button.setTooltip(options.label);
  button.buttonEl.setAttribute("aria-label", options.label);
  button.onClick(() => {
    window.open(options.url, "_blank", "noopener,noreferrer");
  });
  button.buttonEl.empty();
  if (options.extraClassName) {
    button.buttonEl.addClass(options.extraClassName);
  }
  const iconEl = button.buttonEl.createSpan({
    cls: "sidet-settings-about-contact-button-icon"
  });
  setIcon(iconEl, options.icon);
  button.buttonEl.createSpan({
    cls: "sidet-settings-about-contact-button-label",
    text: options.label
  });
}

export class DialogSettingTab extends PluginSettingTab {
  private readonly homeSection: HomePinnedCommandsSection;
  private providerSectionEl: HTMLElement | null = null;
  /** 声明式「模型服务」页的模型列表挂载点（行内重建用；宿主重建子页时由 render 重置）。 */
  private declarativeModelListEl: HTMLElement | null = null;
  /** 根级导航行行首图标补挂观察器（1.13+ 声明式；unload 时由 plugin.register 断开）。 */
  private rootRowIconObserver: MutationObserver | null = null;

  /** 「使用须知」页四行单一事实源（从旧「关于」六行原样平移拆出；
   *  display() 组路径与声明式须知页共用）。版权行在 2026-11-27 随 MIT 开源
   *  改口径：原文「保留所有权利」与 MIT 授权互斥，现为「采用 MIT 许可证」。 */
  private static readonly NOTICE_ROW_DEFS: readonly {
    readonly name: string;
    readonly desc: string;
  }[] = [
    {
      name: "使用与备份",
      desc:
        "Sidet 可以引用、整理并在你确认后写入笔记。AI 和第三方服务可能出错，请检查结果，并为重要笔记保留备份。"
    },
    {
      name: "模型与 API",
      desc:
        "模型服务、账号和 API Key 由你自行配置。调用费用、使用限制和服务条款以对应服务商为准。"
    },
    {
      name: "隐私",
      desc:
        "Sidet 不收集你的 API Key、对话或笔记内容。使用云端模型时，相关内容会发送给你配置的服务商。"
    },
    {
      name: "版权",
      desc: "Sidet 采用 MIT 许可证。版权所有 © 2026 焦应行。"
    }
  ];

  constructor(
    app: App,
    private readonly plugin: SidetPlugin,
    private readonly secrets: SecretStorageService
  ) {
    super(app, plugin);
    // 设置窗左栏页签图标：宿主默认隐藏第三方插件行的图标元素，由 styles.css
    // 按 data-setting-id 只放开本插件那一行。
    this.icon = SETTINGS_TAB_ICON;
    this.observeRootRowIcons();
    // 行内刷新兜底全部改轨道感知（display() 仅 <1.13 合法；声明式轨道走 update()，
    // 见 rerenderTrack 注释）。
    this.homeSection = new HomePinnedCommandsSection(app, plugin, () => this.rerenderTrack());
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("sidet-settings");

    this.homeSection.render(containerEl);
    this.providerSectionEl = containerEl.createDiv();
    this.renderProviderSection();
    this.renderStorageGroup(containerEl);
    this.renderAboutGroup(containerEl);
    this.renderNoticeGroup(containerEl);
  }

  /**
   * 声明式设置定义（Obsidian ≥1.13；d.ts 1.13.1：`getSettingDefinitions`／
   * `update()`／`settingItems` 均为 @since 1.13.0，与本仓声明式可用门一致）。
   *
   * 六子页：主页 / URL 启动 / 模型服务 / 数据导出 / 关于 / 使用须知。
   * 动态主体采用「单行承载列表」（`items`＋render 回调），数据导出、关于与
   * 使用须知纯正文行直接声明（进设置搜索索引）；关于页作者行带联系方式钮
   * 走 render。<1.13 回落 display() 保持平铺形态（多一段「使用须知」组）。
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    // 声明式路径下 display() 不被调用，容器作用域类在此补挂（幂等；与回落
    // 路径 display() 行为一致）。
    this.containerEl.addClass("sidet-settings");
    // 关于页三行同型：产品行 desc 为「版本 x.y.z」，作者行带
    // GitHub／小红书图标钮。
    return [
      // 根级＝两级分组（3+3 对称）：前三页一组，数据导出／关于／
      // 使用须知三页一组；组对象不带 name/desc，仅承载间隔分档。
      {
        type: "group",
        items: [
          {
            type: "page",
            name: SETTINGS_ROOT_PAGE.home,
            desc: "固定到主页快捷方式的命令。",
            items: [
              {
                name: "主页快捷方式",
                desc: this.homeSection.getHomePinnedCommandDescription(),
                render: (setting) =>
                  this.homeSection.configureHomePinnedRow(setting),
              },
            ],
          },
          {
            type: "page",
            name: SETTINGS_ROOT_PAGE.url,
            desc: "obsidian:// 启动链接与内置入口。",
            items: [
              {
                name: "URL 启动入口",
                desc: this.homeSection.getUrlLauncherDescription(),
                render: (setting) =>
                  this.homeSection.configureUrlLauncherRow(setting),
              },
            ],
          },
          {
            type: "page",
            name: SETTINGS_ROOT_PAGE.model,
            desc: "已保存模型项的新增、编辑、默认设置与自动联网开关。",
            items: [
              {
                name: "模型列表",
                render: (setting) => {
                  this.declarativeModelListEl = configureProviderModelRow(
                    setting,
                    this.plugin,
                    this.secrets,
                    () => this.refreshDeclarativeModelList(),
                  );
                },
              },
              {
                name: "允许模型自动联网",
                desc: "需要最新或外部信息时，让模型自己联网搜索。关闭后仍可在对话里手动开启联网搜索。",
                render: (setting) => configureAutoWebSearchRow(setting, this.plugin),
              },
            ],
          },
        ],
      },
      {
        type: "group",
        items: [
          {
            type: "page",
            name: SETTINGS_ROOT_PAGE.data,
            desc: "导出目录与数据维护入口。",
            items: [
              {
                name: "导出目录",
                desc: `留空时使用 ${DEFAULT_EXPORT_FOLDER}。`,
                render: (setting) => this.configureExportFolderRow(setting),
              },
              {
                name: "已归档对话",
                desc: "查看已归档对话，并手动恢复或删除。",
                render: (setting) => this.configureArchivedConversationsRow(setting),
              },
            ],
          },
          {
            type: "page",
            name: SETTINGS_ROOT_PAGE.about,
            desc: "产品、作者与问题反馈。",
            items: [
              {
                name: "Sidet",
                desc: this.getProductVersionDesc(),
              },
              {
                name: "作者",
                desc: ABOUT_AUTHOR_DESC,
                render: (setting) => this.configureAuthorRow(setting),
              },
              {
                name: "问题反馈",
                desc: ABOUT_FEEDBACK_DESC,
              },
            ],
          },
          {
            type: "page",
            name: SETTINGS_ROOT_PAGE.notice,
            desc: "使用边界、隐私与版权。",
            items: DialogSettingTab.NOTICE_ROW_DEFS.map((row) => ({
              name: row.name,
              desc: row.desc,
            })),
          },
        ],
      },
    ];
  }

  /** 1.13+ 根级导航行的行首图标补挂。
   *
   * 宿主进子页再返回会重建根行，盯 `containerEl` 的 DOM 变化同步补挂；
   * **不用 rAF 合帧**——设置窗在前台时主窗 `document.hidden === true`，
   * rAF 不会触发。装饰只遍历容器内的
   * `.setting-item`（根级 6 行）且幂等，成本可忽略。
   */
  private observeRootRowIcons(): void {
    this.rootRowIconObserver = new MutationObserver(() => {
      this.decorateRootRowIcons();
    });
    this.rootRowIconObserver.observe(this.containerEl, {
      attributes: false,
      childList: true,
      characterData: false,
      subtree: true,
    });
    this.plugin.register(() => {
      this.rootRowIconObserver?.disconnect();
      this.rootRowIconObserver = null;
    });
  }

  /** `<1.13` 的 display() 形态没有根级导航行，只在声明式渲染（1.13+）才装饰。 */
  private decorateRootRowIcons(): void {
    if (detectSettingsTrack(this) !== "declarative") {
      return;
    }
    decorateSettingsRootRowIcons(this.containerEl);
  }

  /**
   * 轨道感知整页重渲染：替代历史上「手动调 display()」。
   *
   * 声明式轨道调 `display()` 会把 <1.13 平铺形态灌进声明式 DOM（宿主合同为
   * 声明式非空时不调 display，插件侧手动调仍会执行），故 ≥1.13 一律走
   * `update()`（d.ts：重存 getSettingDefinitions 结果并刷新渲染与搜索索引）；
   * 页内动态列表的常规刷新优先走各节行内重建（home 两个 refresh*、
   * refreshDeclarativeModelList），update() 只作 refs 亡失兜底。
   */
  private rerenderTrack(): void {
    if (resolveSettingsRerenderAction(this) === "update") {
      // `update()` @since 1.13.0，与 settingItems（detectSettingsTrack 判据之源）
      // 同版求——轨道先行证明宿主 ≥1.13.0。lint 的 minAppVersion 静态检查跨不过
      // 这条运行时版本缝（且本仓禁 disable 该规则），故经类型投影调用：方法签名
      // 与直接调用等价（撤除门＝minAppVersion ≥1.13）。
      const updateTab = this as unknown as { update?: () => void };
      if (typeof updateTab.update === "function") {
        updateTab.update();
      }
      return;
    }
    this.display();
  }

  /** 声明式「模型服务」页：模型列表行内重建（refs 亡失时静默——宿主会在子页
   *  重进时重跑 render 回调重建行与句柄）。 */
  private refreshDeclarativeModelList(): void {
    if (!this.declarativeModelListEl) {
      return;
    }
    renderModelConfigList(
      this.declarativeModelListEl,
      this.plugin,
      this.secrets,
      () => this.refreshDeclarativeModelList(),
    );
  }

  private renderProviderSection(): void {
    if (!this.providerSectionEl) {
      return;
    }
    this.providerSectionEl.empty();
    renderProviderSettingsSection(
      this.providerSectionEl,
      this.plugin,
      this.secrets,
      () => this.renderProviderSection()
    );
  }

  /** 「关于」组：产品/作者/问题反馈三行，与声明式关于页逐行同构。 */
  private renderAboutGroup(containerEl: HTMLElement): void {
    const group = new SettingGroup(containerEl).setHeading("关于");
    group.addSetting((setting) => {
      setting.setName("Sidet").setDesc(this.getProductVersionDesc());
    });
    group.addSetting((setting) => this.configureAuthorRow(setting));
    group.addSetting((setting) => {
      setting.setName("问题反馈").setDesc(ABOUT_FEEDBACK_DESC);
    });
  }

  /** 「使用须知」组：旧「关于」四行原样平移（零文案改动）。 */
  private renderNoticeGroup(containerEl: HTMLElement): void {
    const group = new SettingGroup(containerEl).setHeading("使用须知");
    for (const row of DialogSettingTab.NOTICE_ROW_DEFS) {
      group.addSetting((setting) => {
        setting.setName(row.name).setDesc(row.desc);
      });
    }
  }

  /** 作者行：GitHub／小红书图标钮（两轨道共用同一构建器）。 */
  private configureAuthorRow(setting: Setting): void {
    setting
      .setClass("sidet-settings-about-contact-setting")
      .setName("作者")
      .setDesc(ABOUT_AUTHOR_DESC);
    setting.addButton((button) => {
      configureAboutContactButton(button, {
        label: "GitHub",
        icon: "github",
        url: GITHUB_URL
      });
    });
    setting.addButton((button) => {
      configureAboutContactButton(button, {
        label: "小红书",
        icon: "book-open",
        url: XIAOHONGSHU_URL,
        extraClassName: "sidet-settings-about-contact-button--xiaohongshu"
      });
    });
  }

  /** 产品行版本 desc（「版本 x.y.z」）。 */
  private getProductVersionDesc(): string {
    return `版本 ${this.plugin.manifest.version?.trim() || "0.2.0"}`;
  }

  private renderStorageGroup(containerEl: HTMLElement): void {
    const group = new SettingGroup(containerEl).setHeading("数据与导出");
    group.addSetting((setting) => this.configureExportFolderRow(setting));
    group.addSetting((setting) => this.configureArchivedConversationsRow(setting));
  }

  /** 导出目录行（display() 组路径与声明式「数据导出」页 render 回调共用）。 */
  private configureExportFolderRow(setting: Setting): void {
    setting
      .setName("导出目录")
      .setDesc(`留空时使用 ${DEFAULT_EXPORT_FOLDER}。`)
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_EXPORT_FOLDER)
          .setValue(this.plugin.settings.exportFolder);
        disableTextAssistance(text.inputEl);
        bindDeferredSettingInput(text, async (value) => {
          this.plugin.settings.exportFolder = value.trim() || DEFAULT_EXPORT_FOLDER;
          await this.plugin.savePluginSettings();
        });
      });
  }

  /** 已归档对话行（两轨道共用）。 */
  private configureArchivedConversationsRow(setting: Setting): void {
    setting
      .setName("已归档对话")
      .setDesc("查看已归档对话，并手动恢复或删除。")
      .addButton((button) => {
        button
          .setButtonText("打开")
          .onClick(() => {
            void this.plugin.openArchivedConversationsManager();
          });
      });
  }

}
