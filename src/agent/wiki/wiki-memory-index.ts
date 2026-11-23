import { App, CachedMetadata, TFile } from "obsidian";
import {
  MAX_AGENT_WIKI_MEMORY_EXCERPT_CHARS,
  MAX_AGENT_WIKI_MEMORY_RESULTS,
  MAX_AGENT_WIKI_OUTLINE_ITEMS,
  MAX_AGENT_WIKI_RELATED_LINKS
} from "../../constants";
import type { MessageAttachment } from "../../types";
import {
  WIKI_NOTE_KIND_CONCEPT_PAGE,
  WIKI_NOTE_KIND_KNOWLEDGE_BASE,
  WIKI_NOTE_KIND_KNOWLEDGE_CARD,
  WIKI_NOTE_KIND_SUPPORTING_NOTE,
  isWikiKnowledgeBaseFrontmatter,
  isWikiKnowledgeBaseRootPath,
  parseSimpleFrontmatterFields,
  type WikiNoteKind,
  inferWikiSummary
} from "./wiki-note-schema";

export interface WikiKnowledgeMatch {
  file: TFile;
  kind: WikiNoteKind | "wiki-note";
  score: number;
  summary: string;
  outline: string[];
  relatedLinks: string[];
  sourceLinks: string[];
  matchedTerms: string[];
  matchedFragments: string[];
  excerpt: string;
  truncated: boolean;
  routeHint: string;
  structured: boolean;
  routeSource?: string;
}

export interface WikiKnowledgeBaseInfo {
  rootPath: string;
  indexPath: string;
  displayName: string;
  summary: string;
  files: TFile[];
}

interface WikiScoreOptions {
  scoreBoost?: number;
  routeSource?: string;
}

interface MatchFragmentSource {
  label: string;
  text: string;
  sourceOrder: number;
  maxFragments?: number;
}

interface MatchFragmentCandidate {
  text: string;
  position: number;
  termHits: number;
  sourceOrder: number;
}

const COMMON_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "wiki",
  "sidet",
  "note",
  "notes",
  "markdown",
  "card",
  "concept",
  "page",
  "文件",
  "笔记",
  "内容",
  "当前",
  "这个",
  "那个",
  "我们",
  "一个",
  "可以",
  "需要",
  "问题",
  "功能",
  "概念",
  "页面"
]);

const MATCHED_FRAGMENT_CONTEXT_CHARS = 42;
const MAX_MATCHED_FRAGMENTS = 3;
const MAX_MATCHED_FRAGMENTS_PER_SOURCE = 2;

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function normalizeTitleKey(text: string): string {
  return text
    .replace(/\.md$/i, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, maxChars).trimEnd(),
    truncated: true
  };
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function singleLine(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitleTokens(text: string): string[] {
  const normalized = normalizeTitleKey(text);
  if (!normalized) {
    return [];
  }

  const latinTokens = Array.from(normalized.matchAll(/[a-z0-9]{2,}/g)).map((match) => match[0]);
  const cjkTokens: string[] = [];
  for (const match of normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const segment = match[0];
    cjkTokens.push(segment);
    if (segment.length > 4) {
      for (let index = 0; index < segment.length - 1; index += 1) {
        cjkTokens.push(segment.slice(index, index + 2));
      }
    }
  }

  return unique([...latinTokens, ...cjkTokens]);
}

function scoreTitleHintMatch(candidate: string, hint: string): number {
  const normalizedCandidate = normalizeTitleKey(candidate);
  const normalizedHint = normalizeTitleKey(hint);
  if (!normalizedCandidate || !normalizedHint) {
    return 0;
  }
  if (normalizedCandidate === normalizedHint) {
    return 24;
  }

  let score = 0;
  if (normalizedCandidate.startsWith(normalizedHint) || normalizedHint.startsWith(normalizedCandidate)) {
    score += 14;
  } else if (normalizedCandidate.includes(normalizedHint) || normalizedHint.includes(normalizedCandidate)) {
    score += 10;
  }

  const candidateTokens = extractTitleTokens(normalizedCandidate);
  const hintTokens = new Set(extractTitleTokens(normalizedHint));
  const overlapCount = candidateTokens.filter((token) => hintTokens.has(token)).length;
  score += overlapCount * 4;

  return score;
}

function extractTerms(text: string, limit = 28): string[] {
  const lower = text.toLowerCase();
  const latinTerms = Array.from(lower.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g))
    .map((match) => match[0])
    .filter((term) => !COMMON_TERMS.has(term));
  const cjkTerms: string[] = [];

  for (const match of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const segment = match[0];
    if (segment.length <= 6) {
      cjkTerms.push(segment);
      continue;
    }
    for (let index = 0; index < segment.length - 1 && cjkTerms.length < limit; index += 1) {
      cjkTerms.push(segment.slice(index, index + 2));
    }
  }

  return unique([...latinTerms, ...cjkTerms])
    .filter((term) => term.length >= 2 && !COMMON_TERMS.has(term))
    .slice(0, limit);
}

function scoreText(text: string, terms: string[], weight: number): { score: number; matchedTerms: string[] } {
  const lower = text.toLowerCase();
  const matchedTerms: string[] = [];
  let score = 0;

  for (const term of terms) {
    if (!lower.includes(term)) {
      continue;
    }
    matchedTerms.push(term);
    score += weight;
  }

  return {
    score,
    matchedTerms
  };
}

function buildMatchedFragments(sources: MatchFragmentSource[], terms: string[]): string[] {
  if (terms.length === 0) {
    return [];
  }

  const candidates = sources.flatMap((source) => extractMatchedFragmentCandidates(source, terms));
  if (candidates.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const fragments: string[] = [];
  for (const candidate of candidates
    .sort((left, right) => right.termHits - left.termHits || left.sourceOrder - right.sourceOrder || left.position - right.position)) {
    const key = candidate.text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    fragments.push(candidate.text);
    if (fragments.length >= MAX_MATCHED_FRAGMENTS) {
      break;
    }
  }

  return fragments;
}

function extractMatchedFragmentCandidates(source: MatchFragmentSource, terms: string[]): MatchFragmentCandidate[] {
  const normalizedSourceText = source.text.replace(/\r\n/g, "\n").trim();
  if (!normalizedSourceText) {
    return [];
  }

  const lower = normalizedSourceText.toLowerCase();
  const hits: Array<{ start: number; end: number; term: string }> = [];
  for (const term of terms) {
    let searchIndex = 0;
    let hitsForTerm = 0;
    while (hitsForTerm < MAX_MATCHED_FRAGMENTS_PER_SOURCE) {
      const matchIndex = lower.indexOf(term, searchIndex);
      if (matchIndex < 0) {
        break;
      }
      hits.push({
        start: matchIndex,
        end: matchIndex + term.length,
        term
      });
      searchIndex = matchIndex + Math.max(term.length, 1);
      hitsForTerm += 1;
    }
  }

  if (hits.length === 0) {
    return [];
  }

  const windows = hits
    .map((hit) => ({
      start: Math.max(0, hit.start - MATCHED_FRAGMENT_CONTEXT_CHARS),
      end: Math.min(normalizedSourceText.length, hit.end + MATCHED_FRAGMENT_CONTEXT_CHARS),
      position: hit.start,
      terms: new Set([hit.term])
    }))
    .sort((left, right) => left.start - right.start);

  const merged: Array<{ start: number; end: number; position: number; terms: Set<string> }> = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end) {
      previous.end = Math.max(previous.end, window.end);
      previous.position = Math.min(previous.position, window.position);
      for (const term of window.terms) {
        previous.terms.add(term);
      }
      continue;
    }
    merged.push(window);
  }

  return merged
    .map((window) => {
      const text = singleLine(normalizedSourceText.slice(window.start, window.end));
      if (!text) {
        return null;
      }

      const prefix = window.start > 0 ? "..." : "";
      const suffix = window.end < normalizedSourceText.length ? "..." : "";
      return {
        text: `「${prefix}${text}${suffix}」（${source.label}）`,
        position: window.position,
        termHits: window.terms.size,
        sourceOrder: source.sourceOrder
      } satisfies MatchFragmentCandidate;
    })
    .filter((candidate): candidate is MatchFragmentCandidate => candidate !== null)
    .sort((left, right) => right.termHits - left.termHits || left.position - right.position)
    .slice(0, source.maxFragments ?? 1);
}

function stripFrontmatter(text: string): string {
  const normalized = normalizeText(text);
  return normalized.startsWith("---")
    ? normalized.replace(/^---[\s\S]*?---/, "").trim()
    : normalized;
}

function buildQuery(text: string, attachments: MessageAttachment[]): string {
  const attachmentText = attachments.map((attachment) => {
    if (attachment.type === "markdown") {
      return `${attachment.name}\n${attachment.path}\n${attachment.content.slice(0, 1200)}`;
    }
    if (attachment.type === "webpage") {
      return `${attachment.name}\n${attachment.url}\n${attachment.content.slice(0, 1200)}`;
    }
    return `${attachment.name}\n${attachment.mimeType}`;
  }).join("\n");
  return `${text}\n${attachmentText}`;
}

function normalizeScalarList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return unique(
      value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean)
    );
  }

  if (typeof value !== "string") {
    return [];
  }

  return unique(
    value
      .split(/[，,、;；\n]/g)
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function normalizeLinkText(value: string): string {
  return value
    .replace(/^\[\[|\]\]$/g, "")
    .split("|")[0]
    ?.split("#")[0]
    ?.trim() ?? "";
}

function resolveWikiNoteKind(frontmatter: Record<string, unknown> | null): WikiNoteKind | "wiki-note" {
  const raw = typeof frontmatter?.sidet_type === "string"
    ? frontmatter.sidet_type
    : typeof frontmatter?.type === "string"
      ? frontmatter.type
      : "";
  const normalized = raw.trim().toLowerCase();
  if (normalized === WIKI_NOTE_KIND_KNOWLEDGE_BASE || normalized === "knowledge-base-root" || normalized === "index") {
    return WIKI_NOTE_KIND_KNOWLEDGE_BASE;
  }
  if (normalized === WIKI_NOTE_KIND_CONCEPT_PAGE || normalized === "concept") {
    return WIKI_NOTE_KIND_CONCEPT_PAGE;
  }
  if (normalized === WIKI_NOTE_KIND_KNOWLEDGE_CARD || normalized === "knowledge") {
    return WIKI_NOTE_KIND_KNOWLEDGE_CARD;
  }
  if (normalized === WIKI_NOTE_KIND_SUPPORTING_NOTE || normalized === "supporting") {
    return WIKI_NOTE_KIND_SUPPORTING_NOTE;
  }
  return "wiki-note";
}

function extractFrontmatterLinks(cache: CachedMetadata | null, keys: string[]): string[] {
  if (!cache?.frontmatterLinks?.length) {
    return [];
  }

  const allowed = new Set(keys.map((key) => key.toLowerCase()));
  return unique(
    cache.frontmatterLinks
      .filter((link) => allowed.has(link.key.toLowerCase()))
      .map((link) => normalizeLinkText(link.link))
      .filter(Boolean)
  );
}

function extractBodyLinks(cache: CachedMetadata | null): string[] {
  if (!cache?.links?.length) {
    return [];
  }

  return unique(
    cache.links
      .map((link) => normalizeLinkText(link.link))
      .filter(Boolean)
      .slice(0, MAX_AGENT_WIKI_RELATED_LINKS)
  );
}

function extractOutline(cache: CachedMetadata | null): string[] {
  if (!cache?.headings?.length) {
    return [];
  }

  return cache.headings
    .filter((heading) => heading.level <= 3)
    .slice(0, MAX_AGENT_WIKI_OUTLINE_ITEMS)
    .map((heading) => `${"#".repeat(heading.level)} ${heading.heading.trim()}`);
}

function buildRouteHint(
  kind: WikiNoteKind | "wiki-note",
  structured: boolean,
  routeSource?: string
): string {
  const prefix = routeSource ? `由 [[${routeSource}]] 路由命中。` : "";
  if (kind === WIKI_NOTE_KIND_KNOWLEDGE_BASE) {
    return `${prefix}先读摘要，再看先读顺序和主题入口，必要时再下钻库内概念页。`.trim();
  }
  if (kind === WIKI_NOTE_KIND_CONCEPT_PAGE) {
    return `${prefix}先读摘要，再看大纲和相关链接，必要时再下钻具体知识卡。`.trim();
  }
  if (kind === WIKI_NOTE_KIND_SUPPORTING_NOTE) {
    return `${prefix}先读摘要，按需展开局部正文，不默认整页通读。`.trim();
  }
  if (structured) {
    return `${prefix}先读摘要，再按大纲或相关链接决定是否展开正文。`.trim();
  }
  return `${prefix}先读摘要，必要时再读正文摘录。`.trim();
}

function normalizeKnowledgeBaseName(frontmatter: Record<string, unknown> | null, fallbackName: string): string {
  const aliases = normalizeScalarList(frontmatter?.aliases);
  if (aliases.length > 0 && aliases[0]) {
    return aliases[0].trim();
  }
  const summary = typeof frontmatter?.summary === "string" ? frontmatter.summary.trim() : "";
  return summary || fallbackName;
}

function getKnowledgeBaseRootPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").trim();
  if (/^Index\.md$/i.test(normalized)) {
    return "";
  }
  return normalized.replace(/\/Index\.md$/i, "");
}

function normalizeKnowledgeBaseRootPath(rootPath: string): string {
  return rootPath.replace(/\\/g, "/").trim().replace(/\/+$/g, "");
}

function isFileWithinKnowledgeBaseRoot(filePath: string, rootPath: string): boolean {
  const normalizedFilePath = filePath.replace(/\\/g, "/").trim();
  const normalizedRootPath = normalizeKnowledgeBaseRootPath(rootPath);
  if (!normalizedRootPath) {
    return true;
  }

  return normalizedFilePath === `${normalizedRootPath}/Index.md`
    || normalizedFilePath.startsWith(`${normalizedRootPath}/`);
}

function resolveBestKnowledgeBaseRootPath(filePath: string, roots: string[]): string | null {
  const normalizedFilePath = filePath.replace(/\\/g, "/").trim();
  const matchingRoots = roots
    .map((root) => normalizeKnowledgeBaseRootPath(root))
    .filter((root) => isFileWithinKnowledgeBaseRoot(normalizedFilePath, root))
    .sort((left, right) => right.length - left.length);
  return matchingRoots[0] ?? null;
}

function buildKnowledgeBaseSignature(knowledgeBases: WikiKnowledgeBaseInfo[]): string {
  return knowledgeBases
    .map((knowledgeBase) => [
      knowledgeBase.rootPath,
      knowledgeBase.indexPath,
      knowledgeBase.displayName,
      knowledgeBase.summary,
      knowledgeBase.files.map((file) => file.path).join("|")
    ].join("::"))
    .join("||");
}

function buildFrontmatterRecordFromMarkdown(markdown: string): Record<string, unknown> | null {
  const { fields } = parseSimpleFrontmatterFields(markdown);
  const frontmatter: Record<string, unknown> = {};

  if (fields.kind) {
    frontmatter.sidet_type = fields.kind;
  }
  if (typeof fields.summary === "string" && fields.summary.trim()) {
    frontmatter.summary = fields.summary.trim();
  }
  if ((fields.aliases ?? []).length > 0) {
    frontmatter.aliases = [...(fields.aliases ?? [])];
  }
  if ((fields.keywords ?? []).length > 0) {
    frontmatter.keywords = [...(fields.keywords ?? [])];
  }
  if ((fields.parents ?? []).length > 0) {
    frontmatter.parents = [...(fields.parents ?? [])];
  }
  if ((fields.children ?? []).length > 0) {
    frontmatter.children = [...(fields.children ?? [])];
  }
  if ((fields.related ?? []).length > 0) {
    frontmatter.related = [...(fields.related ?? [])];
  }
  if ((fields.sources ?? []).length > 0) {
    frontmatter.sources = [...(fields.sources ?? [])];
  }

  return Object.keys(frontmatter).length > 0 ? frontmatter : null;
}

function mergeFrontmatterRecords(
  primary: Record<string, unknown> | null,
  fallback: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (primary && fallback) {
    return {
      ...fallback,
      ...primary
    };
  }
  return primary ?? fallback;
}

export class WikiKnowledgeIndex {
  private knowledgeBaseSnapshot: WikiKnowledgeBaseInfo[] = [];
  private hasKnowledgeBaseSnapshot = false;
  private knowledgeBaseRefreshPromise: Promise<boolean> | null = null;

  constructor(private readonly app: App) {}

  primeKnowledgeBasesFromMetadataCache(): boolean {
    const knowledgeBases = this.collectKnowledgeBasesFromMetadataCache();
    const changed = !this.hasKnowledgeBaseSnapshot
      || buildKnowledgeBaseSignature(this.knowledgeBaseSnapshot) !== buildKnowledgeBaseSignature(knowledgeBases);
    this.knowledgeBaseSnapshot = knowledgeBases;
    this.hasKnowledgeBaseSnapshot = true;
    return changed;
  }

  async refreshKnowledgeBases(): Promise<boolean> {
    if (this.knowledgeBaseRefreshPromise) {
      return this.knowledgeBaseRefreshPromise;
    }

    this.knowledgeBaseRefreshPromise = this.collectKnowledgeBasesFromVault()
      .then((knowledgeBases) => {
        const changed = !this.hasKnowledgeBaseSnapshot
          || buildKnowledgeBaseSignature(this.knowledgeBaseSnapshot) !== buildKnowledgeBaseSignature(knowledgeBases);
        this.knowledgeBaseSnapshot = knowledgeBases;
        this.hasKnowledgeBaseSnapshot = true;
        return changed;
      })
      .finally(() => {
        this.knowledgeBaseRefreshPromise = null;
      });

    return this.knowledgeBaseRefreshPromise;
  }

  findKnowledgeBases(): WikiKnowledgeBaseInfo[] {
    if (this.hasKnowledgeBaseSnapshot) {
      return [...this.knowledgeBaseSnapshot];
    }

    const knowledgeBases = this.collectKnowledgeBasesFromMetadataCache();
    if (knowledgeBases.length > 0) {
      this.knowledgeBaseSnapshot = knowledgeBases;
      this.hasKnowledgeBaseSnapshot = true;
    }
    return knowledgeBases;
  }

  findKnowledgeBaseByIndexPath(indexPath: string): WikiKnowledgeBaseInfo | null {
    const normalizedIndexPath = indexPath.replace(/\\/g, "/").trim();
    return this.findKnowledgeBases().find((knowledgeBase) => knowledgeBase.indexPath === normalizedIndexPath) ?? null;
  }

  async findRelevantEntries(
    text: string,
    attachments: MessageAttachment[],
    scopeRootPath: string | null = null
  ): Promise<WikiKnowledgeMatch[]> {
    const terms = extractTerms(buildQuery(text, attachments));
    if (terms.length === 0) {
      return [];
    }

    const knowledgeBases = await this.ensureKnowledgeBasesReady();
    const scopeRoot = scopeRootPath ? normalizeKnowledgeBaseRootPath(scopeRootPath) : null;
    const roots = (scopeRoot
      ? knowledgeBases.filter((knowledgeBase) => normalizeKnowledgeBaseRootPath(knowledgeBase.rootPath) === scopeRoot)
      : knowledgeBases
    ).map((knowledgeBase) => knowledgeBase.rootPath);
    if (roots.length === 0) {
      return [];
    }
    const files = this.getIndexedWikiFiles(roots);

    const matches: WikiKnowledgeMatch[] = [];
    for (const file of files) {
      const match = await this.scoreFile(file, terms);
      if (match.score > 0) {
        matches.push(match);
      }
    }

    return this.mergeMatches([
      ...matches,
      ...await this.expandRouteMatches(matches, terms, roots)
    ])
      .sort((left, right) => right.score - left.score || right.file.stat.mtime - left.file.stat.mtime)
      .slice(0, MAX_AGENT_WIKI_MEMORY_RESULTS);
  }

  async findWriteCandidates(
    titleHints: string[],
    text: string,
    attachments: MessageAttachment[],
    limit = MAX_AGENT_WIKI_MEMORY_RESULTS + 1,
    scopeRootPath: string | null = null
  ): Promise<WikiKnowledgeMatch[]> {
    const relevantMatches = await this.findRelevantEntries(text, attachments, scopeRootPath);
    const knowledgeBases = await this.ensureKnowledgeBasesReady();
    const scopeRoot = scopeRootPath ? normalizeKnowledgeBaseRootPath(scopeRootPath) : null;
    const roots = (scopeRoot
      ? knowledgeBases.filter((knowledgeBase) => normalizeKnowledgeBaseRootPath(knowledgeBase.rootPath) === scopeRoot)
      : knowledgeBases
    ).map((knowledgeBase) => knowledgeBase.rootPath);
    if (roots.length === 0) {
      return relevantMatches;
    }
    const files = this.getIndexedWikiFiles(roots);
    const hintTerms = extractTerms(`${titleHints.join("\n")}\n${text}`, 36);
    const titleCandidates = files
      .map((file) => ({
        file,
        boost: Math.max(
          ...titleHints.map((hint) => scoreTitleHintMatch(file.basename, hint)),
          0
        )
      }))
      .filter((candidate) => candidate.boost > 0)
      .sort((left, right) => right.boost - left.boost || right.file.stat.mtime - left.file.stat.mtime)
      .slice(0, Math.max(limit * 2, limit));

    const titleMatches: WikiKnowledgeMatch[] = [];
    for (const candidate of titleCandidates) {
      const match = await this.scoreFile(candidate.file, hintTerms, { scoreBoost: candidate.boost });
      if (match.score > 0) {
        titleMatches.push(match);
      }
    }

    return this.mergeMatches([...relevantMatches, ...titleMatches])
      .sort((left, right) => right.score - left.score || right.file.stat.mtime - left.file.stat.mtime)
      .slice(0, limit);
  }

  private getKnowledgeBaseRootFiles(markdownFiles: TFile[]): TFile[] {
    return markdownFiles.filter((file) => isWikiKnowledgeBaseRootPath(file.path));
  }

  private async ensureKnowledgeBasesReady(): Promise<WikiKnowledgeBaseInfo[]> {
    const knowledgeBases = this.findKnowledgeBases();
    if (knowledgeBases.length > 0) {
      return knowledgeBases;
    }

    await this.refreshKnowledgeBases();
    return this.findKnowledgeBases();
  }

  private collectKnowledgeBasesFromMetadataCache(): WikiKnowledgeBaseInfo[] {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const rootFiles = this.getKnowledgeBaseRootFiles(markdownFiles);
    const allFiles = [...markdownFiles].sort((left, right) => left.path.localeCompare(right.path));
    const rootEntries = rootFiles
      .map((file) => {
        if (!isWikiKnowledgeBaseRootPath(file.path)) {
          return null;
        }

        const frontmatter = this.getCachedFrontmatterRecord(file);
        return isWikiKnowledgeBaseFrontmatter(frontmatter)
          ? { file, frontmatter }
          : null;
      })
      .filter((entry): entry is { file: TFile; frontmatter: Record<string, unknown> | null } => entry !== null);

    return this.buildKnowledgeBases(rootEntries, allFiles);
  }

  private async collectKnowledgeBasesFromVault(): Promise<WikiKnowledgeBaseInfo[]> {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const rootFiles = this.getKnowledgeBaseRootFiles(markdownFiles);
    const allFiles = [...markdownFiles].sort((left, right) => left.path.localeCompare(right.path));
    const rootEntries = (await Promise.all(rootFiles.map(async (file) => {
      if (!isWikiKnowledgeBaseRootPath(file.path)) {
        return null;
      }

      const frontmatter = await this.readFrontmatterRecord(file);
      return isWikiKnowledgeBaseFrontmatter(frontmatter)
        ? { file, frontmatter }
        : null;
    })))
      .filter((entry): entry is { file: TFile; frontmatter: Record<string, unknown> | null } => entry !== null);

    return this.buildKnowledgeBases(rootEntries, allFiles);
  }

  private buildKnowledgeBases(
    rootEntries: Array<{ file: TFile; frontmatter: Record<string, unknown> | null }>,
    allFiles: TFile[]
  ): WikiKnowledgeBaseInfo[] {
    return rootEntries
      .map(({ file, frontmatter }) => {
        const rootPath = getKnowledgeBaseRootPath(file.path);
        const children = allFiles.filter((candidate) => isFileWithinKnowledgeBaseRoot(candidate.path, rootPath));
        return {
          rootPath,
          indexPath: file.path,
          displayName: normalizeKnowledgeBaseName(frontmatter, file.basename),
          summary: typeof frontmatter?.summary === "string" && frontmatter.summary.trim()
            ? frontmatter.summary.trim()
            : file.basename,
          files: children
        };
      })
      .sort((left, right) => left.rootPath.localeCompare(right.rootPath));
  }

  private getCachedFrontmatterRecord(file: TFile): Record<string, unknown> | null {
    const cache = this.app.metadataCache.getFileCache(file);
    return (cache?.frontmatter ?? null);
  }

  private async readFrontmatterRecord(file: TFile): Promise<Record<string, unknown> | null> {
    const cachedFrontmatter = this.getCachedFrontmatterRecord(file);
    try {
      const raw = await this.app.vault.cachedRead(file);
      return mergeFrontmatterRecords(cachedFrontmatter, buildFrontmatterRecordFromMarkdown(raw));
    } catch {
      return cachedFrontmatter;
    }
  }

  private getIndexedWikiFiles(roots: string[]): TFile[] {
    const normalizedRoots = roots.map((root) => normalizeKnowledgeBaseRootPath(root));
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => resolveBestKnowledgeBaseRootPath(file.path, normalizedRoots) !== null)
      .sort((left, right) => right.stat.mtime - left.stat.mtime);
  }

  private mergeMatches(matches: WikiKnowledgeMatch[]): WikiKnowledgeMatch[] {
    const merged = new Map<string, WikiKnowledgeMatch>();
    for (const match of matches) {
      const existing = merged.get(match.file.path);
      if (!existing) {
        merged.set(match.file.path, {
          ...match,
          matchedTerms: [...match.matchedTerms],
          matchedFragments: [...match.matchedFragments]
        });
        continue;
      }

      if (match.score > existing.score) {
        merged.set(match.file.path, {
          ...match,
          matchedTerms: unique([...existing.matchedTerms, ...match.matchedTerms]),
          matchedFragments: unique([...existing.matchedFragments, ...match.matchedFragments]),
          routeSource: match.routeSource ?? existing.routeSource
        });
        continue;
      }

      existing.matchedTerms = unique([...existing.matchedTerms, ...match.matchedTerms]);
      existing.matchedFragments = unique([...existing.matchedFragments, ...match.matchedFragments]);
      existing.routeSource = existing.routeSource ?? match.routeSource;
    }

    return Array.from(merged.values());
  }

  private async expandRouteMatches(
    baseMatches: WikiKnowledgeMatch[],
    fallbackTerms: string[],
    roots: string[]
  ): Promise<WikiKnowledgeMatch[]> {
    const seedMatches = baseMatches
      .filter((match) => match.kind === WIKI_NOTE_KIND_CONCEPT_PAGE)
      .sort((left, right) => right.score - left.score || right.file.stat.mtime - left.file.stat.mtime)
      .slice(0, 2);
    if (seedMatches.length === 0) {
      return [];
    }

    const existingPaths = new Set(baseMatches.map((match) => match.file.path));
    const expandedMatches: WikiKnowledgeMatch[] = [];

    for (const seed of seedMatches) {
      const seedRoot = resolveBestKnowledgeBaseRootPath(seed.file.path, roots);
      if (seedRoot === null) {
        continue;
      }
      const routeTerms = seed.matchedTerms.length > 0
        ? seed.matchedTerms
        : extractTerms(`${seed.file.basename}\n${seed.summary}`, 16);
      let addedForSeed = 0;

      for (const link of seed.relatedLinks) {
        if (addedForSeed >= 2) {
          break;
        }

        const target = this.app.metadataCache.getFirstLinkpathDest(link, seed.file.path);
        const targetRoot = target instanceof TFile
          ? resolveBestKnowledgeBaseRootPath(target.path, roots)
          : null;
        if (
          !(target instanceof TFile)
          || targetRoot !== seedRoot
          || target.path === seed.file.path
          || existingPaths.has(target.path)
        ) {
          continue;
        }

        expandedMatches.push(await this.scoreFile(
          target,
          routeTerms.length > 0 ? routeTerms : fallbackTerms,
          {
            scoreBoost: 6,
            routeSource: seed.file.basename
          }
        ));
        existingPaths.add(target.path);
        addedForSeed += 1;
      }
    }

    return expandedMatches;
  }

  private async scoreFile(file: TFile, terms: string[], options: WikiScoreOptions = {}): Promise<WikiKnowledgeMatch> {
    const cache = this.app.metadataCache.getFileCache(file);
    const raw = await this.app.vault.cachedRead(file);
    const frontmatter = mergeFrontmatterRecords(
      (cache?.frontmatter ?? null),
      buildFrontmatterRecordFromMarkdown(raw)
    );
    const body = stripFrontmatter(raw);
    const kind = resolveWikiNoteKind(frontmatter);
    const summary = typeof frontmatter?.summary === "string" && frontmatter.summary.trim()
      ? frontmatter.summary.trim()
      : inferWikiSummary(body);
    const outline = extractOutline(cache);
    const aliases = normalizeScalarList(frontmatter?.aliases);
    const keywords = normalizeScalarList(frontmatter?.keywords);
    const parents = unique([
      ...normalizeScalarList(frontmatter?.parents).map(normalizeLinkText),
      ...extractFrontmatterLinks(cache, ["parents"])
    ]);
    const children = unique([
      ...normalizeScalarList(frontmatter?.children).map(normalizeLinkText),
      ...extractFrontmatterLinks(cache, ["children"])
    ]);
    const related = unique([
      ...normalizeScalarList(frontmatter?.related).map(normalizeLinkText),
      ...extractFrontmatterLinks(cache, ["related"]),
      ...extractBodyLinks(cache)
    ]).slice(0, MAX_AGENT_WIKI_RELATED_LINKS);
    const sources = unique([
      ...normalizeScalarList(frontmatter?.sources).map(normalizeLinkText),
      ...extractFrontmatterLinks(cache, ["sources"])
    ]).slice(0, MAX_AGENT_WIKI_RELATED_LINKS);

    const excerpt = clipText(body, MAX_AGENT_WIKI_MEMORY_EXCERPT_CHARS);
    const structured = Boolean(
      summary
      || aliases.length
      || keywords.length
      || parents.length
      || children.length
      || related.length
      || kind !== "wiki-note"
    );

    const titleScore = scoreText(`${file.basename}\n${file.path}`, terms, 6);
    const summaryScore = scoreText(summary, terms, 5);
    const keywordScore = scoreText(
      [aliases.join("\n"), keywords.join("\n"), parents.join("\n"), children.join("\n"), related.join("\n"), sources.join("\n")].join("\n"),
      terms,
      4
    );
    const outlineScore = scoreText(outline.join("\n"), terms, 2);
    const bodyScore = scoreText(excerpt.text, terms, 1);
    const matchedTerms = unique([
      ...titleScore.matchedTerms,
      ...summaryScore.matchedTerms,
      ...keywordScore.matchedTerms,
      ...outlineScore.matchedTerms,
      ...bodyScore.matchedTerms
    ]);
    const matchedFragments = buildMatchedFragments([
      {
        label: "正文",
        text: body,
        sourceOrder: 0,
        maxFragments: 2
      },
      {
        label: "大纲",
        text: outline.join("\n"),
        sourceOrder: 1
      },
      {
        label: "关键词",
        text: unique([...aliases, ...keywords]).join(" / "),
        sourceOrder: 2
      },
      {
        label: "关联",
        text: unique([...parents, ...children, ...related, ...sources]).join(" / "),
        sourceOrder: 3
      },
      {
        label: "标题",
        text: file.basename,
        sourceOrder: 4
      }
    ], matchedTerms.length > 0 ? matchedTerms : terms);

    let score = titleScore.score + summaryScore.score + keywordScore.score + outlineScore.score + bodyScore.score;
    if ((kind === WIKI_NOTE_KIND_KNOWLEDGE_BASE || kind === WIKI_NOTE_KIND_CONCEPT_PAGE) && score > 0) {
      score += 3;
    }
    if (structured && score > 0) {
      score += 1;
    }
    score += options.scoreBoost ?? 0;

    return {
      file,
      kind,
      score,
      summary,
      outline,
      relatedLinks: unique([...parents, ...children, ...related]).slice(0, MAX_AGENT_WIKI_RELATED_LINKS),
      sourceLinks: sources,
      matchedTerms,
      matchedFragments,
      excerpt: excerpt.text,
      truncated: excerpt.truncated,
      routeHint: buildRouteHint(kind, structured, options.routeSource),
      structured,
      routeSource: options.routeSource
    };
  }
}
