import type { MessageAttachment } from "../../types";

export interface BuiltInSkill {
  id: string;
  name: string;
  triggerTerms: string[];
  useWhen: string;
  constraints: string[];
  protocol?: string[];
  source: string;
  sourcePath?: string;
}

interface ScoredSkill {
  card: BuiltInSkill;
  score: number;
  matchedTerms: string[];
}

const BUILT_IN_SKILLS: BuiltInSkill[] = [
  {
    id: "obsidian-markdown",
    name: "Obsidian Markdown",
    triggerTerms: [
      "markdown",
      "md",
      "wiki",
      "wikilink",
      "双链",
      "笔记",
      "引用",
      "properties",
      "property",
      "frontmatter",
      "callout",
      "embed",
      "标签",
      "属性"
    ],
    useWhen: "需要生成、整理或解释 Obsidian Markdown、双链、属性、嵌入、callout 或笔记结构时使用。",
    constraints: [
      "优先输出 Obsidian 可直接使用的 Markdown。",
      "引用库内对象时优先使用 [[双链]] 或清晰路径。",
      "不要把聊天流水伪装成长期笔记事实。"
    ],
    source: "内置 Skill：obsidian-markdown"
  },
  {
    id: "obsidian-bases",
    name: "Obsidian Bases",
    triggerTerms: [
      "base",
      "bases",
      ".base",
      "数据库",
      "表格",
      "视图",
      "过滤",
      "筛选",
      "公式",
      "属性表",
      "卡片视图"
    ],
    useWhen: "需要围绕 Obsidian Bases 规划表格、卡片、过滤、公式或基于属性的视图时使用。",
    constraints: [
      "先明确数据来自哪些 Markdown 属性。",
      "先做轻视图，不把 Bases 当成完整数据库系统。",
      "避免在不知道库内字段时虚构属性名。"
    ],
    source: "内置 Skill：obsidian-bases"
  },
  {
    id: "json-canvas",
    name: "JSON Canvas",
    triggerTerms: [
      "canvas",
      ".canvas",
      "json canvas",
      "画布",
      "节点",
      "连线",
      "关系图",
      "白板",
      "mindmap",
      "思维导图"
    ],
    useWhen: "需要生成或调整 Obsidian Canvas 的节点、连线、分组或关系结构时使用。",
    constraints: [
      "先处理节点和连线语义，再考虑布局坐标。",
      "不要为了可视化而复制长篇正文。",
      "保持节点粒度短，便于手机端查看。"
    ],
    source: "内置 Skill：json-canvas"
  },
  {
    id: "skill-builder",
    name: "Skill Builder",
    triggerTerms: [
      "skill",
      "skills",
      "技能",
      "生成技能",
      "创建技能",
      "内置技能",
      "触发",
      "description",
      "描述",
      "规则",
      "卡片"
    ],
    useWhen: "需要把经验、工作方式或库内知识整理成完整 Skill 或路由提示时使用。",
    constraints: [
      "Skill 负责触发、边界和操作协议，不保存长知识正文。",
      "能由 Wiki 或原文承载的内容不要塞进 Skill。",
      "优先写短触发、短边界和低成本例子。"
    ],
    source: "内置 Skill：skill-creator 摘要"
  }
];

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildQuery(text: string, attachments: MessageAttachment[]): string {
  const attachmentText = attachments.map((attachment) => {
    if (attachment.type === "markdown") {
      return `${attachment.name} ${attachment.path}`;
    }
    if (attachment.type === "webpage") {
      return `${attachment.name} ${attachment.url}`;
    }
    return `${attachment.name} ${attachment.mimeType}`;
  }).join(" ");
  return normalizeText(`${text} ${attachmentText}`);
}

function scoreSkill(card: BuiltInSkill, query: string): ScoredSkill | null {
  const matchedTerms = card.triggerTerms.filter((term) => query.includes(term.toLowerCase()));
  if (matchedTerms.length === 0) {
    return null;
  }

  return {
    card,
    score: matchedTerms.length,
    matchedTerms
  };
}

export function findRelevantBuiltInSkills(
  text: string,
  attachments: MessageAttachment[],
  maxCards: number
): BuiltInSkill[] {
  const query = buildQuery(text, attachments);
  const scored = BUILT_IN_SKILLS
    .map((card) => scoreSkill(card, query))
    .filter((item): item is ScoredSkill => item !== null)
    .sort((left, right) => right.score - left.score);

  return scored.slice(0, maxCards).map((item) => item.card);
}
