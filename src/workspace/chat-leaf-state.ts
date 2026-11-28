import { WorkspaceLeaf } from "obsidian";
import type { ChatLeafState } from "../types";

export const CHAT_LEAF_EPHEMERAL_KEY = "sidetChatLeafState";

export type ChatLeafModeState = Pick<ChatLeafState, "webSearchEnabled">;

export function createDefaultChatLeafState(): ChatLeafState {
  return {
    conversationId: null,
    draft: "",
    modelConfigId: null,
    webSearchEnabled: false
  };
}

export function resolveChatLeafModeState(state: Partial<ChatLeafState> | null | undefined): ChatLeafModeState {
  const source = state ?? {};
  return {
    webSearchEnabled: source.webSearchEnabled === true
  };
}

export function createFreshChatLeafState(
  modeState?: Partial<ChatLeafState> | null,
  modelConfigId?: string | null
): ChatLeafState {
  return {
    ...createDefaultChatLeafState(),
    modelConfigId: typeof modelConfigId === "string" && modelConfigId.trim().length > 0
      ? modelConfigId.trim()
      : null,
    ...resolveChatLeafModeState(modeState)
  };
}

export function createConversationChatLeafState(
  conversationId: string | null | undefined,
  draft: string | null | undefined,
  modeState?: Partial<ChatLeafState> | null,
  modelConfigId?: string | null
): ChatLeafState {
  return {
    conversationId: typeof conversationId === "string" && conversationId.trim().length > 0
      ? conversationId
      : null,
    draft: typeof draft === "string" ? draft : "",
    modelConfigId: typeof modelConfigId === "string" && modelConfigId.trim().length > 0
      ? modelConfigId.trim()
      : null,
    ...resolveChatLeafModeState(modeState)
  };
}

export function normalizeChatLeafState(state: unknown): ChatLeafState {
  const source = (state ?? {}) as Partial<ChatLeafState>;
  return {
    conversationId: typeof source.conversationId === "string" && source.conversationId.trim().length > 0
      ? source.conversationId
      : null,
    draft: typeof source.draft === "string" ? source.draft : "",
    modelConfigId: typeof source.modelConfigId === "string" && source.modelConfigId.trim().length > 0
      ? source.modelConfigId.trim()
      : null,
    webSearchEnabled: source.webSearchEnabled === true
  };
}

export function areChatLeafStatesEqual(left: ChatLeafState, right: ChatLeafState): boolean {
  return left.conversationId === right.conversationId
    && left.draft === right.draft
    && left.modelConfigId === right.modelConfigId
    && left.webSearchEnabled === right.webSearchEnabled;
}

export function readEphemeralChatLeafState(leaf: WorkspaceLeaf): ChatLeafState | null {
  const ephemeral: unknown = leaf.getEphemeralState();
  if (!ephemeral || typeof ephemeral !== "object") {
    return null;
  }

  const value = (ephemeral as Record<string, unknown>)[CHAT_LEAF_EPHEMERAL_KEY];
  if (value === undefined) {
    return null;
  }
  return normalizeChatLeafState(value);
}

export function resolveChatLeafStateSnapshot(leaf: WorkspaceLeaf, rawState?: unknown): ChatLeafState {
  return readEphemeralChatLeafState(leaf) ?? normalizeChatLeafState(rawState ?? leaf.getViewState().state);
}

export function writeEphemeralChatLeafState(leaf: WorkspaceLeaf, state: ChatLeafState): void {
  const ephemeral: unknown = leaf.getEphemeralState();
  if (!ephemeral || typeof ephemeral !== "object") {
    leaf.setEphemeralState({
      [CHAT_LEAF_EPHEMERAL_KEY]: state
    });
    return;
  }

  leaf.setEphemeralState({
    ...ephemeral,
    [CHAT_LEAF_EPHEMERAL_KEY]: state
  });
}
