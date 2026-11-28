import type { WebSearchResult } from "../../context/web-search-service";
import { passesQueryCoverage } from "../../context/web-search-ranking";
import { trimContextTextToBudget } from "../context-bundle";
import { buildSidetResearchResultBlock } from "./sidet-protocol";
import {
  buildFallbackSearchQueries,
  normalizeSearchQueries,
  sanitizeResearchQueries,
  type ResearchAttemptSummary
} from "./web-search-runtime-policy";

export interface ResearchBudgetOptions {
  maxRounds?: number;
  maxQueries?: number;
  maxPages?: number;
  maxWallClockMs?: number;
  maxModelCalls?: number;
  maxQueriesPerRound?: number;
  maxPagesPerRound?: number;
  maxEvidenceChars?: number;
  maxSourceInputChars?: number;
  maxPageContentChars?: number;
}

export type ResolvedResearchBudgetOptions = Required<ResearchBudgetOptions>;

export const DEFAULT_RESEARCH_BUDGET: ResolvedResearchBudgetOptions = {
  maxRounds: 3,
  maxQueries: 12,
  maxPages: 9,
  maxWallClockMs: 120_000,
  maxModelCalls: 11,
  maxQueriesPerRound: 4,
  maxPagesPerRound: 3,
  maxEvidenceChars: 4_000,
  maxSourceInputChars: 60_000,
  maxPageContentChars: 20_000
};

/**
 * 首轮显式研究允许直接交给回答模型的原文证据上限。
 * 超过这个量才回到压缩调用，避免小证据也为一次模型总结多等一轮。
 */
export const FAST_RESEARCH_EVIDENCE_CHARS = 8_000;

export interface ResearchBudget {
  readonly options: ResolvedResearchBudgetOptions;
  readonly startedAt: number;
  rounds: number;
  queries: number;
  pages: number;
  modelCalls: number;
  isExpired: () => boolean;
  exhaustedReason: () => string | null;
  canStartRound: () => boolean;
  chargeRound: () => boolean;
  remainingQueries: () => number;
  chargeQueries: (count: number) => number;
  remainingPages: () => number;
  chargePages: (count: number) => number;
  remainingModelCalls: () => number;
  chargeModelCall: () => boolean;
}

export function createResearchBudget(
  options: ResearchBudgetOptions = {},
  now: () => number = Date.now
): ResearchBudget {
  const resolved: ResolvedResearchBudgetOptions = {
    ...DEFAULT_RESEARCH_BUDGET,
    ...Object.fromEntries(
      Object.entries(options).filter(([, value]) => value !== undefined)
    )
  };
  const startedAt = now();

  const budget: ResearchBudget = {
    options: resolved,
    startedAt,
    rounds: 0,
    queries: 0,
    pages: 0,
    modelCalls: 0,
    isExpired: () => now() - startedAt >= resolved.maxWallClockMs,
    exhaustedReason: () => {
      if (budget.rounds >= resolved.maxRounds) {
        return `已达到 ${resolved.maxRounds} 轮研究上限。`;
      }
      if (budget.queries >= resolved.maxQueries) {
        return `已达到 ${resolved.maxQueries} 组查询上限。`;
      }
      if (budget.pages >= resolved.maxPages) {
        return `已达到 ${resolved.maxPages} 页正文上限。`;
      }
      if (budget.modelCalls >= resolved.maxModelCalls) {
        return `已达到 ${resolved.maxModelCalls} 次模型调用上限。`;
      }
      if (budget.isExpired()) {
        return `已达到 ${Math.round(resolved.maxWallClockMs / 1000)} 秒研究时长上限。`;
      }
      return null;
    },
    canStartRound: () => budget.exhaustedReason() === null,
    chargeRound: () => {
      if (!budget.canStartRound()) {
        return false;
      }
      budget.rounds += 1;
      return true;
    },
    remainingQueries: () => Math.max(0, resolved.maxQueries - budget.queries),
    chargeQueries: (count: number) => {
      const allowed = Math.max(0, Math.min(Math.trunc(count), budget.remainingQueries()));
      budget.queries += allowed;
      return allowed;
    },
    remainingPages: () => Math.max(0, resolved.maxPages - budget.pages),
    chargePages: (count: number) => {
      const allowed = Math.max(0, Math.min(Math.trunc(count), budget.remainingPages()));
      budget.pages += allowed;
      return allowed;
    },
    remainingModelCalls: () => Math.max(0, resolved.maxModelCalls - budget.modelCalls),
    chargeModelCall: () => {
      if (budget.remainingModelCalls() <= 0) {
        return false;
      }
      budget.modelCalls += 1;
      return true;
    }
  };

  return budget;
}

export interface ResearchPage {
  sourceIndex: number;
  title: string;
  url: string;
  host: string;
  content: string;
  snippet?: string;
  /** 页面可见日期或搜索结果日期；只作时效判断，不保证是发布时间。 */
  publishedAt?: string;
}

export interface ResearchRoundResult {
  round: number;
  question: string;
  queries: string[];
  providerLabel: string;
  results: WebSearchResult[];
  pages: ResearchPage[];
  failedPageCount: number;
  evidenceText: string;
  resultBlock: string;
  status: "ok" | "partial" | "empty";
  searchError: string | null;
}

export interface ResearchRoundProgress {
  stage: "queries" | "search" | "pages" | "fetch" | "evidence" | "done" | "warning";
  message: string;
}

export interface WebResearchRoundOptions {
  round: number;
  question: string;
  budget: ResearchBudget;
  alreadyFetchedUrls: ReadonlySet<string>;
  sourceStart: number;
  signal: AbortSignal;
  /** 之前轮次试过的查询与命中站点；用于让本轮换角度，而不是复读。 */
  previousAttempts?: readonly ResearchAttemptSummary[];
  expandQueries: (
    question: string,
    maxQueries: number,
    previousAttempts: readonly ResearchAttemptSummary[]
  ) => Promise<string>;
  searchMany: (
    queries: string[],
    onProgress?: (event: { message: string }) => void
  ) => Promise<{ providerLabel: string; results: WebSearchResult[] }>;
  fetchPage: (url: string) => Promise<{
    title: string;
    url: string;
    content: string;
    snippet?: string;
    publishedAt?: string;
  }>;
  compressEvidence: (question: string, evidenceInput: string, maxChars: number) => Promise<string>;
  /**
   * 本轮证据正文上限；默认沿用预算里的 `maxEvidenceChars`。
   * 首轮快路会把原始证据放宽到这个值，不再额外压缩。
   */
  evidenceCharLimit?: number;
  /** 证据压缩提示词与压缩结果的上限；默认沿用预算里的 `maxEvidenceChars`。 */
  compressionCharLimit?: number;
  /** 原文证据不超过 `evidenceCharLimit` 时跳过压缩模型调用。 */
  skipCompressionWhenFits?: boolean;
  onProgress?: (event: ResearchRoundProgress) => void;
  now?: () => number;
}

const BINARY_URL_EXTENSIONS = new Set([
  ".pdf", ".zip", ".rar", ".7z", ".gz", ".tar",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mp3", ".wav", ".flac",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".apk", ".exe", ".dmg", ".iso", ".bin"
]);

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function normalizePageUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.trim());
    if (!/^https?:$/.test(url.protocol)) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function resolveHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

function hasBinaryExtension(rawUrl: string): boolean {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    const dotIndex = pathname.lastIndexOf(".");
    return dotIndex >= 0 && BINARY_URL_EXTENSIONS.has(pathname.slice(dotIndex));
  } catch {
    return true;
  }
}

/** 查询项兼容纯字符串和 `{query|q|text}` 对象，避免模型换一种写法就解析失败。 */
function coerceQueryItem(item: unknown): string | null {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return null;
  }
  const record = item as Record<string, unknown>;
  for (const key of ["query", "q", "text", "keywords"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function collectQueryItems(items: unknown[], maxQueries: number): string[] {
  const strings = items
    .map((item) => coerceQueryItem(item))
    .filter((item): item is string => Boolean(item));
  return dedupeQueryLines(strings, maxQueries);
}

/**
 * 从模型输出里提取查询行。兼容 `query1: ...`、`1. ...`、`- ...` 和纯文本行；
 * 解析不出时返回空数组，由调用方走确定性兜底。
 */
export function parseResearchQueries(rawText: string, maxQueries: number): string[] {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return [];
  }

  const withoutFences = trimmed
    .replace(/```[a-z-]*\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  // 检索前理解约定输出 { intent, ambiguities, queries }；旧格式可能仍是纯数组或逐行。
  const jsonCandidates = [withoutFences];
  const objectStart = withoutFences.indexOf("{");
  const objectEnd = withoutFences.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    jsonCandidates.push(withoutFences.slice(objectStart, objectEnd + 1));
  }
  for (const candidate of jsonCandidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        const queries = collectQueryItems(parsed, maxQueries);
        if (queries.length > 0) {
          return queries;
        }
      }
      if (
        parsed
        && typeof parsed === "object"
        && Array.isArray((parsed as { queries?: unknown }).queries)
      ) {
        const queries = collectQueryItems((parsed as { queries: unknown[] }).queries, maxQueries);
        if (queries.length > 0) {
          return queries;
        }
      }
    } catch {
      // 继续尝试下一个候选或按行解析。
    }
  }

  if (withoutFences.startsWith("{")) {
    return [];
  }

  const lines = withoutFences.split(/\r?\n/);
  return dedupeQueryLines(lines, maxQueries);
}

function dedupeQueryLines(lines: string[], maxQueries: number): string[] {
  const queries: string[] = [];
  for (const line of lines) {
    let value = line.trim();
    if (!value || value.startsWith("#")) {
      continue;
    }
    value = value
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)、]\s*/, "")
      .replace(/^(?:query|搜索词|查询)\s*\d*\s*[:：]\s*/i, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim();
    if (!value || /^(?:query|搜索词|查询|queries)\s*[:：]?$/i.test(value)) {
      continue;
    }
    if (!queries.includes(value)) {
      queries.push(value);
    }
    if (queries.length >= maxQueries) {
      break;
    }
  }
  return queries;
}

/**
 * 选择要读正文的页面：跳过已读、非 http(s) 和明显二进制链接；优先不同 host，
 * 不足时再按排序补足。保持搜索结果原始顺序，便于测试和来源编号稳定。
 */
export function selectResearchPages(
  results: WebSearchResult[],
  alreadyFetchedUrls: ReadonlySet<string>,
  limit: number
): WebSearchResult[] {
  if (limit <= 0) {
    return [];
  }

  const normalizedAlreadyFetched = new Set<string>();
  const alreadyFetchedHosts = new Set<string>();
  for (const url of alreadyFetchedUrls) {
    const normalized = normalizePageUrl(url);
    if (normalized) {
      normalizedAlreadyFetched.add(normalized);
      alreadyFetchedHosts.add(resolveHost(normalized));
    }
  }

  const candidates: Array<{ result: WebSearchResult; normalizedUrl: string; host: string }> = [];
  for (const result of results) {
    const normalizedUrl = normalizePageUrl(result.url);
    if (!normalizedUrl || normalizedAlreadyFetched.has(normalizedUrl) || hasBinaryExtension(result.url)) {
      continue;
    }
    candidates.push({
      result,
      normalizedUrl,
      host: result.host || resolveHost(result.url)
    });
  }

  const selected: WebSearchResult[] = [];
  const selectedUrls = new Set<string>();
  const selectedHosts = new Set(alreadyFetchedHosts);

  for (const candidate of candidates) {
    if (selected.length >= limit) {
      break;
    }
    if (selectedHosts.has(candidate.host)) {
      continue;
    }
    selected.push(candidate.result);
    selectedUrls.add(candidate.normalizedUrl);
    selectedHosts.add(candidate.host);
  }

  if (selected.length < limit) {
    for (const candidate of candidates) {
      if (selected.length >= limit) {
        break;
      }
      if (selectedUrls.has(candidate.normalizedUrl)) {
        continue;
      }
      selected.push(candidate.result);
      selectedUrls.add(candidate.normalizedUrl);
    }
  }

  return selected;
}

export function buildFallbackResearchEvidence(
  question: string,
  results: WebSearchResult[],
  pages: ResearchPage[],
  maxChars = DEFAULT_RESEARCH_BUDGET.maxEvidenceChars
): string {
  const lines: string[] = [
    "## 结论",
    pages.length > 0
      ? `本轮围绕“${question}”读到了 ${pages.length} 个网页，下面只整理已经看到的内容。`
      : results.length > 0
        ? `本轮围绕“${question}”找到了 ${results.length} 条搜索结果，但还没有逐页核对。`
        : `本轮围绕“${question}”没有找到可用结果。`
  ];

  if (pages.length > 0) {
    lines.push("", "## 已读网页");
    for (const page of pages) {
      const excerpt = page.content.trim().slice(0, 600);
      lines.push(
        `[${page.sourceIndex}] ${page.title}`,
        excerpt ? `- 正文摘录：${excerpt}` : "- 正文摘录：无",
        ""
      );
    }
  }

  if (results.length > 0) {
    lines.push("## 搜索摘要（未逐页核对）");
    for (const result of results.slice(0, 5)) {
      lines.push(`- ${result.title} — ${result.url}`);
      if (result.snippet.trim()) {
        lines.push(`  ${result.snippet.trim()}`);
      }
    }
    lines.push("");
  }

  if (pages.length === 0) {
    lines.push("## 未覆盖", "- 还没有读到网页正文，结论需要后续继续核对。");
  }

  return trimContextTextToBudget(lines.join("\n").trim(), maxChars, "[证据已截断]").text;
}

/** 单页交给证据模型的相关段落预算；比整页上限小得多，避免导航和页脚占满输入。 */
const EVIDENCE_PASSAGE_PAGE_BUDGET = 6_000;
const EVIDENCE_PASSAGE_MAX_CHARS = 1_200;

function splitLongLine(line: string): string[] {
  const chunks: string[] = [];
  let rest = line.trim();
  while (rest.length > EVIDENCE_PASSAGE_MAX_CHARS) {
    const window = rest.slice(0, EVIDENCE_PASSAGE_MAX_CHARS);
    let cut = -1;
    for (const match of window.matchAll(/[。！？!?；;]\s*/g)) {
      cut = (match.index ?? 0) + match[0].length;
    }
    if (cut <= 0) {
      cut = EVIDENCE_PASSAGE_MAX_CHARS;
    }
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

function splitIntoEvidenceBlocks(content: string): string[] {
  const blocks: string[] = [];
  for (const rawBlock of content.split(/\n{2,}/)) {
    const block = rawBlock.trim();
    if (!block) {
      continue;
    }
    if (block.length <= EVIDENCE_PASSAGE_MAX_CHARS) {
      blocks.push(block);
      continue;
    }
    for (const line of block.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      blocks.push(...splitLongLine(trimmed));
    }
  }
  return blocks;
}

function collectPassageMatchTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const match of query.matchAll(/[A-Za-z0-9][A-Za-z0-9._+-]*/g)) {
    const token = match[0].toLowerCase();
    if (token.length >= 2) {
      tokens.add(token);
    }
  }
  for (const segment of query.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    tokens.add(segment);
    // 中文查询常以长词出现，补二元片段提高段落命中率。
    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.add(segment.slice(index, index + 2));
    }
  }
  return Array.from(tokens);
}

/**
 * 从整页 Markdown 里挑与问题相关的段落。
 *
 * 搜索页常见的导航、推荐位、页脚在正文里占很大比例；整页截断会把真正
 * 回答问题的段落挤掉。这里按查询词命中排序，再按原文顺序拼回，保留上下文。
 */
export function selectRelevantPassages(
  markdown: string,
  query: string,
  maxChars: number
): string {
  const blocks = splitIntoEvidenceBlocks(markdown);
  if (blocks.length === 0) {
    return "";
  }
  const budget = Math.max(400, Math.trunc(maxChars));
  const tokens = collectPassageMatchTokens(query);
  const scored = blocks.map((block, index) => {
    const normalizedBlock = block.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (normalizedBlock.includes(token)) {
        score += 1;
      }
    }
    if (index === 0) {
      // 首段通常是定义、摘要或发布时间，先给一点基础分。
      score += 1.5;
    }
    return { index, score };
  });

  const selected = new Set<number>();
  let usedChars = 0;
  const take = (index: number): void => {
    if (index < 0 || index >= blocks.length || selected.has(index)) {
      return;
    }
    const length = (blocks[index] ?? "").length + 2;
    if (usedChars + length > budget && usedChars > 0) {
      return;
    }
    selected.add(index);
    usedChars += length;
  };

  for (const item of [...scored].sort((left, right) => right.score - left.score || left.index - right.index)) {
    if (usedChars >= budget) {
      break;
    }
    if (item.score <= 0 && selected.size > 0) {
      continue;
    }
    take(item.index);
    take(item.index - 1);
    take(item.index + 1);
  }

  if (selected.size === 0) {
    for (let index = 0; index < blocks.length && usedChars < budget; index += 1) {
      take(index);
    }
  }

  return trimContextTextToBudget(
    Array.from(selected)
      .sort((left, right) => left - right)
      .map((index) => blocks[index])
      .join("\n\n"),
    budget,
    "[相关段落已截断]"
  ).text;
}

const CONTENT_DATE_PATTERN = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/;

/**
 * 从正文开头提取页面日期。只取前 600 字，避免把正文里的历史日期当成发布时间。
 */
export function extractContentDate(content: string): string | null {
  const match = content.slice(0, 600).match(CONTENT_DATE_PATTERN);
  if (!match) {
    return null;
  }
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  if (
    !Number.isFinite(year)
    || year < 1990
    || year > 2100
    || month < 1
    || month > 12
    || day < 1
    || day > 31
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function buildEvidenceInput(
  question: string,
  results: WebSearchResult[],
  pages: ResearchPage[],
  options: ResolvedResearchBudgetOptions
): string {
  const lines: string[] = [
    `研究问题：${question}`,
    ""
  ];

  if (pages.length > 0) {
    lines.push("已读网页：");
    for (const page of pages) {
      const pageBudget = Math.min(options.maxPageContentChars, EVIDENCE_PASSAGE_PAGE_BUDGET);
      const content = page.content.length > pageBudget
        ? selectRelevantPassages(page.content, question, pageBudget)
        : page.content;
      lines.push(
        `[${page.sourceIndex}] ${page.title}`,
        `URL: ${page.url}`,
        ...(page.publishedAt ? [`日期: ${page.publishedAt}`] : []),
        `摘要: ${page.snippet?.trim() || "无"}`,
        "正文:",
        content,
        ""
      );
    }
  }

  if (results.length > 0) {
    lines.push("未读全文的搜索结果：");
    for (const result of results.slice(0, 8)) {
      lines.push(
        `- ${result.title}`,
        `  URL: ${result.url}`,
        ...(result.publishedAt ? [`  日期: ${result.publishedAt}`] : []),
        `  摘要: ${result.snippet.trim() || "无"}`
      );
    }
    lines.push("");
  }

  if (pages.length === 0 && results.length === 0) {
    lines.push("本轮没有返回任何搜索结果。");
  }

  return trimContextTextToBudget(
    lines.join("\n").trim(),
    options.maxSourceInputChars,
    "[来源材料过长，已截断]"
  ).text;
}

function buildEmptyRoundResult(
  options: WebResearchRoundOptions,
  evidenceText: string,
  status: "partial" | "empty",
  searchError: string | null = null,
  queries: string[] = [],
  providerLabel = "Sidet",
  results: WebSearchResult[] = []
): ResearchRoundResult {
  return {
    round: options.round,
    question: options.question,
    queries,
    providerLabel,
    results,
    pages: [],
    failedPageCount: 0,
    evidenceText,
    resultBlock: buildSidetResearchResultBlock({
      round: options.round,
      question: options.question,
      queries,
      providerLabel,
      searchResultCount: results.length,
      sourceStart: options.sourceStart,
      pages: [],
      evidenceText
    }),
    status,
    searchError
  };
}

export async function runWebResearchRound(
  options: WebResearchRoundOptions
): Promise<ResearchRoundResult> {
  const { budget, question } = options;
  const progress = (stage: ResearchRoundProgress["stage"], message: string): void => {
    options.onProgress?.({ stage, message });
  };

  if (options.signal.aborted) {
    return buildEmptyRoundResult(options, "本轮检索已取消。", "empty");
  }

  if (budget.isExpired()) {
    const reason = budget.exhaustedReason() ?? "检索预算已用完。";
    progress("warning", reason);
    return buildEmptyRoundResult(options, reason, "empty");
  }

  if (budget.remainingQueries() <= 0) {
    const reason = "已达到查询预算上限。";
    progress("warning", reason);
    return buildEmptyRoundResult(options, reason, "empty");
  }

  const maxQueriesThisRound = Math.min(
    budget.options.maxQueriesPerRound,
    budget.remainingQueries()
  );

  const previousAttempts = options.previousAttempts ?? [];
  const allowDownloadWords = /下载|安装|客户端|\bapp\b|\bapk\b|\bipa\b/i.test(question);
  let queries: string[] = [];
  if (maxQueriesThisRound > 0 && budget.chargeModelCall()) {
    try {
      const rawQueries = await options.expandQueries(question, maxQueriesThisRound, previousAttempts);
      const parsedQueries = parseResearchQueries(
        rawQueries,
        Math.min(maxQueriesThisRound * 2, 8)
      );
      queries = sanitizeResearchQueries(parsedQueries, {
        limit: maxQueriesThisRound,
        previousQueries: previousAttempts.flatMap((attempt) => attempt.queries),
        allowDownloadWords
      });
      if (parsedQueries.length > queries.length) {
        progress(
          "queries",
          `已丢弃 ${parsedQueries.length - queries.length} 条过长、重复或含无关词的查询。`
        );
      }
    } catch (error) {
      progress("warning", `查询扩展失败：${toErrorMessage(error)}`);
    }
  }

  if (queries.length === 0) {
    queries = sanitizeResearchQueries(
      normalizeSearchQueries(buildFallbackSearchQueries(question), {
        limit: maxQueriesThisRound * 2
      }),
      { limit: maxQueriesThisRound, allowDownloadWords }
    );
  }
  if (queries.length === 0) {
    queries = normalizeSearchQueries([question], { limit: maxQueriesThisRound });
  }

  const allowedQueries = budget.chargeQueries(queries.length);
  queries = queries.slice(0, allowedQueries);
  if (queries.length === 0) {
    const reason = budget.exhaustedReason() ?? "本轮没有可执行的搜索词。";
    progress("warning", reason);
    return buildEmptyRoundResult(options, reason, "empty");
  }

  progress("queries", `检索词：${queries.join(" / ")}`);

  if (budget.isExpired()) {
    const reason = budget.exhaustedReason() ?? "检索预算已用完。";
    progress("warning", reason);
    return buildEmptyRoundResult(options, reason, "empty", null, queries);
  }

  if (options.signal.aborted) {
    return buildEmptyRoundResult(options, "本轮检索已取消。", "empty", null, queries);
  }

  let providerLabel = "Sidet";
  let results: WebSearchResult[] = [];
  let searchError: string | null = null;
  try {
    const payload = await options.searchMany(queries, (event) => {
      progress("search", event.message);
    });
    providerLabel = payload.providerLabel;
    results = payload.results;
  } catch (error) {
    searchError = toErrorMessage(error);
    progress("warning", `搜索失败：${searchError}`);
  }

  // 搜索源“没有结果”时经常返回别的热门页；先按问题与查询覆盖率丢掉明显无关的。
  const coverageAnchors = [question, ...queries];
  const relevantResults = results.filter((result) =>
    coverageAnchors.some((anchor) => passesQueryCoverage(result, anchor))
  );
  const droppedResultCount = results.length - relevantResults.length;
  results = relevantResults;
  progress(
    "search",
    droppedResultCount > 0
      ? `合并结果：${results.length} 条（丢弃 ${droppedResultCount} 条与问题无关的结果）。`
      : `合并结果：${results.length} 条。`
  );

  if (budget.isExpired()) {
    const reason = budget.exhaustedReason() ?? "检索预算已用完。";
    progress("warning", reason);
    return buildEmptyRoundResult(
      options,
      reason,
      results.length > 0 ? "partial" : "empty",
      searchError,
      queries,
      providerLabel,
      results
    );
  }

  if (options.signal.aborted) {
    return buildEmptyRoundResult(
      options,
      "本轮检索已取消。",
      "empty",
      searchError,
      queries,
      providerLabel,
      results
    );
  }

  const pageLimit = Math.min(budget.options.maxPagesPerRound, budget.remainingPages());
  const selectedPages = selectResearchPages(results, options.alreadyFetchedUrls, pageLimit);
  const allowedPages = budget.chargePages(selectedPages.length);
  const pagesToFetch = selectedPages.slice(0, allowedPages);

  progress("pages", `准备读取 ${pagesToFetch.length} 个网页。`);

  const fetched = await Promise.all(pagesToFetch.map(async (result) => {
    try {
      const page = await options.fetchPage(result.url);
      return { result, page };
    } catch (error) {
      progress("warning", `网页读取失败：${result.title || result.url}（${toErrorMessage(error)}）`);
      return { result, page: null };
    }
  }));

  const pages: ResearchPage[] = [];
  for (const outcome of fetched) {
    if (!outcome.page) {
      continue;
    }
    const pageUrl = outcome.page.url || outcome.result.url;
    pages.push({
      sourceIndex: options.sourceStart + pages.length,
      title: outcome.page.title || outcome.result.title,
      url: pageUrl,
      host: resolveHost(pageUrl),
      content: outcome.page.content,
      snippet: outcome.page.snippet ?? outcome.result.snippet,
      publishedAt: outcome.page.publishedAt
        ?? outcome.result.publishedAt
        ?? extractContentDate(outcome.page.content)
        ?? undefined
    });
  }
  const failedPageCount = pagesToFetch.length - pages.length;
  progress(
    "fetch",
    `读取网页：成功 ${pages.length} 个${failedPageCount > 0 ? `，失败 ${failedPageCount} 个` : ""}。`
  );

  if (options.signal.aborted) {
    return buildEmptyRoundResult(
      options,
      "本轮检索已取消。",
      "empty",
      searchError,
      queries,
      providerLabel,
      results
    );
  }

  const evidenceCharLimit = options.evidenceCharLimit ?? budget.options.maxEvidenceChars;
  const compressionCharLimit = options.compressionCharLimit ?? budget.options.maxEvidenceChars;
  const hasSearchMaterial = pages.length > 0 || results.length > 0;
  const evidenceInput = hasSearchMaterial
    ? buildEvidenceInput(question, results, pages, budget.options)
    : "";

  let evidenceText = "";
  const canUseRawEvidence = options.skipCompressionWhenFits === true
    && evidenceInput.length > 0
    && evidenceInput.length <= evidenceCharLimit;
  if (canUseRawEvidence) {
    evidenceText = trimContextTextToBudget(
      evidenceInput,
      evidenceCharLimit,
      "[证据已截断]"
    ).text;
  } else if (hasSearchMaterial && !budget.isExpired() && budget.chargeModelCall()) {
    try {
      const compressed = await options.compressEvidence(
        question,
        evidenceInput,
        compressionCharLimit
      );
      evidenceText = trimContextTextToBudget(
        compressed.trim(),
        compressionCharLimit,
        "[证据已截断]"
      ).text;
    } catch (error) {
      progress("warning", `证据整理失败：${toErrorMessage(error)}`);
    }
  }

  if (!evidenceText) {
    evidenceText = buildFallbackResearchEvidence(
      question,
      results,
      pages,
      evidenceCharLimit
    );
    progress("warning", "证据整理为空，已使用确定性摘要兜底。");
  }

  const status: ResearchRoundResult["status"] = pages.length > 0
    ? "ok"
    : results.length > 0
      ? "partial"
      : "empty";

  const resultBlock = buildSidetResearchResultBlock({
    round: options.round,
    question,
    queries,
    providerLabel,
    searchResultCount: results.length,
    sourceStart: options.sourceStart,
    pages: pages.map((page) => ({
      sourceIndex: page.sourceIndex,
      title: page.title,
      url: page.url
    })),
    searchResults: results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet
    })),
    evidenceText
  });

  progress("done", `本轮研究完成：读到 ${pages.length} 个网页正文。`);

  return {
    round: options.round,
    question,
    queries,
    providerLabel,
    results,
    pages,
    failedPageCount,
    evidenceText,
    resultBlock,
    status,
    searchError
  };
}
