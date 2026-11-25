import type { WebSearchResult } from "../../context/web-search-service";
import { trimContextTextToBudget } from "../context-bundle";
import { buildSidetResearchResultBlock } from "./sidet-protocol";
import {
  buildFallbackSearchQueries,
  normalizeSearchQueries
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
  expandQueries: (question: string, maxQueries: number) => Promise<string>;
  searchMany: (
    queries: string[],
    onProgress?: (event: { message: string }) => void
  ) => Promise<{ providerLabel: string; results: WebSearchResult[] }>;
  fetchPage: (url: string) => Promise<{
    title: string;
    url: string;
    content: string;
    snippet?: string;
  }>;
  compressEvidence: (question: string, evidenceInput: string, maxChars: number) => Promise<string>;
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

/**
 * 从模型输出里提取查询行。兼容 `query1: ...`、`1. ...`、`- ...` 和纯文本行；
 * 解析不出时返回空数组，由调用方走确定性兜底。
 */
export function parseResearchQueries(rawText: string, maxQueries: number): string[] {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const items = parsed.filter((item: unknown): item is string => typeof item === "string");
        return dedupeQueryLines(items, maxQueries);
      }
    } catch {
      // 不是合法 JSON 时继续按行解析。
    }
  }

  const withoutFences = trimmed
    .replace(/```[a-z-]*\s*/gi, "")
    .replace(/```/g, "");
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
      const content = trimContextTextToBudget(
        page.content,
        options.maxPageContentChars,
        "[本页正文过长，已截断]"
      ).text;
      lines.push(
        `[${page.sourceIndex}] ${page.title}`,
        `URL: ${page.url}`,
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

  let queries: string[] = [];
  if (maxQueriesThisRound > 0 && budget.chargeModelCall()) {
    try {
      const rawQueries = await options.expandQueries(question, maxQueriesThisRound);
      queries = parseResearchQueries(rawQueries, maxQueriesThisRound);
    } catch (error) {
      progress("warning", `查询扩展失败：${toErrorMessage(error)}`);
    }
  }

  if (queries.length === 0) {
    queries = normalizeSearchQueries(buildFallbackSearchQueries(question), {
      limit: maxQueriesThisRound
    });
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

  progress("search", `合并结果：${results.length} 条。`);

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
    pages.push({
      sourceIndex: options.sourceStart + pages.length,
      title: outcome.page.title || outcome.result.title,
      url: outcome.page.url || outcome.result.url,
      host: resolveHost(outcome.page.url || outcome.result.url),
      content: outcome.page.content,
      snippet: outcome.page.snippet ?? outcome.result.snippet
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

  let evidenceText = "";
  const hasSearchMaterial = pages.length > 0 || results.length > 0;
  if (hasSearchMaterial && !budget.isExpired() && budget.chargeModelCall()) {
    try {
      const compressed = await options.compressEvidence(
        question,
        buildEvidenceInput(question, results, pages, budget.options),
        budget.options.maxEvidenceChars
      );
      evidenceText = trimContextTextToBudget(
        compressed.trim(),
        budget.options.maxEvidenceChars,
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
      budget.options.maxEvidenceChars
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
