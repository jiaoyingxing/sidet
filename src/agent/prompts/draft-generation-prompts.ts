import type { ContextBundle } from "../context-bundle";

interface ConversationBundleOptions {
  conversationTitle: string;
  usefulMessageCount: number;
  attachmentCount: number;
}

function buildConversationBundleMetadata(
  options: ConversationBundleOptions
): NonNullable<ContextBundle["metadata"]> {
  return [
    { label: "来源对话", value: options.conversationTitle || "未命名对话" },
    { label: "来源消息数", value: String(options.usefulMessageCount) },
    options.attachmentCount > 0
      ? { label: "附件线索", value: `${options.attachmentCount} 个` }
      : { label: "附件线索", value: "" }
  ];
}

export function buildMemoryCandidateBundle(options: ConversationBundleOptions): ContextBundle {
  return {
    kind: "memory-candidate",
    title: "AI 记忆候选（预览，不会写入）：",
    description: [
      "说明：请基于本条消息之前的当前 Sidet 对话上下文提炼；Sidet 不会自动写入 vault。"
    ],
    metadata: buildConversationBundleMetadata(options),
    footer: [
      "请提炼 0-5 条值得进入 Sidet 记忆链的候选。要求：",
      "- 只保留能帮助下一次判断的稳定结论。",
      "- 不保存聊天流水、一次性过程或临时情绪。",
      "- 每条候选写清：记忆内容 / 来源依据 / 适用范围 / 失效条件。",
      "- 如果没有值得保存的内容，直接回答：本轮无记忆候选。"
    ],
    truncated: false,
    noteCount: 0
  };
}

export function buildSkillGenerationPrompt(): string {
  return [
    "请基于本条消息之前的当前 Sidet 对话上下文，生成一张可保存到 Sidet/Skills 的完整 Skill。",
    "",
    "目标：让 Sidet 下次遇到相似任务时更容易判断该用什么方法、读什么内容、避开什么边界。",
    "",
    "要求：",
    "- 只生成一张卡片，不要生成多张。",
    "- 完整 Skill 以 SKILL.md 口径输出，至少包含 frontmatter、标题、什么时候用、触发词、边界、操作协议和不写入。",
    "- 能由 Wiki 记忆或原始笔记承载的内容，不要写进 Skill。",
    "- 句子短，低成本，但结构要完整。",
    "- 不要使用代码块包裹全文。",
    "- 如果本轮没有值得复用的技能路由，直接回答：本轮无 Skill。",
    "",
    "请使用这个格式：",
    "",
    "---",
    "name: \"Skill 名称\"",
    "description: \"一句话说明用途\"",
    "---",
    "",
    "# Skill 名称",
    "",
    "## 什么时候用",
    "- 一句话说明什么时候使用。",
    "",
    "## 触发词",
    "- 关键词1",
    "- 关键词2",
    "- 关键词3",
    "",
    "## 边界",
    "- 不做什么。",
    "- 避免什么误用。",
    "",
    "## 操作协议",
    "- 第一步。",
    "- 第二步。",
    "",
    "## 不写入",
    "- 哪些内容应该留在 Wiki、原始笔记或临时材料里。"
  ].join("\n");
}

export function buildDraftNotePreviewBundle(options: ConversationBundleOptions): ContextBundle {
  return {
    kind: "draft-note-preview",
    title: "草稿笔记预览（不会写入）：",
    description: [
      "说明：请基于本条消息之前的当前 Sidet 对话上下文生成 Markdown 草稿；Sidet 不会自动写入 vault。"
    ],
    metadata: buildConversationBundleMetadata(options),
    footer: [
      "请输出一篇可保存的 Markdown 草稿预览。要求：",
      "- 先给出建议标题和建议保存位置。",
      "- 正文只保留高信号内容，不复制聊天流水。",
      "- 如果引用了库内笔记或附件线索，优先用 [[双链]] 或清晰路径标注。",
      "- 如果信息不足，直接说明还缺什么，不要强行补全。"
    ],
    truncated: false,
    noteCount: 0
  };
}
