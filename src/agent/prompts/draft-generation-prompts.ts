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
