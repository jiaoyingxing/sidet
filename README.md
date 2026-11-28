# Sidet 思得

<p align="center">
  <a href="https://github.com/jiaoyingxing/sidet/releases">
    <img alt="Release downloads" src="https://img.shields.io/github/downloads/jiaoyingxing/sidet/total.svg?style=flat-square&label=Release%20downloads" />
  </a>
  <a href="https://github.com/jiaoyingxing/sidet/releases">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/jiaoyingxing/sidet?style=flat-square&label=Latest%20release" />
  </a>
  <a href="https://community.obsidian.md/plugins/sidet">
    <img alt="Obsidian Plugin" src="https://img.shields.io/badge/Obsidian-Plugin-7c3aed?style=flat-square" />
  </a>
  <a href="./README.md">
    <img alt="CN 中文版" src="https://img.shields.io/badge/CN-%E4%B8%AD%E6%96%87%E7%89%88-d32f2f?style=flat-square" />
  </a>
  <a href="./README-en.md">
    <img alt="EN English" src="https://img.shields.io/badge/EN-English-2f6fed?style=flat-square" />
  </a>
</p>

## English quick start

Sidet turns Obsidian's new tab into an AI chat home page. Notes, selections, webpages, and images can be brought into a conversation, and commands from Obsidian or other plugins can be pinned to the home page or bound to a URL.

### Installation

1. Open **Settings → Community plugins**.
2. Search for **Sidet**, then select **Install** and **Enable**.
3. Sidet requires Obsidian `1.11.4` or later.

### Usage

Open a new tab to reach the Sidet home page, then type a question or choose a context source. Model configurations and API keys are managed in **Settings → Sidet**. Conversations stay in local plugin data until you confirm a write-back.

The full English guide is available in [README-en.md](./README-en.md).

接入你的 API，就能获得一个可以对话的内置轻 Agent：读取、编辑、生成笔记，提供非常完整的交互体验，尤其适配移动端操作。打开新标签页，就是它的主页。

## 1. 安装

1. 打开 Obsidian 设置，进入「第三方插件」。
2. 搜索 `Sidet`，安装并启用。需要 Obsidian `1.11.4` 或更高版本。

也可以用 BRAT（添加 `https://github.com/jiaoyingxing/sidet`），或从 [GitHub Releases](https://github.com/jiaoyingxing/sidet/releases) 下载 `main.js`、`manifest.json`、`styles.css` 放入 `<你的仓库>/.obsidian/plugins/sidet/`。

## 2. 基本用法

1. 新建 Obsidian 标签页，打开或聚焦 Sidet 主页。
2. 直接输入问题；需要时加入当前笔记、选区、网页或图片。
3. 在对话中继续提问、整理和修改。
4. 要保存结果：先看预览，再确认写回（新建笔记 / 追加 / 改写）；暂时不保存的内容留在会话记录里。

对话在 Obsidian 中间的主标签页进行；右侧边栏是功能完整的对话列表——新建、按标题搜索、置顶、文件夹分类、切换、归档与导出都在这里完成。点击列表中的会话即在主标签页打开，不会把聊天内容挤在狭窄的侧栏里；归档后的对话可在设置中恢复或删除。

**快捷入口**：主页可固定最多 8 个常用命令（Obsidian 原生和其他插件的命令都可以）；另内置「打开新对话」「导入剪贴板」两条 URL，可再自定义最多 8 条，配合手机快捷指令或桌面快捷方式一键调用。

## 3. 联网搜索

- 遇到一篇明确的网页：输入网址，把网页正文加入当前对话。
- 需要查外部资料：在对话中打开联网搜索，Sidet 会先生成搜索词，再搜索并按需读取页面，最后给出回答和来源。
- 开启设置中的「允许模型自动联网」后，模型在需要时会自行检索网页（`0.3.8` 起）。

## 4. 模型与 API Key

Sidet 可保存多条模型配置，每条分别设置服务商、模型、接口地址和 API Key，并可指定默认模型。API Key 保存在 Obsidian 的 `SecretStorage`（设备与仓库隔离），不写入对话记录或普通插件设置。

Sidet 不附带模型账号；模型服务、账号、API Key、调用费用和使用限制由你自行准备和管理。

## 5. 数据与隐私

| 数据 | 保存在哪 |
| --- | --- |
| 对话记录、会话索引与插件设置 | 本地插件数据 |
| 各模型配置的 API Key | Obsidian `SecretStorage`（设备与仓库隔离） |

- 作者不收集你的 API Key、对话内容、笔记内容或其他个人信息；
- 对话默认保存在插件数据中，不会因为开始对话就在笔记库里生成 Markdown 文件；
- 模型请求只发送到你为该模型配置的接口地址；联网搜索会把搜索词发送给内置搜索服务（必应、百度、搜狗），GitHub 相关查询会请求 GitHub API；添加网页时会请求你输入的网页地址；
- Sidet 以你主动输入、选择和确认为主，不在后台自动执行任务；涉及创建、追加或改写笔记的操作都需要你确认；
- 重要笔记仍建议保留独立备份。

## 6. `0.3.8` 起移除的功能

知识库、Wiki 与用户 Skill 已从 Sidet 移除：

- 你已创建的 `Sidet/Wiki`、`Sidet/Skills`、`Sidet/Memory` 目录与文件**不会被删除、改名或迁移**，可自行决定保留或清理；
- 插件不再读取、写入或索引这些目录，设置页中的相关入口一并移除；
- 查找已有笔记可继续使用对话中的笔记检索。

## 7. 许可与联系

- Sidet 采用 MIT 许可证，源码公开在 [GitHub 仓库](https://github.com/jiaoyingxing/sidet)。本地构建需要 Node.js 20+：`npm ci` 后 `npm run build`；第三方依赖许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)，详细条款见 [LICENSE](./LICENSE)。
- Bug、可复现问题和功能建议：[GitHub Issues](https://github.com/jiaoyingxing/sidet/issues)；使用交流与产品动态：小红书搜索 **焦应行** 🔍
