import { App } from "obsidian";
import type { ContextDraftResult } from "./context-bundle";
import { VaultAgentDraftBuilders } from "./vault-agent-draft-builders";
import {
  VaultAgentRouterContextBuilder,
  type VaultAgentPreSendContextResult
} from "./vault-agent-router-context";
import type { ConversationRecord, MessageAttachment } from "../types";

export class VaultAgentService {
  private readonly draftBuilders: VaultAgentDraftBuilders;
  private readonly routerContextBuilder: VaultAgentRouterContextBuilder;

  constructor(_app: App) {
    this.draftBuilders = new VaultAgentDraftBuilders();
    this.routerContextBuilder = new VaultAgentRouterContextBuilder();
  }

  async buildPreSendAgentContext(
    text: string,
    attachments: MessageAttachment[]
  ): Promise<VaultAgentPreSendContextResult> {
    return this.routerContextBuilder.build(text, attachments);
  }

  buildDraftNotePreviewDraft(conversation: ConversationRecord): ContextDraftResult {
    return this.draftBuilders.buildDraftNotePreviewDraft(conversation);
  }
}
