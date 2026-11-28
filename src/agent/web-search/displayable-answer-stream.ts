import { isFenceLineAt, isInsideFencedBlockAt } from "../../shared/markdown-fence";
import { stripSidetProtocolBlocks } from "./sidet-protocol";

const SIDET_PROTOCOL_PREFIX = "```sidet-";
const RESEARCH_PROTOCOL_PREFIXES = [
  "```sidet-research",
  "```sidet-search",
  "```sidet-fetch",
  "sidet-research",
  "sidet-search",
  "sidet-fetch"
];

export function looksLikeSidetProtocolPreamble(rawContent: string): boolean {
  const trimmed = rawContent.trimStart();
  if (!trimmed) {
    return true;
  }
  return SIDET_PROTOCOL_PREFIX.startsWith(trimmed) || trimmed.startsWith(SIDET_PROTOCOL_PREFIX);
}

/**
 * 研究决策阶段只可能是“最终答复”或 `sidet-research` 协议块。正文在第一个非协议
 * 字符到达前先压住，避免没有围栏的裸协议头（由补正环节处理）泄漏到消息正文。
 */
export function looksLikeResearchProtocolPreamble(rawContent: string): boolean {
  const trimmed = rawContent.trimStart().toLowerCase();
  if (!trimmed) {
    return true;
  }
  return RESEARCH_PROTOCOL_PREFIXES.some(
    (prefix) => prefix.startsWith(trimmed) || trimmed.startsWith(prefix)
  );
}

const TAIL_LINE_PATTERN = /(?:^|\n)([ \t]{0,3})(`+)([^\r\n]*)$/;

function findUnfinishedProtocolStart(rawContent: string): number | null {
  const lastFullProtocolStart = rawContent.lastIndexOf(SIDET_PROTOCOL_PREFIX);
  if (
    lastFullProtocolStart >= 0
    && isFenceLineAt(rawContent, lastFullProtocolStart)
    && !isInsideFencedBlockAt(rawContent, lastFullProtocolStart)
  ) {
    const closingFence = rawContent.indexOf("```", lastFullProtocolStart + SIDET_PROTOCOL_PREFIX.length);
    if (closingFence < 0) {
      return lastFullProtocolStart;
    }
  }

  const tailMatch = rawContent.match(TAIL_LINE_PATTERN);
  if (!tailMatch) {
    return null;
  }
  const tailFence = tailMatch[2] ?? "";
  const tailInfo = (tailMatch[3] ?? "").trim();
  const tailStart = rawContent.length - tailFence.length - (tailMatch[3] ?? "").length;
  // 前面已有未闭合代码块：这是闭合围栏，正文以代码块结尾时必须保留。
  if (isInsideFencedBlockAt(rawContent, tailStart)) {
    return null;
  }

  if (tailFence.length < 3) {
    // 1-2 个反引号也可能是围栏的前半截；只有这一行还没写别的内容时先压住，
    // 出现行内文字就按普通行内代码放行。
    return tailInfo === "" ? tailStart : null;
  }

  // 行首的裸围栏可能是协议块开头（标签还在路上），先压住；普通语言标记
  // （js / markdown）不是协议头，立即放行。否则半截围栏会写进正文，
  // 落库后渲染成一张空代码块。
  return tailInfo === "" || "sidet-".startsWith(tailInfo) ? tailStart : null;
}

export function computeDisplayableAnswerText(rawContent: string): string {
  const unfinishedProtocolStart = findUnfinishedProtocolStart(rawContent);
  const visibleSource = unfinishedProtocolStart === null
    ? rawContent
    : rawContent.slice(0, unfinishedProtocolStart);
  return stripSidetProtocolBlocks(visibleSource);
}

export function createDisplayableAnswerStreamer(
  emitChunk: (chunk: string) => void,
  options: { holdResearchProtocolPreamble?: boolean } = {}
): {
  sync: (rawContent: string) => string;
  finish: (rawContent: string) => string;
} {
  let emittedText = "";
  let preambleReleased = options.holdResearchProtocolPreamble !== true;

  const emitVisibleDiff = (visibleText: string): string => {
    if (!preambleReleased) {
      if (looksLikeResearchProtocolPreamble(visibleText)) {
        return visibleText;
      }
      preambleReleased = true;
    }
    if (visibleText.length < emittedText.length) {
      // 协议块被隐藏后可见文本会变短：已写进消息的内容收不回来，只把基线
      // 拉回当前可见文本，避免下一段正文从旧偏移续切、吞掉开头几个字。
      emittedText = visibleText;
      return visibleText;
    }
    const nextChunk = visibleText.slice(emittedText.length);
    if (!nextChunk) {
      emittedText = visibleText;
      return visibleText;
    }
    emittedText = visibleText;
    emitChunk(nextChunk);
    return visibleText;
  };

  return {
    sync: (rawContent) => emitVisibleDiff(computeDisplayableAnswerText(rawContent)),
    finish: (rawContent) => emitVisibleDiff(computeDisplayableAnswerText(rawContent))
  };
}
