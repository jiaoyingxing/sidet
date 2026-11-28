/**
 * Markdown 反引号围栏的行级判断。
 *
 * 流式输出和旧消息清理都需要回答同一个问题：结尾这行三反引号是「打开代码块」
 * 还是「关闭代码块」。只看行首（最多 3 个空格缩进）的围栏；行内三反引号是
 * 代码内容，不参与状态。
 */
const FENCE_LINE_PATTERN = /^[ \t]{0,3}(`{3,})([^\r\n]*)$/;

function findLineStart(text: string, index: number): number {
  const newline = text.lastIndexOf("\n", index - 1);
  return newline < 0 ? 0 : newline + 1;
}

/** index 处是否是行首围栏：前面只有行首缩进，不是正文里的行内反引号。 */
export function isFenceLineAt(text: string, index: number): boolean {
  const lineStart = findLineStart(text, index);
  return /^[ \t]{0,3}$/.test(text.slice(lineStart, index));
}

/** index 处的围栏之前是否已经有一个未闭合的代码块。 */
export function isInsideFencedBlockAt(text: string, fenceIndex: number): boolean {
  if (!isFenceLineAt(text, fenceIndex)) {
    return false;
  }
  const lineStart = findLineStart(text, fenceIndex);
  let openFence: string | null = null;
  for (const line of text.slice(0, lineStart).split(/\r?\n/)) {
    const match = line.match(FENCE_LINE_PATTERN);
    if (!match) {
      continue;
    }
    const fence = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    if (openFence === null) {
      openFence = fence;
    } else if (info === "" && fence.length >= openFence.length) {
      openFence = null;
    }
  }
  return openFence !== null;
}

/**
 * 去掉正文末尾没配对的裸围栏。
 *
 * 流式输出会在协议块标签还没到齐时把「```」先写进消息；落库后它渲染成一张
 * 空代码块（带宿主复制按钮）。只删「行首、无语言、前面没有未闭合围栏」的
 * 尾围栏；合法代码块的闭合围栏保留。
 */
export function stripTrailingUnclosedFence(markdown: string): string {
  const trimmed = markdown.trimEnd();
  const fenceIndex = trimmed.lastIndexOf("```");
  if (fenceIndex < 0) {
    return trimmed;
  }
  const tail = trimmed.slice(fenceIndex);
  if (!/^`{3,}[ \t]*$/.test(tail)) {
    return trimmed;
  }
  if (!isFenceLineAt(trimmed, fenceIndex) || isInsideFencedBlockAt(trimmed, fenceIndex)) {
    return trimmed;
  }
  return trimmed.slice(0, fenceIndex).trimEnd();
}
