import type { ChatLeafState } from "../types";

export function applyWebSearchEnabled(
  state: ChatLeafState,
  enabled: boolean
): ChatLeafState {
  return {
    ...state,
    webSearchEnabled: enabled === true
  };
}
