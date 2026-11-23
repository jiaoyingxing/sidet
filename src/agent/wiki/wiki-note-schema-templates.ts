interface WikiTemplateNoteFields<Kind extends string> {
  kind: Kind;
  summary: string;
  aliases?: string[];
  related?: string[];
  sources?: string[];
}

interface WikiTemplateMarkdownOptions<Kind extends string> {
  title: string;
  body: string;
  fields: WikiTemplateNoteFields<Kind>;
}

type WikiTemplateMarkdownBuilder<Kind extends string> = (options: WikiTemplateMarkdownOptions<Kind>) => string;

export function buildWikiConceptPageTemplateWith(
  buildWikiNoteMarkdown: WikiTemplateMarkdownBuilder<"concept-page">,
  conceptPageKind: "concept-page",
  title = "概念页标题"
): string {
  return buildWikiNoteMarkdown({
    title,
    body: [
      "## 概要",
      "- 用 1 到 3 条说明这个概念页管什么，不管什么。",
      "",
      "## 先读",
      "- 列 2 到 5 张最值得先读的知识卡或子概念页。",
      "",
      "## 主题",
      "### 当前主题",
      "- 写当前最值得先展开的入口。",
      "",
      "### 后续可展开",
      "- 写下一层主题或待展开方向。",
      "",
      "## 相关",
      "- `[[相关知识卡]]`",
      "- `[[相关概念页]]`"
    ].join("\n"),
    fields: {
      kind: conceptPageKind,
      summary: "一句话说明这个概念页负责的知识范围与路由职责。",
      aliases: [],
      related: [],
      sources: []
    }
  });
}

export function buildWikiIndexTemplateWith(
  buildWikiNoteMarkdown: WikiTemplateMarkdownBuilder<"knowledge-base">,
  knowledgeBaseKind: "knowledge-base",
  title = "Index",
  aliases: string[] = ["Sidet/Wiki"]
): string {
  return buildWikiNoteMarkdown({
    title,
    body: [
      "## 概要",
      "- 这页只做 Sidet/Wiki 的知识库根路由，不堆长正文。",
      "",
      "## 先读",
      "- `[[概念页标题]]`",
      "- `[[高价值知识卡]]`",
      "",
      "## 主题",
      "### 当前主主题",
      "- 写当前最重要的主题入口。",
      "",
      "### 正在生长",
      "- 放正在继续扩展的概念页或主题分支。",
      "",
      "## 相关",
      "- `[[相关知识卡]]`",
      "- `[[相关概念页]]`"
    ].join("\n"),
    fields: {
      kind: knowledgeBaseKind,
      summary: "Sidet/Wiki 的知识库根页，负责当前主题入口、先读顺序和库内路由。",
      aliases,
      related: [],
      sources: []
    }
  });
}

export function buildWikiSchemaGuidanceLines(): string[] {
  return [
    "- 知识库第一阶段先按 `Index.md` + 最少 YAML 识别；默认知识库仍固定为 Sidet/Wiki，但不跨目录聚合。",
    "- 第一版公共字段默认只保留：sidet_type、aliases、summary、status、related、sources、updatedAt；只有确有必要时再补 keywords、parents、children。",
    "- 普通知识卡用 sidet_type: knowledge-card；知识库根页用 sidet_type: knowledge-base；概念路由页用 sidet_type: concept-page；长展开页用 sidet_type: supporting-note。",
    "- 如果目标路径是知识库根页 Index.md，默认按 knowledge-base 处理。",
    "- knowledge-card 正文骨架：## 判断 / ## 相关 / ## 来源。",
    "- concept-page 正文骨架：## 概要 / ## 先读 / ## 主题 / ## 相关。",
    "- knowledge-base 正文骨架：## 概要 / ## 先读 / ## 主题 / ## 相关。",
    "- supporting-note 正文骨架：## 概要 / ## 正文 / ## 来源 / ## 相关。",
    "- 如果要补 links，优先使用 Obsidian 的 [[双链]]，让脚本和人都能读。"
  ];
}
