import { UNTITLED_CONVERSATION_TITLE } from "../constants";
import { sanitizeFileName } from "../shared/paths";
import type {
  ConversationFolderRecord,
  ConversationFolderSummary,
  ConversationRecord,
  ConversationSummary,
  MessageMetaPanelDisplay,
  MessageMetaPanel,
  MessageRecord
} from "../types";

export interface RepairedConversationRecord {
  conversation: ConversationRecord;
  repaired: boolean;
}

export function compareConversations(left: ConversationRecord, right: ConversationRecord): number {
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1;
  }
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return right.createdAt - left.createdAt;
}

export function compareFolders(left: ConversationFolderSummary, right: ConversationFolderSummary): number {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  return left.name.localeCompare(right.name);
}

export function normalizeFolderName(name: string): string {
  return sanitizeFileName(name).replace(/-/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function normalizeConversationTitle(title: string): string {
  return sanitizeFileName(title).replace(/-/g, " ").trim();
}

export function buildConversationTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 18 ? `${collapsed.slice(0, 18)}…` : collapsed || UNTITLED_CONVERSATION_TITLE;
}

export function cloneConversation(conversation: ConversationRecord): ConversationRecord {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => cloneMessage(message))
  };
}

export function toConversationSummary(conversation: ConversationRecord): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    isPinned: conversation.isPinned,
    isArchived: conversation.isArchived === true,
    archivedAt: conversation.isArchived === true ? conversation.archivedAt ?? null : null,
    folderId: conversation.folderId ?? null,
    messageCount: conversation.messages.length
  };
}

export function getOrderedConversations(conversations: Iterable<ConversationRecord>): ConversationRecord[] {
  return Array.from(conversations).sort(compareConversations);
}

export function buildFolderSummaries(
  folders: Iterable<ConversationFolderRecord>,
  conversations: Iterable<ConversationRecord>
): ConversationFolderSummary[] {
  const summaries = new Map<string, ConversationFolderSummary>();
  for (const folder of folders) {
    summaries.set(folder.id, {
      id: folder.id,
      name: folder.name,
      updatedAt: folder.updatedAt,
      conversationCount: 0
    });
  }

  for (const conversation of conversations) {
    if (!conversation.folderId || conversation.isArchived) {
      continue;
    }
    const summary = summaries.get(conversation.folderId);
    if (!summary) {
      continue;
    }
    summary.conversationCount += 1;
    summary.updatedAt = Math.max(summary.updatedAt, conversation.updatedAt);
  }

  return Array.from(summaries.values()).sort(compareFolders);
}

export function repairFolderRecord(
  folder: ConversationFolderRecord,
  fallbackTimestamp: number
): ConversationFolderRecord | null {
  if (!folder || typeof folder.id !== "string" || !folder.id.trim()) {
    return null;
  }

  const name = normalizeFolderName(typeof folder.name === "string" ? folder.name : "");
  if (!name) {
    return null;
  }

  const createdAt = typeof folder.createdAt === "number" && Number.isFinite(folder.createdAt)
    ? folder.createdAt
    : fallbackTimestamp;
  const updatedAt = typeof folder.updatedAt === "number" && Number.isFinite(folder.updatedAt)
    ? folder.updatedAt
    : createdAt;
  const normalizedId = folder.id.trim();

  if (
    folder.id === normalizedId &&
    folder.name === name &&
    folder.createdAt === createdAt &&
    folder.updatedAt === updatedAt
  ) {
    return folder;
  }

  return {
    id: normalizedId,
    name,
    createdAt,
    updatedAt
  };
}

export function repairConversationRecord(
  conversation: ConversationRecord,
  validFolderIds: ReadonlySet<string>
): RepairedConversationRecord {
  let repaired = false;
  const sourceMessages = Array.isArray(conversation.messages) ? conversation.messages : [];
  if (sourceMessages !== conversation.messages) {
    repaired = true;
  }

  const repairedMessages: MessageRecord[] = [];
  for (const message of sourceMessages) {
    const normalizedMessage: MessageRecord = {
      ...message,
      reasoningText: typeof message.reasoningText === "string" ? message.reasoningText : undefined,
      reasoningLabel: typeof message.reasoningLabel === "string" ? message.reasoningLabel : undefined,
      metaPanels: normalizeMetaPanels(message.metaPanels)
    };
    if (
      normalizedMessage.reasoningText !== message.reasoningText
      || normalizedMessage.reasoningLabel !== message.reasoningLabel
      || normalizedMessage.metaPanels !== message.metaPanels
    ) {
      repaired = true;
    }

    if (normalizedMessage.status !== "streaming") {
      repairedMessages.push(normalizedMessage);
      continue;
    }

    repaired = true;
    if (!normalizedMessage.text.trim() && !normalizedMessage.reasoningText?.trim()) {
      continue;
    }

    repairedMessages.push({
      ...normalizedMessage,
      status: "error"
    });
  }

  const repairedTitle =
    (typeof conversation.title === "string" ? conversation.title.trim() : "") || UNTITLED_CONVERSATION_TITLE;
  if (repairedTitle !== conversation.title) {
    repaired = true;
  }

  const repairedIsPinned = conversation.isPinned === true;
  if (repairedIsPinned !== conversation.isPinned) {
    repaired = true;
  }

  const repairedIsArchived = conversation.isArchived === true;
  if (repairedIsArchived !== conversation.isArchived) {
    repaired = true;
  }

  const archivedAtFallback = typeof conversation.updatedAt === "number" && Number.isFinite(conversation.updatedAt)
    ? conversation.updatedAt
    : Date.now();
  const repairedArchivedAt = repairedIsArchived
    ? (typeof conversation.archivedAt === "number" && Number.isFinite(conversation.archivedAt)
      ? conversation.archivedAt
      : archivedAtFallback)
    : null;
  if ((conversation.archivedAt ?? null) !== repairedArchivedAt) {
    repaired = true;
  }

  const repairedFolderId = resolveConversationFolderId(conversation.folderId, validFolderIds);
  if ((conversation.folderId ?? null) !== repairedFolderId) {
    repaired = true;
  }

  const repairedDraft = typeof conversation.draft === "string" ? conversation.draft : undefined;
  if (repairedDraft !== conversation.draft) {
    repaired = true;
  }

  const repairedModelConfigId = typeof conversation.modelConfigId === "string" && conversation.modelConfigId.trim().length > 0
    ? conversation.modelConfigId.trim()
    : null;
  if ((conversation.modelConfigId ?? null) !== repairedModelConfigId) {
    repaired = true;
  }

  const normalizedConversation: ConversationRecord = {
    ...conversation,
    title: repairedTitle,
    isPinned: repairedIsPinned,
    isArchived: repairedIsArchived,
    archivedAt: repairedArchivedAt,
    folderId: repairedFolderId,
    draft: repairedDraft,
    modelConfigId: repairedModelConfigId,
    messages: repairedMessages
  };

  return {
    conversation: normalizedConversation,
    repaired
  };
}

function cloneMessage(message: MessageRecord): MessageRecord {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    knowledgeBaseRouting: message.knowledgeBaseRouting
      ? {
          ...message.knowledgeBaseRouting,
          hits: message.knowledgeBaseRouting.hits.map((hit) => ({ ...hit }))
        }
      : undefined,
    metaPanels: message.metaPanels?.map((panel) => ({
      ...panel,
      sources: panel.sources?.map((source) => ({ ...source }))
    }))
  };
}

function normalizeMetaPanels(metaPanels: unknown): MessageMetaPanel[] | undefined {
  if (!Array.isArray(metaPanels)) {
    return undefined;
  }

  let changed = false;
  const normalizedPanels: MessageMetaPanel[] = [];
  for (const panel of metaPanels) {
    const normalizedPanel = normalizeMetaPanel(panel);
    if (!normalizedPanel) {
      changed = true;
      continue;
    }
    if (normalizedPanel !== panel) {
      changed = true;
    }
    normalizedPanels.push(normalizedPanel);
  }

  if (normalizedPanels.length === 0) {
    return undefined;
  }

  return changed ? normalizedPanels : metaPanels as MessageMetaPanel[];
}

function normalizeMetaPanel(panel: unknown): MessageMetaPanel | null {
  if (!panel || typeof panel !== "object") {
    return null;
  }

  const candidate = panel as Partial<MessageMetaPanel>;
  const kind = typeof candidate.kind === "string" ? candidate.kind.trim() : "";
  const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
  const text = typeof candidate.text === "string" && candidate.text.trim()
    ? candidate.text
    : undefined;
  const display = normalizeMetaPanelDisplay(candidate.display);
  const group = typeof candidate.group === "string" && candidate.group.trim()
    ? candidate.group.trim()
    : undefined;
  const groupLabel = typeof candidate.groupLabel === "string" && candidate.groupLabel.trim()
    ? candidate.groupLabel.trim()
    : undefined;
  let sourcesChanged = false;
  const sources = Array.isArray(candidate.sources)
    ? candidate.sources
      .map((source) => {
        if (!source || typeof source !== "object") {
          sourcesChanged = true;
          return null;
        }
        const title = typeof source.title === "string" ? source.title.trim() : "";
        if (!title) {
          sourcesChanged = true;
          return null;
        }
        const url = typeof source.url === "string" && source.url.trim() ? source.url.trim() : undefined;
        const host = typeof source.host === "string" && source.host.trim() ? source.host.trim() : undefined;
        const note = typeof source.note === "string" && source.note.trim() ? source.note.trim() : undefined;
        if (
          title !== source.title
          || url !== source.url
          || host !== source.host
          || note !== source.note
        ) {
          sourcesChanged = true;
        }
        return { title, url, host, note };
      })
      .filter((source): source is NonNullable<typeof source> => source !== null)
    : undefined;

  if (!kind || !label || (!text && (!sources || sources.length === 0))) {
    return null;
  }

  if (
    kind === candidate.kind
    && label === candidate.label
    && text === candidate.text
    && display === candidate.display
    && group === candidate.group
    && groupLabel === candidate.groupLabel
    && !sourcesChanged
    && sources?.length === candidate.sources?.length
  ) {
    return candidate as MessageMetaPanel;
  }

  return {
    kind,
    label,
    text,
    sources: sources && sources.length > 0 ? sources : undefined,
    display,
    group,
    groupLabel
  };
}

function normalizeMetaPanelDisplay(display: unknown): MessageMetaPanelDisplay | undefined {
  if (display === "panel" || display === "status" || display === "step") {
    return display;
  }
  return undefined;
}

function resolveConversationFolderId(
  folderId: string | null | undefined,
  validFolderIds: ReadonlySet<string>
): string | null {
  if (typeof folderId !== "string") {
    return null;
  }
  const normalizedFolderId = folderId.trim();
  return validFolderIds.has(normalizedFolderId) ? normalizedFolderId : null;
}
