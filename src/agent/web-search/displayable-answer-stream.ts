import { stripSidetProtocolBlocks } from "./sidet-protocol";

const SIDET_PROTOCOL_PREFIX = "```sidet-";

export function looksLikeSidetProtocolPreamble(rawContent: string): boolean {
  const trimmed = rawContent.trimStart();
  if (!trimmed) {
    return true;
  }
  return SIDET_PROTOCOL_PREFIX.startsWith(trimmed) || trimmed.startsWith(SIDET_PROTOCOL_PREFIX);
}

function findUnfinishedProtocolStart(rawContent: string): number | null {
  const lastFullProtocolStart = rawContent.lastIndexOf(SIDET_PROTOCOL_PREFIX);
  if (lastFullProtocolStart >= 0) {
    const closingFence = rawContent.indexOf("```", lastFullProtocolStart + SIDET_PROTOCOL_PREFIX.length);
    if (closingFence < 0) {
      return lastFullProtocolStart;
    }
  }

  const lastFence = rawContent.lastIndexOf("```");
  if (lastFence < 0) {
    return null;
  }

  if (lastFullProtocolStart >= 0) {
    const closingFence = rawContent.indexOf("```", lastFullProtocolStart + SIDET_PROTOCOL_PREFIX.length);
    if (closingFence === lastFence) {
      return null;
    }
  }

  const tail = rawContent.slice(lastFence);
  return SIDET_PROTOCOL_PREFIX.startsWith(tail) ? lastFence : null;
}

export function computeDisplayableAnswerText(rawContent: string): string {
  const unfinishedProtocolStart = findUnfinishedProtocolStart(rawContent);
  const visibleSource = unfinishedProtocolStart === null
    ? rawContent
    : rawContent.slice(0, unfinishedProtocolStart);
  return stripSidetProtocolBlocks(visibleSource);
}

export function createDisplayableAnswerStreamer(emitChunk: (chunk: string) => void): {
  sync: (rawContent: string) => string;
  finish: (rawContent: string) => string;
} {
  let emittedLength = 0;

  const emitVisibleDiff = (visibleText: string): string => {
    const nextChunk = visibleText.slice(emittedLength);
    if (!nextChunk) {
      return visibleText;
    }
    emittedLength = visibleText.length;
    emitChunk(nextChunk);
    return visibleText;
  };

  return {
    sync: (rawContent) => emitVisibleDiff(computeDisplayableAnswerText(rawContent)),
    finish: (rawContent) => emitVisibleDiff(computeDisplayableAnswerText(rawContent))
  };
}
