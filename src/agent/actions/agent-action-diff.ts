/**
 * 写入提案卡的纯逻辑：路径拆分、行级差异、改动量与稳定签名。
 *
 * 这一层不依赖 Obsidian，也不碰 DOM；卡片和调整弹窗只消费这里的结果。
 * 差异按“行”比较，不做字符级高亮，保证长中文笔记也能稳定显示。
 */

export interface AgentActionPathDisplay {
  /** 目录段，带结尾斜杠；笔记在库根时为空。 */
  folder: string;
  fileName: string;
  fullPath: string;
  isRoot: boolean;
}

export interface AgentActionDiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

export type AgentActionDiffEntry =
  | { kind: "line"; line: AgentActionDiffLine }
  | { kind: "gap"; skipped: number; label?: string };

export interface AgentActionDiff {
  entries: AgentActionDiffEntry[];
  added: number;
  removed: number;
  /** 行数过多、主动放弃完整差异时置位；此时 entries 为空。 */
  truncated: boolean;
}

export interface AgentActionChangeStats {
  added: number;
  removed: number;
  truncated: boolean;
}

export interface AgentActionMarkdownParts {
  frontmatter: string | null;
  body: string;
}

interface DiffOp {
  type: "equal" | "add" | "remove";
  text: string;
}

const DIFF_CONTEXT_LINES = 3;
/** 超过这个规模的中间段不再做 LCS，避免长笔记把界面卡住。 */
const MAX_DIFF_CELLS = 4_000_000;

export function formatAgentActionPath(rawPath: string): AgentActionPathDisplay {
  const normalized = rawPath
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (!normalized) {
    return { folder: "", fileName: "", fullPath: "", isRoot: true };
  }
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex < 0) {
    return {
      folder: "",
      fileName: normalized,
      fullPath: normalized,
      isRoot: true
    };
  }
  return {
    folder: normalized.slice(0, separatorIndex + 1),
    fileName: normalized.slice(separatorIndex + 1),
    fullPath: normalized,
    isRoot: false
  };
}

export function countAgentActionLines(text: string): number {
  return splitLines(text).length;
}

export function splitAgentActionFrontmatter(markdown: string): AgentActionMarkdownParts {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: null, body: normalized };
  }
  const closingIndex = normalized.indexOf("\n---", 4);
  if (closingIndex < 0) {
    return { frontmatter: null, body: normalized };
  }
  const after = normalized.slice(closingIndex + "\n---".length);
  if (after && !after.startsWith("\n")) {
    return { frontmatter: null, body: normalized };
  }
  return {
    frontmatter: normalized.slice("---\n".length, closingIndex),
    body: after.replace(/^\n/, "")
  };
}

export function buildAgentActionSignature(input: {
  kind: string;
  targetPath: string;
  content: string;
}): string {
  const source = `${input.kind}\u0000${input.targetPath}\u0000${input.content}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${input.kind}:${input.targetPath}:${(hash >>> 0).toString(36)}`;
}

export function computeAgentActionDiff(
  existing: string,
  next: string,
  options: { contextLines?: number } = {}
): AgentActionDiff {
  const contextLines = options.contextLines ?? DIFF_CONTEXT_LINES;
  const oldLines = splitLines(existing);
  const newLines = splitLines(next);
  const prefixLength = findCommonPrefixLength(oldLines, newLines);
  const suffixLength = findCommonSuffixLength(oldLines, newLines, prefixLength);
  const oldMiddle = oldLines.slice(prefixLength, oldLines.length - suffixLength);
  const newMiddle = newLines.slice(prefixLength, newLines.length - suffixLength);

  if (oldMiddle.length * newMiddle.length > MAX_DIFF_CELLS) {
    return {
      entries: [],
      added: newLines.length,
      removed: oldLines.length,
      truncated: true
    };
  }

  const middleOps = buildDiffOps(oldMiddle, newMiddle);
  const ops: DiffOp[] = [
    ...oldLines.slice(0, prefixLength).map((text): DiffOp => ({ type: "equal", text })),
    ...middleOps,
    ...oldLines.slice(oldLines.length - suffixLength).map((text): DiffOp => ({ type: "equal", text }))
  ];
  const added = middleOps.filter((op) => op.type === "add").length;
  const removed = middleOps.filter((op) => op.type === "remove").length;
  return {
    entries: buildDiffEntries(ops, contextLines),
    added,
    removed,
    truncated: false
  };
}

export function buildAgentActionAppendDiff(
  existing: string,
  next: string,
  options: { contextLines?: number } = {}
): AgentActionDiff {
  const contextLines = options.contextLines ?? DIFF_CONTEXT_LINES;
  const oldLines = splitLines(existing);
  const nextLines = splitLines(next);
  const contextStart = Math.max(0, oldLines.length - contextLines);
  const entries: AgentActionDiffEntry[] = [];
  if (contextStart > 0) {
    entries.push({
      kind: "gap",
      skipped: contextStart,
      label: `… 原文前面 ${contextStart} 行未变 …`
    });
  }
  for (const line of oldLines.slice(contextStart)) {
    entries.push({ kind: "line", line: { type: "context", text: line } });
  }
  for (const line of nextLines) {
    entries.push({ kind: "line", line: { type: "add", text: line } });
  }
  return {
    entries,
    added: nextLines.length,
    removed: 0,
    truncated: false
  };
}

export function toAgentActionChangeStats(diff: AgentActionDiff): AgentActionChangeStats {
  return {
    added: diff.added,
    removed: diff.removed,
    truncated: diff.truncated
  };
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized) {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function findCommonPrefixLength(left: string[], right: string[]): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findCommonSuffixLength(left: string[], right: string[], prefixLength: number): number {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let count = 0;
  while (count < limit && left[left.length - 1 - count] === right[right.length - 1 - count]) {
    count += 1;
  }
  return count;
}

function buildDiffOps(oldLines: string[], newLines: string[]): DiffOp[] {
  if (oldLines.length === 0) {
    return newLines.map((text): DiffOp => ({ type: "add", text }));
  }
  if (newLines.length === 0) {
    return oldLines.map((text): DiffOp => ({ type: "remove", text }));
  }

  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex * width + newIndex] = oldLines[oldIndex] === newLines[newIndex]
        ? table[(oldIndex + 1) * width + newIndex + 1] + 1
        : Math.max(table[(oldIndex + 1) * width + newIndex], table[oldIndex * width + newIndex + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      ops.push({ type: "equal", text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[(oldIndex + 1) * width + newIndex] >= table[oldIndex * width + newIndex + 1]) {
      ops.push({ type: "remove", text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      ops.push({ type: "add", text: newLines[newIndex] });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    ops.push({ type: "remove", text: oldLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    ops.push({ type: "add", text: newLines[newIndex] });
    newIndex += 1;
  }
  return ops;
}

function buildDiffEntries(ops: DiffOp[], contextLines: number): AgentActionDiffEntry[] {
  const changeIndices: number[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].type !== "equal") {
      changeIndices.push(index);
    }
  }
  if (changeIndices.length === 0) {
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  for (const changeIndex of changeIndices) {
    const start = Math.max(0, changeIndex - contextLines);
    const end = Math.min(ops.length, changeIndex + contextLines + 1);
    const lastRange = ranges[ranges.length - 1];
    if (lastRange && start <= lastRange.end) {
      lastRange.end = Math.max(lastRange.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const entries: AgentActionDiffEntry[] = [];
  let coveredUntil = 0;
  for (const range of ranges) {
    if (range.start > coveredUntil) {
      entries.push({ kind: "gap", skipped: range.start - coveredUntil });
    }
    for (let index = range.start; index < range.end; index += 1) {
      const op = ops[index];
      entries.push({
        kind: "line",
        line: {
          type: op.type === "equal" ? "context" : op.type === "remove" ? "remove" : "add",
          text: op.text
        }
      });
    }
    coveredUntil = range.end;
  }
  if (coveredUntil < ops.length) {
    entries.push({ kind: "gap", skipped: ops.length - coveredUntil });
  }
  return entries;
}
