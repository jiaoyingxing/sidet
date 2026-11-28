import { buildContextDraftResult, type ContextDraftResult } from "./context-bundle";
import { buildDraftNotePreviewBundle } from "./prompts/draft-generation-prompts";
import type { ConversationRecord } from "../types";

export class VaultAgentDraftBuilders {
  buildDraftNotePreviewDraft(conversation: ConversationRecord): ContextDraftResult {
    const usefulMessageCount = conversation.messages.filter(
      (message) => message.text.trim() || message.attachments?.length
    ).length;
    if (usefulMessageCount === 0) {
      throw new Error("当前对话还没有可生成草稿笔记的内容。");
    }

    const attachmentCount = conversation.messages.reduce(
      (count, message) => count + (message.attachments?.length ?? 0),
      0
    );
    const bundle = buildDraftNotePreviewBundle({
      conversationTitle: conversation.title,
      usefulMessageCount,
      attachmentCount
    });

    return buildContextDraftResult(bundle, "请直接生成草稿笔记预览，不要写入文件。");
  }
}
