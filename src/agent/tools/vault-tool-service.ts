import { prepareSimpleSearch, TFile } from "obsidian";
import type { App, CachedMetadata, SearchResult } from "obsidian";
import {
  MAX_AGENT_TOOL_LINK_RESULTS,
  MAX_AGENT_TOOL_RESULT_CHARS,
  MAX_AGENT_TOOL_SEARCH_FILES,
  MAX_AGENT_TOOL_SEARCH_RESULTS
} from "../../constants";
import type {
  AgentToolExecutionResult,
  AgentToolInvocation,
  AgentToolName,
  AgentToolStatus
} from "./tool-types";

/**
 * 首版护栏内的单文件读取上限；这是检索成本护栏，不是笔记长度限制。
 */
const MAX_AGENT_TOOL_SEARCH_FILE_CHARS = 120_000;
const MAX_AGENT_TOOL_SEARCH_SNIPPET_CHARS = 160;
const HEADING_LINE_PATTERN = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/;

export interface VaultToolServiceOptions {
  app: App;
}

interface NoteSearchHit {
  path: string;
  titleHit: boolean;
  score: number;
  mtime: number;
  snippet: string;
}

interface NoteLinkEntry {
  path: string;
  basename: string;
  resolved: boolean;
}

interface HeadingLineEntry {
  lineIndex: number;
  level: number;
  text: string;
}

type LinkResolver = (linkpath: string, sourcePath: string) => TFile | null;

/**
 * 三个只读 Vault 工具的执行层。
 *
 * 只依赖注入的 `App`，不读写工作区状态、不发网络请求、
 * 不接入 ChatView / WorkspaceController / ConversationSession。
 * `web_research` 由对话运行时的组合执行器承接；这里命中只说明发生了误路由。
 */
export class VaultToolService {
  constructor(private readonly options: VaultToolServiceOptions) {}

  async execute(invocation: AgentToolInvocation): Promise<AgentToolExecutionResult> {
    switch (invocation.tool) {
      case "search_notes":
        return this.runSearchNotes(invocation);
      case "read_note":
        return this.runReadNote(invocation);
      case "note_links":
        return this.runNoteLinks(invocation);
      case "web_research":
        return this.result("web_research", "error", "联网工具需要在对话运行时执行。");
      default: {
        const unreachable: never = invocation.tool;
        throw new Error(`未知工具：${String(unreachable)}`);
      }
    }
  }

  private async runSearchNotes(invocation: AgentToolInvocation): Promise<AgentToolExecutionResult> {
    const query = invocation.query?.trim() ?? "";
    if (!query) {
      return this.result("search_notes", "error", "缺少 query，无法检索笔记。");
    }

    const searcher = prepareSimpleSearch(query);
    const allFiles = this.options.app.vault.getMarkdownFiles();
    const titleScores = new Map<string, number>();
    for (const file of allFiles) {
      const titleResult = searcher(`${file.basename}\n${file.path}`);
      if (titleResult) {
        titleScores.set(file.path, titleResult.score);
      }
    }

    // 标题 / 路径命中先进入有界扫描窗口，窗口内再逐个读取正文（读取才计入 400 篇上界）。
    const scopedFiles = [...allFiles]
      .sort((left, right) =>
        Number(titleScores.has(right.path)) - Number(titleScores.has(left.path))
        || right.stat.mtime - left.stat.mtime
        || left.path.localeCompare(right.path)
      )
      .slice(0, MAX_AGENT_TOOL_SEARCH_FILES);
    const limit = clampSearchLimit(invocation.limit);

    const hits: NoteSearchHit[] = [];
    for (const file of scopedFiles) {
      let content = "";
      try {
        content = (await this.options.app.vault.cachedRead(file)).slice(0, MAX_AGENT_TOOL_SEARCH_FILE_CHARS);
      } catch {
        continue;
      }

      const bodyResult = searcher(content);
      const titleHit = titleScores.has(file.path);
      if (!bodyResult && !titleHit) {
        continue;
      }

      hits.push({
        path: file.path,
        titleHit,
        score: bodyResult?.score ?? titleScores.get(file.path) ?? 0,
        mtime: file.stat.mtime,
        snippet: bodyResult ? buildSearchSnippet(content, bodyResult) : buildFallbackSnippet(content)
      });
    }

    hits.sort((left, right) =>
      Number(right.titleHit) - Number(left.titleHit)
      || right.score - left.score
      || right.mtime - left.mtime
      || left.path.localeCompare(right.path)
    );
    const visibleHits = hits.slice(0, limit);
    if (visibleHits.length === 0) {
      return this.result(
        "search_notes",
        "ok",
        `没有找到匹配「${query}」的 Markdown 笔记。可以换用更具体的关键词、文件名或英文原词再试。`
      );
    }

    const lines = [`命中 ${visibleHits.length} 篇笔记（最多 ${limit} 篇）。`];
    if (allFiles.length > MAX_AGENT_TOOL_SEARCH_FILES) {
      lines.push(`扫描范围：最多 ${MAX_AGENT_TOOL_SEARCH_FILES} 篇 Markdown 笔记（标题 / 路径命中优先）。`);
    }
    lines.push("");
    visibleHits.forEach((hit, index) => {
      lines.push(
        `${index + 1}. ${hit.path}${hit.titleHit ? "（标题 / 路径命中）" : ""}`,
        `   片段：${hit.snippet}`
      );
    });
    return this.result("search_notes", "ok", lines.join("\n"));
  }

  private async runReadNote(invocation: AgentToolInvocation): Promise<AgentToolExecutionResult> {
    const rawPath = invocation.path?.trim() ?? "";
    if (!rawPath) {
      return this.result("read_note", "error", "缺少 path，无法读取笔记。");
    }

    const file = this.resolveMarkdownFile(rawPath);
    if (!file) {
      return this.result("read_note", "error", `未找到 Markdown 笔记：${rawPath}。可以先用 search_notes 确认路径。`);
    }
    if (!isMarkdownFile(file)) {
      return this.result("read_note", "error", `目标不是 Markdown 笔记：${file.path}。`);
    }

    let content = "";
    try {
      content = await this.options.app.vault.cachedRead(file);
    } catch {
      return this.result("read_note", "error", `读取失败：${file.path}。`);
    }

    const heading = invocation.heading?.trim() || null;
    let body = content;
    if (heading) {
      const section = extractHeadingSection(content, heading);
      if (section === null) {
        const headings = extractHeadings(content).slice(0, 10);
        const hint = headings.length > 0
          ? `可用标题：\n${headings.map((item) => `- ${item}`).join("\n")}`
          : "这篇笔记没有可用的 Markdown 标题。";
        return this.result("read_note", "error", `未找到标题「${heading}」。\n${hint}`);
      }
      body = section;
    }

    return this.result("read_note", "ok", buildNoteContent(file.path, heading, body.trim() || "（该笔记没有正文。）"));
  }

  private runNoteLinks(invocation: AgentToolInvocation): AgentToolExecutionResult {
    const rawPath = invocation.path?.trim() ?? "";
    if (!rawPath) {
      return this.result("note_links", "error", "缺少 path，无法查询链接。");
    }

    const file = this.resolveMarkdownFile(rawPath);
    if (!file) {
      return this.result("note_links", "error", `未找到 Markdown 笔记：${rawPath}。可以先用 search_notes 确认路径。`);
    }
    if (!isMarkdownFile(file)) {
      return this.result("note_links", "error", `目标不是 Markdown 笔记：${file.path}。`);
    }

    const metadataCache = this.options.app.metadataCache;
    const cache = metadataCache.getFileCache(file);
    const outgoing = collectOutgoingLinks(cache, file.path, (linkpath, sourcePath) =>
      metadataCache.getFirstLinkpathDest(linkpath, sourcePath)
    );
    const incoming = collectIncomingLinks(metadataCache.resolvedLinks, file.path);
    return this.result("note_links", "ok", formatNoteLinksContent(file.path, outgoing, incoming));
  }



  private resolveMarkdownFile(rawPath: string): TFile | null {
    const normalizedPath = rawPath.trim().replace(/\\/g, "/");
    if (!normalizedPath) {
      return null;
    }

    const linked = this.options.app.metadataCache.getFirstLinkpathDest(normalizedPath, "");
    if (linked instanceof TFile) {
      return linked;
    }

    for (const candidate of [normalizedPath, `${normalizedPath}.md`]) {
      const file = this.options.app.vault.getAbstractFileByPath(candidate);
      if (file instanceof TFile) {
        return file;
      }
    }
    return null;
  }

  private result(tool: AgentToolName, status: AgentToolStatus, content: string): AgentToolExecutionResult {
    return {
      tool,
      status,
      content: boundResultContent(content)
    };
  }
}

function clampSearchLimit(rawLimit: number | null): number {
  if (rawLimit === null) {
    return MAX_AGENT_TOOL_SEARCH_RESULTS;
  }
  return Math.max(1, Math.min(rawLimit, MAX_AGENT_TOOL_SEARCH_RESULTS));
}

function boundResultContent(content: string): string {
  const normalized = content.trimEnd();
  if (normalized.length <= MAX_AGENT_TOOL_RESULT_CHARS) {
    return normalized;
  }
  const marker = `\n\n（结果已截断至 ${MAX_AGENT_TOOL_RESULT_CHARS} 字符）`;
  return `${normalized.slice(0, MAX_AGENT_TOOL_RESULT_CHARS - marker.length).trimEnd()}${marker}`;
}

function buildNoteContent(filePath: string, heading: string | null, body: string): string {
  const headerLines = [`path: ${filePath}`];
  if (heading) {
    headerLines.push(`heading: ${heading}`);
  }

  const fullHeader = `${headerLines.join("\n")}\ntruncated: false\n---\n`;
  if (fullHeader.length + body.length <= MAX_AGENT_TOOL_RESULT_CHARS) {
    return `${fullHeader}${body}`;
  }

  const marker = `\n\n（内容已截断至 ${MAX_AGENT_TOOL_RESULT_CHARS} 字符）`;
  const truncatedHeader = `${headerLines.join("\n")}\ntruncated: true\n---\n`;
  const budget = Math.max(0, MAX_AGENT_TOOL_RESULT_CHARS - truncatedHeader.length - marker.length);
  return `${truncatedHeader}${body.slice(0, budget).trimEnd()}${marker}`;
}

function buildSearchSnippet(content: string, match: SearchResult): string {
  const firstPart = match.matches[0];
  const matchIndex = firstPart ? Math.max(0, firstPart[0]) : 0;
  const start = Math.max(0, matchIndex - 40);
  const raw = content.slice(start, start + MAX_AGENT_TOOL_SEARCH_SNIPPET_CHARS);
  const prefix = start > 0 ? "..." : "";
  const suffix = start + MAX_AGENT_TOOL_SEARCH_SNIPPET_CHARS < content.length ? "..." : "";
  return clipSnippet(`${prefix}${singleLine(raw)}${suffix}`);
}

function buildFallbackSnippet(content: string): string {
  const body = content.replace(/^---[\s\S]*?---/, "").trim();
  const paragraph = body
    .split(/\n{2,}/)
    .map(singleLine)
    .find((item) => item.length > 0 && !item.startsWith("#"));
  return clipSnippet(paragraph ?? "（无正文）");
}

function clipSnippet(text: string): string {
  const normalized = singleLine(text);
  if (normalized.length <= MAX_AGENT_TOOL_SEARCH_SNIPPET_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_AGENT_TOOL_SEARCH_SNIPPET_CHARS - 3).trimEnd()}...`;
}

function collectOutgoingLinks(
  cache: CachedMetadata | null,
  sourcePath: string,
  resolve: LinkResolver
): NoteLinkEntry[] {
  const rawLinks = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
  const entries: NoteLinkEntry[] = [];
  const seen = new Set<string>();

  for (const rawLink of rawLinks) {
    const linkpath = normalizeLinkpath(rawLink.link);
    if (!linkpath) {
      continue;
    }

    const target = resolve(linkpath, sourcePath);
    const path = target instanceof TFile ? target.path : linkpath;
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    entries.push({
      path,
      basename: target instanceof TFile ? target.basename : basenameOfPath(linkpath),
      resolved: target instanceof TFile
    });
    if (entries.length >= MAX_AGENT_TOOL_LINK_RESULTS) {
      break;
    }
  }

  return entries;
}

function collectIncomingLinks(
  resolvedLinks: Record<string, Record<string, number>>,
  targetPath: string
): NoteLinkEntry[] {
  return Object.entries(resolvedLinks)
    .map(([sourcePath, destinations]) => ({
      sourcePath,
      count: destinations[targetPath] ?? 0
    }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count || left.sourcePath.localeCompare(right.sourcePath))
    .slice(0, MAX_AGENT_TOOL_LINK_RESULTS)
    .map((entry) => ({
      path: entry.sourcePath,
      basename: basenameOfPath(entry.sourcePath),
      resolved: true
    }));
}

function formatNoteLinksContent(
  filePath: string,
  outgoing: NoteLinkEntry[],
  incoming: NoteLinkEntry[]
): string {
  const lines = [
    `path: ${filePath}`,
    `outgoing: ${outgoing.length}`,
    `incoming: ${incoming.length}`,
    "---"
  ];

  if (outgoing.length === 0 && incoming.length === 0) {
    lines.push("这篇笔记没有出链，也没有其他笔记链接到它。");
    return lines.join("\n");
  }

  lines.push("## 出链");
  if (outgoing.length === 0) {
    lines.push("（无出链）");
  } else {
    outgoing.forEach((entry) => lines.push(formatLinkLine(entry)));
  }

  lines.push("", "## 入链");
  if (incoming.length === 0) {
    lines.push("（无入链）");
  } else {
    incoming.forEach((entry) => lines.push(formatLinkLine(entry)));
  }

  return lines.join("\n");
}

function formatLinkLine(entry: NoteLinkEntry): string {
  return `- ${entry.path}（${entry.resolved ? entry.basename : "未解析"}）`;
}



function normalizeLinkpath(rawLink: string): string {
  const withoutAlias = rawLink.split("|")[0] ?? "";
  return (withoutAlias.split("#")[0] ?? "").trim().replace(/\\/g, "/");
}

function basenameOfPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "") || normalized;
}

function isMarkdownFile(file: TFile): boolean {
  return file.extension.toLowerCase() === "md";
}

function extractHeadingSection(markdown: string, heading: string): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const entries = collectHeadingLines(lines);
  const targetText = normalizeHeadingText(heading);
  const targetEntry = entries.find((entry) => normalizeHeadingText(entry.text) === targetText);
  if (!targetEntry) {
    return null;
  }

  const nextEntry = entries.find(
    (entry) => entry.lineIndex > targetEntry.lineIndex && entry.level <= targetEntry.level
  );
  const endLine = nextEntry?.lineIndex ?? lines.length;
  return lines.slice(targetEntry.lineIndex, endLine).join("\n").trim();
}

function extractHeadings(markdown: string): string[] {
  return collectHeadingLines(markdown.replace(/\r\n/g, "\n").split("\n"))
    .map((entry) => `${"#".repeat(entry.level)} ${entry.text.trim()}`);
}

function collectHeadingLines(lines: string[]): HeadingLineEntry[] {
  const entries: HeadingLineEntry[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const match = line.match(HEADING_LINE_PATTERN);
    if (!match) {
      continue;
    }
    entries.push({
      lineIndex,
      level: match[1].length,
      text: match[2] ?? ""
    });
  }
  return entries;
}

function normalizeHeadingText(text: string): string {
  return text
    .replace(/^#+\s*/, "")
    .replace(/\s*#+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function singleLine(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
