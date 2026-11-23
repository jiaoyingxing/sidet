import { setIcon } from "obsidian";

/**
 * 设置页图标。
 *
 * 两处落点：
 * - 设置窗左栏本插件那一行：官方 `SettingTab.icon`（构造期由 setting-tab.ts 设置）；
 *   宿主对第三方插件整栏隐藏该图标元素，由 styles.css 按 `data-setting-id`
 *   只放开本插件那一行。
 * - 1.13+ 根级导航行行首：声明式 schema（`SettingDefinitionPage` 等）**没有**图标
 *   字段（d.ts 1.13.1 复核一致），只能在自家容器上按「行名＝页名」补挂。
 *
 * 装饰是纯呈现：不动定义树、不动行文案、不承载语义（`aria-hidden`）。宿主改版
 * 导致类名/属性变化时静默退化为纯文字，不影响任何功能。
 */

/** 设置窗左栏插件行的页签图标（lucide 裸 id，宿主自行加前缀）。 */
export const SETTINGS_TAB_ICON = "bot-message-square";

/** 根级子页页名（页定义与行名对账单一事实源：装饰按「行名＝页名」现算，
 *  改文案只改这里才不会漂移）。 */
export const SETTINGS_ROOT_PAGE = {
  home: "主页",
  url: "URL 启动",
  model: "模型服务",
  data: "数据导出",
  about: "关于",
  notice: "使用须知"
} as const;

/**
 * 根级导航行图标：页名（SETTINGS_ROOT_PAGE 的值）→ lucide 裸 id。
 * 主页=`home`；URL 启动=`link`（它也是 URL 行内「复制链接」动作图的 id，
 * 两层级有意同形）；模型服务=`atom`；数据导出=`download`；关于=`info`；
 * 使用须知=`scroll-text`。六值互不重复，均经宿主 1.14.4 图标注册表核对存在。
 */
export const SETTINGS_ROOT_ICON_BY_PAGE = {
  [SETTINGS_ROOT_PAGE.home]: "home",
  [SETTINGS_ROOT_PAGE.url]: "link",
  [SETTINGS_ROOT_PAGE.model]: "atom",
  [SETTINGS_ROOT_PAGE.data]: "download",
  [SETTINGS_ROOT_PAGE.about]: "info",
  [SETTINGS_ROOT_PAGE.notice]: "scroll-text"
} as const;

/**
 * 行首图标的标记类：既是幂等判据（行首已有它即跳过），也是 styles.css 的挂点。
 * 判据与创建必须用同一个常量——两者漂移会让每轮 DOM 变化都再插一枚（观察器自激）。
 */
export const SETTINGS_ROOT_ROW_ICON_CLASS = "sidet-settings-root-icon";

/** 行名：宿主 1.14 结构 `.setting-item > .setting-item-info > .setting-item-name`。 */
function settingsRowName(row: HTMLElement): string {
  const nameEl = row.querySelector<HTMLElement>(
    ":scope > .setting-item-info > .setting-item-name",
  );
  return nameEl?.textContent?.trim() ?? "";
}

/**
 * 给根级导航行补挂行首图标（幂等：行首已是自家图标类即跳过）。
 *
 * 只装饰根级——`.setting-page` 子树里可能有与页同名的行（如命令类行为图标），
 * 不排除会把它也挂上。
 */
export function decorateSettingsRootRowIcons(container: HTMLElement): void {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>(".setting-item"),
  );
  if (rows.length === 0) return;
  for (const row of rows) {
    if (row.closest(".setting-page")) continue;
    const icon =
      SETTINGS_ROOT_ICON_BY_PAGE[
        settingsRowName(row) as keyof typeof SETTINGS_ROOT_ICON_BY_PAGE
      ];
    if (!icon) continue;
    if (
      row.firstElementChild?.classList.contains(SETTINGS_ROOT_ROW_ICON_CLASS)
    ) {
      continue;
    }
    const iconEl = row.createSpan({ cls: SETTINGS_ROOT_ROW_ICON_CLASS });
    setIcon(iconEl, icon);
    iconEl.setAttribute("aria-hidden", "true");
    row.prepend(iconEl);
  }
}
