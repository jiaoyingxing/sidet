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

Sidet 把 Obsidian 的新标签页变成 AI 对话主页，笔记、选区、网页与图片都可随需带入对话。

同时，任意命令——无论来自 Obsidian 原生还是其他插件——均可设为主页图标，或绑定为 URL 供快捷键一键调用。

## 1. 主要功能

| 功能 | 说明 |
| --- | --- |
| 🏠 主页与常用命令 | 新建标签页时打开或聚焦 Sidet 主页；已经位于主页时可继续打开原生空白页。常用的 Sidet、Obsidian 和其他插件命令可以固定在主页。 |
| 💬 对话 | 支持连续对话、流式回复、历史记录和模型切换。 |
| 📥 笔记与资料 | 可以带入当前笔记、选区、网页和图片。 |
| 📚 知识库 | 可以选择一个知识库或全部知识库，检索库内已有笔记；当前使用本地关键词检索。 |
| 🗂️ Wiki 整理 | 可以把当前输入整理成 Wiki 卡片草稿，也可以把对话或笔记整理到知识库，并为文件夹创建 `Index.md`。 |
| 🌐 网页与联网搜索 | 可以把指定网页加入对话，也可以在当前对话中打开联网搜索。 |
| 📝 内容写回 | 整理结果先预览，再选择新建笔记、追加到现有笔记或改写指定笔记。 |
| 📂 会话管理 | 会话列表位于 Obsidian 右侧边栏，可以新建、搜索、置顶、分类和切换对话，也可以归档或导出已有对话。归档后的对话可在设置中恢复或删除。 |
| 📱 电脑与手机 | 对话内容使用中间的主标签页，右侧边栏用于管理会话。手机端对输入、键盘、滚动和页面布局做了单独适配。 |

## 2. 一次完整使用

1. 新建 Obsidian 标签页，打开或聚焦 Sidet 主页。
2. 直接输入问题，或者先选择知识库、网页剪藏、联网搜索或 Wiki 卡片。
3. 根据需要加入当前笔记、选区、网页或图片。
4. 在对话中继续提问、整理和修改。
5. 需要保存时先查看预览，再确认写入 Obsidian；暂时不保存的内容可以留在会话记录中。

## 3. 主聊天区与右侧边栏

Sidet 把正在使用的对话放在 Obsidian 中间的主标签页，右侧边栏只保留会话列表。点击列表中的会话，会在主标签页中打开，不会把聊天内容挤在狭窄的侧栏里。

右侧边栏会在工作区启动后自动恢复，也可以通过命令面板的“打开对话列表”重新打开。列表可以新建对话、按标题搜索、置顶常用对话、创建文件夹并整理会话。每条对话的菜单还提供移动到文件夹、归档和导出；当前打开的对话会在列表中标出。

## 4. 主页快捷方式

主页最多可以固定 8 个命令。Obsidian 命令和其他插件的命令都可以加入；Sidet 自有命令中可固定的是“打开 Sidet”“打开对话列表”“新建对话”，依赖活动上下文或需要写入确认的命令不进主页和 URL 入口。固定项可以调整顺序和图标。新建标签页时，如果没有 Sidet 主页会创建一页；主页在后台时会聚焦已有页面；已经位于主页时才会打开 Obsidian 原生空白页。

## 5. URL 启动

Sidet 内置“打开新对话”和“导入剪贴板”两条 Obsidian URL。还可以为常用命令设置最多 8 条自定义 URL。

这些链接可以配合手机快捷指令、桌面快捷方式或其他应用使用。点击链接后，Sidet 会打开新对话、导入剪贴板内容，或者运行已经绑定的命令。

## 6. 模型服务

Sidet 可以保存多条模型配置。每条配置分别设置服务商、模型、接口地址和 API Key，也可以指定一条默认模型。

新对话使用当前默认模型，已经创建的对话继续使用原来的模型。删除正在使用的模型后，对应对话会改用当前默认模型。API Key 保存在 Obsidian 的 `SecretStorage` 中，不写入对话记录或普通插件设置。

Sidet 不附带模型账号。模型服务、账号、API Key、调用费用和使用限制由用户自行准备和管理。

## 7. 知识库与 Wiki

知识库可以按单个知识库或全部知识库进行检索。当前检索在本地按关键词完成，不调用模型。命中结果附在回复底部，每条显示类型、匹配方式和命中片段，点击可以直接打开对应笔记。

需要整理新内容时，可以把当前对话或当前笔记整理成知识卡片；执行前会先给出整理计划或内容预览。

知识库使用 `Index.md` 作为文件夹入口。Sidet 可以为指定文件夹创建知识库根页；历史 Wiki 卡片的格式维护位于“设置 → Sidet → 数据导出”，执行前会再次确认。文件只在用户确认后创建或修改。

## 8. 网页与联网搜索

遇到一篇明确的网页，可以输入网址，把网页正文加入当前对话。需要查询外部资料时，可以打开联网搜索；Sidet 会先生成搜索词，再搜索并按需读取页面，最后给出回答和来源。

知识库检索和联网搜索需要分别使用，不能同时开启。已经加入笔记、网页或图片等明确材料时，Sidet 会按普通资料对话处理。

## 9. 对话、导出与笔记

对话默认保存在插件数据中，不会因为开始对话就在笔记库里生成 Markdown 文件。需要保存时，可以使用以下方式：

- 将当前对话导出为 Markdown；
- 新建一篇笔记；
- 追加到现有笔记；
- 改写指定笔记；
- 把当前对话或笔记整理到知识库。

新建、追加和改写都会先显示预览，由用户确认后执行。导出目录可以在设置中修改；留空时使用 Sidet 的默认导出目录。

不再使用的对话可以归档。归档后的对话保留为只读内容，可以在设置中恢复或删除。

## 10. 数据与隐私

| 数据 | 保存在哪 |
| --- | --- |
| 对话记录、会话索引与插件设置 | 本地插件数据 |
| 各模型配置的 API Key | Obsidian `SecretStorage`（设备与仓库隔离） |

- 作者不收集用户的 API Key、对话内容、笔记内容或其他个人信息；
- 使用云端模型、联网搜索或网页服务时，完成请求所需的内容会进入用户自行选择的第三方服务链路。相关服务的费用、限制和数据处理规则以对应服务商为准；
- Sidet 不会默认改动笔记，也不在后台自动执行任务。涉及创建、追加或改写笔记的操作都需要用户确认；
- 重要笔记仍建议保留独立备份。

## 11. 当前使用范围

Sidet 目前以用户主动输入、选择和确认为主。联网功能用于搜索和引用网页，不提供完整浏览器的地址栏、标签页、登录态和浏览历史管理。知识库当前使用本地关键词检索，不做跨目录自动聚合。

如果日常工作主要在 Obsidian 中完成，可以从 Sidet 主页开始提问、查找自己的知识、处理网页资料或运行常用命令，需要保留的结果再写回笔记。

## 12. 安装

Sidet 需要 Obsidian `1.11.4` 或更高版本。

### 12.1 社区插件（推荐）

1. 打开 Obsidian 设置，进入“第三方插件”。
2. 搜索 `Sidet`。
3. 安装并启用插件。

### 12.2 BRAT

1. 在 Obsidian 社区插件中安装 BRAT。
2. 选择“Add Beta plugin”。
3. 输入 `https://github.com/jiaoyingxing/sidet`。
4. 安装完成后，在 Obsidian 设置中启用 Sidet。

### 12.3 手动安装

1. 从 [GitHub Releases](https://github.com/jiaoyingxing/sidet/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 将三个文件放入 `<你的仓库>/.obsidian/plugins/sidet/`。
3. 重启 Obsidian，或重新加载社区插件。
4. 在设置中启用 Sidet。

## 13. 许可

- Sidet 采用闭源分发，源码不公开。
- 不提供源码授权，不允许修改后再分发。
- 详细条款见 [LICENSE](./LICENSE)。

## 14. 联系

- Bug、可复现问题和功能建议：[GitHub Issues](https://github.com/jiaoyingxing/sidet/issues)
- 使用交流与产品动态：小红书搜索 **焦应行** 🔍
