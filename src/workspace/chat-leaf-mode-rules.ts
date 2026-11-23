import { ALL_KNOWLEDGE_BASES_DISPLAY_NAME, ALL_KNOWLEDGE_BASES_SELECTION } from "../constants";
import type { ChatLeafState } from "../types";
import type { WikiKnowledgeBaseInfo } from "../agent/wiki/wiki-memory-index";

export interface SelectedKnowledgeBaseState {
  mode: "none" | "all" | "single";
  indexPath: string | null;
  displayName: string | null;
  knowledgeBase: WikiKnowledgeBaseInfo | null;
}

export function normalizeKnowledgeBaseIndexPath(
  value: string | null | undefined
): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function applyKnowledgeBaseSelection(
  state: ChatLeafState,
  indexPath: string | null | undefined
): ChatLeafState {
  const normalizedIndexPath = normalizeKnowledgeBaseIndexPath(indexPath);
  return {
    ...state,
    knowledgeBaseIndexPath: normalizedIndexPath,
    webSearchEnabled: normalizedIndexPath ? false : state.webSearchEnabled
  };
}

export function applyWebSearchEnabled(
  state: ChatLeafState,
  enabled: boolean
): ChatLeafState {
  const nextEnabled = enabled === true;
  return {
    ...state,
    webSearchEnabled: nextEnabled,
    knowledgeBaseIndexPath: nextEnabled ? null : state.knowledgeBaseIndexPath
  };
}

export function resolveSelectedKnowledgeBaseState(
  indexPath: string | null | undefined,
  findKnowledgeBase: (indexPath: string) => WikiKnowledgeBaseInfo | null
): SelectedKnowledgeBaseState {
  const normalizedIndexPath = normalizeKnowledgeBaseIndexPath(indexPath);
  if (!normalizedIndexPath) {
    return {
      mode: "none",
      indexPath: null,
      displayName: null,
      knowledgeBase: null
    };
  }

  if (normalizedIndexPath === ALL_KNOWLEDGE_BASES_SELECTION) {
    return {
      mode: "all",
      indexPath: ALL_KNOWLEDGE_BASES_SELECTION,
      displayName: ALL_KNOWLEDGE_BASES_DISPLAY_NAME,
      knowledgeBase: null
    };
  }

  const knowledgeBase = findKnowledgeBase(normalizedIndexPath);
  if (!knowledgeBase) {
    return {
      mode: "none",
      indexPath: null,
      displayName: null,
      knowledgeBase: null
    };
  }

  return {
    mode: "single",
    indexPath: knowledgeBase.indexPath,
    displayName: knowledgeBase.displayName,
    knowledgeBase
  };
}
