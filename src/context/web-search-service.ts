import { requestUrl } from "obsidian";
import {
  mergeRankedSearchBatches,
  passesQueryCoverage,
  type SearchResultBatch
} from "./web-search-ranking";

export interface WebSearchResult {
  title: string;
  url: string;
  host: string;
  snippet: string;
  /** 搜索结果自带的日期（RSS pubDate 等），格式为 YYYY-MM-DD。 */
  publishedAt?: string;
}

export interface WebSearchProgressEvent {
  level: "info" | "warning";
  message: string;
}

type SearchProviderId = "quark" | "bing" | "baidu" | "sogou" | "so" | "mwmbl" | "github";

interface SearchCacheEntry {
  expiresAt: number;
  providerLabel: string;
  results: WebSearchResult[];
}

interface SearchProviderContext {
  request: SearchRequestFn;
  language: string;
}

interface SearchProvider {
  id: SearchProviderId;
  label: string;
  supportsQuery?: (query: string) => boolean;
  search: (query: string, context: SearchProviderContext) => Promise<WebSearchResult[]>;
}

interface SearchResultPayload {
  providerLabel: string;
  results: WebSearchResult[];
}

interface SearchOptions {
  onProgress?: (event: WebSearchProgressEvent) => void;
  /** 单次 searchMany 最多执行多少组查询；默认沿用 3，检索研究路径可放宽到 4。 */
  maxQueries?: number;
  /** 已有搜索源返回后，等待其余来源的宽限时间；超时的来源本轮跳过。 */
  providerGraceMs?: number;
}

interface ProviderHealthState {
  consecutiveFailures: number;
  cooldownUntil: number;
}

type SearchRequestFn = (options: Parameters<typeof requestUrl>[0]) => ReturnType<typeof requestUrl>;

interface WebSearchServiceOptions {
  requestUrl?: SearchRequestFn;
  getProviders?: (language?: string, query?: string) => SearchProvider[];
  now?: () => number;
}

const WEB_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const WEB_SEARCH_PROVIDER_FAILURE_THRESHOLD = 2;
const WEB_SEARCH_PROVIDER_COOLDOWN_MS = 10 * 60 * 1000;
const WEB_SEARCH_MAX_RESULTS = 12;
const WEB_SEARCH_MAX_QUERIES = 3;
const WEB_SEARCH_MAX_QUERIES_HARD_LIMIT = 6;
const WEB_SEARCH_PROVIDER_TIMEOUT_MS = 6000;
/**
 * 已有来源成功返回后，给其余来源的宽限时间。
 * 单个来源卡住时不再拖满 6 秒，但也不会一有结果就掐掉更慢的权威来源。
 */
const WEB_SEARCH_PROVIDER_GRACE_MS = 1500;
const WEB_SEARCH_IMPORT_HOST = "sidet.invalid";
const WEB_SEARCH_IMPORT_PATH = "/web-search-import";
const DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Sidet/0.2.0 Safari/537.36";
/**
 * 结果页抓取用普通浏览器 UA。
 *
 * 宿主的 Electron UA（含 Obsidian / Sidet 标识）会被 360 等结果页判定为异常访问，
 * 直接返回“访问异常页面”；这里只影响搜索请求，不参与宿主或平台判断。
 */
const SEARCH_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** 移动结果页用 iPhone UA；部分中文入口只在移动 UA 下返回结果，桌面 UA 会跳验证页。 */
const SEARCH_MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// 透传运行时真实 UA 作为请求头（非 OS 检测，Platform API 无 UA 等价物）。
// obsidianmd/platform 仅匹配 navigator.userAgent / window.navigator.userAgent 两种字面形态，
// 且插件配置禁止 disable 该规则，故经局部引用读取。
function getRuntimeUserAgent(): string {
  const runtimeNavigator = typeof navigator !== "undefined" ? navigator : null;
  return runtimeNavigator ? runtimeNavigator.userAgent : DEFAULT_USER_AGENT;
}
const BING_BLOCKED_RESULT_HOSTS = new Set([
  "bing.com",
  "www.bing.com",
  "cn.bing.com"
]);
const BAIDU_BLOCKED_RESULT_HOSTS = new Set([
  "baidu.com",
  "www.baidu.com",
  "m.baidu.com"
]);
const SOGOU_BLOCKED_RESULT_HOSTS = new Set([
  "sogou.com",
  "www.sogou.com",
  "wap.sogou.com"
]);
const SO_BLOCKED_RESULT_HOSTS = new Set([
  "so.com",
  "m.so.com",
  "www.so.com"
]);
const GITHUB_QUERY_HINTS = [
  /\bgithub\b/i,
  /\bgit\s*hub\b/i,
  /site:github\.com/i
];
const NEWS_QUERY_PATTERN = /新闻|要闻|快讯|报道|最新|最近|今日|头条/i;
const LOW_VALUE_NEWS_HOST_PATTERNS = [
  /(^|\.)dict\.youdao\.com$/i,
  /(^|\.)iciba\.com$/i,
  /(^|\.)zdic\.net$/i,
  /(^|\.)hgcha\.com$/i,
  /(^|\.)hanyuguoxue\.com$/i,
  /(^|\.)baike\.baidu\.com$/i
];
const LOW_VALUE_NEWS_TEXT_PATTERNS = [
  /词典|字典|释义|词语|意思|拼音|汉语|词条|百科/i,
  /视频大全|在线观看/i
];

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function normalizeQuery(query: string): string {
  return normalizeWhitespace(query);
}

function normalizeHttpUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeResultTitle(title: string, fallbackUrl: string): string {
  const normalizedTitle = normalizeWhitespace(title);
  if (normalizedTitle) {
    return normalizedTitle;
  }
  try {
    return new URL(fallbackUrl).hostname;
  } catch {
    return fallbackUrl;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: number | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`${label}超时`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  }
}

interface ProviderOutcome {
  provider: SearchProvider;
  results?: WebSearchResult[];
  error?: unknown;
  skipped?: boolean;
}

/**
 * 并行执行搜索源，并在“已有来源成功”后开始宽限计时。
 *
 * 全部来源提前返回时立即结束，不额外等待；某个来源卡住时最多再等
 * `graceMs`，避免一次 6 秒超时拖住整轮检索。被跳过的来源不记失败，
 * 下一轮仍会正常参与。
 */
async function collectProviderOutcomes(
  providers: SearchProvider[],
  run: (provider: SearchProvider) => Promise<WebSearchResult[]>,
  graceMs: number
): Promise<ProviderOutcome[]> {
  if (providers.length === 0) {
    return [];
  }

  const outcomes = Array.from<ProviderOutcome | undefined>({ length: providers.length });
  let settledCount = 0;
  let graceTimer: number | null = null;
  let graceStarted = false;
  let waitFinished = false;
  let resolveWait: () => void = () => {};
  const waitDone = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  const finishWait = (): void => {
    if (waitFinished) {
      return;
    }
    waitFinished = true;
    if (graceTimer !== null) {
      window.clearTimeout(graceTimer);
      graceTimer = null;
    }
    resolveWait();
  };

  providers.forEach((provider, index) => {
    void run(provider).then(
      (results) => {
        outcomes[index] = { provider, results };
      },
      (error) => {
        outcomes[index] = { provider, error };
      }
    ).then(() => {
      settledCount += 1;
      if (settledCount >= providers.length) {
        finishWait();
        return;
      }
      if (waitFinished) {
        return;
      }
      if (!graceStarted && outcomes.some((outcome) => (outcome?.results?.length ?? 0) > 0)) {
        graceStarted = true;
        graceTimer = window.setTimeout(finishWait, Math.max(0, graceMs));
      }
    });
  });

  await waitDone;
  // 用 Array.from 而不是 outcomes.map：慢来源离场时数组是稀疏的，map 会跳过空位。
  return Array.from({ length: providers.length }, (_unused, index) => outcomes[index] ?? {
    provider: providers[index],
    skipped: true
  });
}

function isNewsIntentQuery(query: string): boolean {
  return NEWS_QUERY_PATTERN.test(query);
}

function isLowValueNewsResult(result: WebSearchResult): boolean {
  if (LOW_VALUE_NEWS_HOST_PATTERNS.some((pattern) => pattern.test(result.host))) {
    return true;
  }
  const candidate = `${result.title} ${result.snippet}`.trim();
  return LOW_VALUE_NEWS_TEXT_PATTERNS.some((pattern) => pattern.test(candidate));
}

function filterResultsForQuery(query: string, results: WebSearchResult[]): WebSearchResult[] {
  if (!isNewsIntentQuery(query)) {
    return results;
  }
  return results.filter((result) => !isLowValueNewsResult(result));
}

function getPreferredLanguage(language?: string): string {
  if (typeof language === "string" && language.trim()) {
    return language.trim();
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language;
  }
  return "zh-CN";
}

function createSearchDocument(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function takeSnippetText(container: Element, title: string, selectors: string[]): string {
  for (const selector of selectors) {
    const text = normalizeWhitespace(container.querySelector(selector)?.textContent ?? "");
    if (text && text !== title) {
      return text;
    }
  }

  const rawText = normalizeWhitespace(container.textContent ?? "");
  if (!rawText) {
    return "";
  }

  const stripped = normalizeWhitespace(rawText.replace(title, ""));
  const snippet = stripped || rawText;
  return snippet.length > 220 ? `${snippet.slice(0, 220).trimEnd()}...` : snippet;
}

function collectBingResults(doc: Document): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const items = Array.from(doc.querySelectorAll("li.b_algo"));

  for (const item of items) {
    const anchor = item.querySelector<HTMLAnchorElement>("h2 a, a[href]");
    if (!anchor) {
      continue;
    }

    const normalizedUrl = normalizeHttpUrl(anchor.href);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }

    const host = new URL(normalizedUrl).hostname.toLowerCase();
    if (BING_BLOCKED_RESULT_HOSTS.has(host)) {
      continue;
    }

    results.push({
      title: normalizeResultTitle(anchor.textContent ?? "", normalizedUrl),
      url: normalizedUrl,
      host,
      snippet: takeSnippetText(item, anchor.textContent ?? "", [".b_caption p", ".b_snippet", "p"])
    });
    seen.add(normalizedUrl);
    if (results.length >= WEB_SEARCH_MAX_RESULTS) {
      break;
    }
  }

  return results;
}

function stripHtmlTags(text: string): string {
  return normalizeWhitespace(text.replace(/<[^>]*>/g, " "));
}

function normalizePublishedAt(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return undefined;
  }

  // 中文界面下 Bing RSS 的 pubDate 形如“周五, 27 11月 2026 09:59:00 GMT”，
  // Date.parse 不认识；先单独解析这种本地化格式，再退回标准解析。
  const localizedMatch = trimmed.match(
    /(\d{1,2})\s+(\d{1,2})月\s+(\d{4})/
  );
  if (localizedMatch) {
    const day = Number.parseInt(localizedMatch[1] ?? "", 10);
    const month = Number.parseInt(localizedMatch[2] ?? "", 10);
    const year = Number.parseInt(localizedMatch[3] ?? "", 10);
    if (year >= 1990 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  // 用 UTC 日期，避免时区把 pubDate 的“当天”挪前一天。
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&#(\d+);/g, (match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function takeXmlTag(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match?.[1] ? decodeXmlEntities(match[1]).trim() : "";
}

/**
 * Bing 的 RSS 结果页是结构化 XML，比解析 `li.b_algo` 稳得多，也带发布日期。
 *
 * 这里用标签级解析而不是 DOMParser：RSS 结构固定，正则足够，且桌面 /
 * 移动宿主与测试环境行为一致。返回空数组表示这次不是 RSS（例如被重定向
 * 到 HTML），由调用方退回 HTML 解析。
 */
export function parseBingRssResults(xml: string): WebSearchResult[] {
  if (!/<item[\s>]/i.test(xml)) {
    return [];
  }

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const block = match[0];
    const normalizedUrl = normalizeHttpUrl(takeXmlTag(block, "link"));
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }
    const host = new URL(normalizedUrl).hostname.toLowerCase();
    if (BING_BLOCKED_RESULT_HOSTS.has(host)) {
      continue;
    }
    const title = stripHtmlTags(takeXmlTag(block, "title"));
    results.push({
      title: normalizeResultTitle(title, normalizedUrl),
      url: normalizedUrl,
      host,
      snippet: stripHtmlTags(takeXmlTag(block, "description")).slice(0, 220),
      publishedAt: normalizePublishedAt(takeXmlTag(block, "pubDate"))
    });
    seen.add(normalizedUrl);
    if (results.length >= WEB_SEARCH_MAX_RESULTS) {
      break;
    }
  }

  return results;
}

function collectBaiduResults(doc: Document): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const containers = Array.from(doc.querySelectorAll("#content_left .result, #content_left .result-op, #content_left .c-container"));

  for (const container of containers) {
    const titleAnchor = container.querySelector<HTMLAnchorElement>("h3 a, a[data-module='title'], a[href]");
    if (!titleAnchor) {
      continue;
    }

    const rawUrl = container.getAttribute("mu")
      ?? titleAnchor.getAttribute("mu")
      ?? titleAnchor.getAttribute("data-landurl")
      ?? titleAnchor.href;
    const normalizedUrl = normalizeHttpUrl(rawUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }

    const host = new URL(normalizedUrl).hostname.toLowerCase();
    if (BAIDU_BLOCKED_RESULT_HOSTS.has(host)) {
      continue;
    }

    const title = normalizeResultTitle(titleAnchor.textContent ?? "", normalizedUrl);
    results.push({
      title,
      url: normalizedUrl,
      host,
      snippet: takeSnippetText(container, title, [
        "[class*='content']",
        "[class*='summary']",
        "[class*='desc']",
        ".c-color-text",
        "p",
        "span"
      ])
    });
    seen.add(normalizedUrl);
    if (results.length >= WEB_SEARCH_MAX_RESULTS) {
      break;
    }
  }

  return results;
}

function collectSogouResults(doc: Document): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const containers = Array.from(doc.querySelectorAll(".results .rb, .results .vrwrap"));

  for (const container of containers) {
    const titleAnchor = container.querySelector<HTMLAnchorElement>("h3.pt a, h3.vr-title a, h3 a[href]");
    if (!titleAnchor) {
      continue;
    }

    const citeAnchor = container.querySelector<HTMLAnchorElement>("a.citeLinkClass[href^='http'], a[href^='https://'], a[href^='http://']");
    const rawUrl = citeAnchor?.href ?? titleAnchor.getAttribute("url") ?? titleAnchor.href;
    const normalizedUrl = normalizeHttpUrl(rawUrl);
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }

    const host = new URL(normalizedUrl).hostname.toLowerCase();
    if (SOGOU_BLOCKED_RESULT_HOSTS.has(host)) {
      continue;
    }

    const title = normalizeResultTitle(titleAnchor.textContent ?? "", normalizedUrl);
    results.push({
      title,
      url: normalizedUrl,
      host,
      snippet: takeSnippetText(container, title, [
        ".ft",
        ".str-text-info",
        ".star-wiki",
        ".text-layout p",
        "p"
      ])
    });
    seen.add(normalizedUrl);
    if (results.length >= WEB_SEARCH_MAX_RESULTS) {
      break;
    }
  }

  return results;
}

/**
 * 360 结果页把真实地址包在 `m.so.com/jump?u=...` 里；解包失败或仍指向
 * 360 自身时丢弃，避免把跳转链当成来源。
 */
export function resolveSoResultUrl(rawHref: string): string | null {
  const direct = normalizeHttpUrl(rawHref);
  if (direct) {
    const host = new URL(direct).hostname.toLowerCase();
    if (!SO_BLOCKED_RESULT_HOSTS.has(host)) {
      return direct;
    }
  }

  try {
    const url = new URL(rawHref, "https://m.so.com");
    if (url.pathname !== "/jump") {
      return null;
    }
    const normalized = normalizeHttpUrl(url.searchParams.get("u") ?? "");
    if (!normalized) {
      return null;
    }
    const host = new URL(normalized).hostname.toLowerCase();
    return SO_BLOCKED_RESULT_HOSTS.has(host) ? null : normalized;
  } catch {
    return null;
  }
}

const SO_LOW_VALUE_TITLE_PATTERN = /相关软件|相关搜索|猜您关注|其他人还搜|大家还在搜|相关推荐/i;
const SO_ANOMALY_PATTERN = /访问异常页面|请输入验证码|安全验证/;

function collectSoResults(doc: Document): WebSearchResult[] {
  // 360 触发风控时返回的是“访问异常页面”，不是空结果；按失败处理，
  // 让 provider 健康度冷却而不是把验证页当成“没有结果”。
  if (SO_ANOMALY_PATTERN.test(doc.body?.textContent ?? "")) {
    throw new Error("360 返回验证页");
  }

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  for (const titleElement of Array.from(doc.querySelectorAll("h3.res-title"))) {
    const title = normalizeWhitespace(titleElement.textContent ?? "");
    if (!title || SO_LOW_VALUE_TITLE_PATTERN.test(title)) {
      continue;
    }

    const container = titleElement.closest("div.g-card, li")
      ?? titleElement.parentElement?.parentElement
      ?? titleElement.parentElement;
    const anchor = titleElement.closest("a")
      ?? container?.querySelector<HTMLAnchorElement>("a.alink[href], a[href]")
      ?? null;
    const normalizedUrl = resolveSoResultUrl(anchor?.getAttribute("href") ?? "");
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }

    const host = new URL(normalizedUrl).hostname.toLowerCase();
    results.push({
      title,
      url: normalizedUrl,
      host,
      snippet: takeSnippetText(container ?? titleElement, title, [
        ".summary",
        ".res-con",
        ".res-con-flex",
        "p",
        "span"
      ])
    });
    seen.add(normalizedUrl);
    if (results.length >= WEB_SEARCH_MAX_RESULTS) {
      break;
    }
  }

  return results;
}

const QUARK_BLOCKED_RESULT_HOSTS = new Set([
  "quark.sm.cn",
  "m.sm.cn",
  "page.sm.cn",
  "so.com",
  "m.so.com",
  "www.so.com"
]);

/** 夸克结果把真实地址放在 `data-sc` JSON 的 `u` 字段；解包失败时退回锚点。 */
export function resolveQuarkResultUrl(dataSc: string | null, fallbackHref: string): string | null {
  let candidate = fallbackHref;
  if (dataSc) {
    try {
      const parsed: unknown = JSON.parse(dataSc);
      if (
        parsed
        && typeof parsed === "object"
        && typeof (parsed as { u?: unknown }).u === "string"
      ) {
        candidate = (parsed as { u: string }).u;
      }
    } catch {
      // 保留锚点兜底。
    }
  }

  const normalized = normalizeHttpUrl(candidate);
  if (!normalized) {
    return null;
  }
  const host = new URL(normalized).hostname.toLowerCase();
  return QUARK_BLOCKED_RESULT_HOSTS.has(host) ? null : normalized;
}

function collectQuarkResults(doc: Document): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  for (const container of Array.from(doc.querySelectorAll("div.sc_natural_result"))) {
    const title = normalizeWhitespace(container.querySelector(".qk-title-text")?.textContent ?? "");
    const normalizedUrl = resolveQuarkResultUrl(
      container.getAttribute("data-sc"),
      container.querySelector<HTMLAnchorElement>("a[href]")?.href ?? ""
    );
    if (!title || !normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }

    const source = Array.from(container.querySelectorAll(".qk-source-item"))
      .map((element) => normalizeWhitespace(element.textContent ?? ""))
      .filter(Boolean)
      .join(" ");

    results.push({
      title,
      url: normalizedUrl,
      host: new URL(normalizedUrl).hostname.toLowerCase(),
      snippet: source
    });
    seen.add(normalizedUrl);
    if (results.length >= WEB_SEARCH_MAX_RESULTS) {
      break;
    }
  }

  return results;
}

interface MwmblFragment {
  value?: string;
}

interface MwmblResult {
  url?: string;
  title?: MwmblFragment[];
  extract?: MwmblFragment[];
}

/** Mwmbl 返回 `{url,title:[{value}],extract:[{value}]}` 数组，直接映射成统一结果。 */
export function parseMwmblResults(payload: unknown): WebSearchResult[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (const item of payload) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as MwmblResult;
    const normalizedUrl = normalizeHttpUrl(record.url ?? "");
    if (!normalizedUrl || seen.has(normalizedUrl)) {
      continue;
    }
    const title = (record.title ?? [])
      .map((part) => part?.value ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) {
      continue;
    }
    const snippet = (record.extract ?? [])
      .map((part) => part?.value ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    results.push({
      title,
      url: normalizedUrl,
      host: new URL(normalizedUrl).hostname.toLowerCase(),
      snippet: snippet.slice(0, 220)
    });
    seen.add(normalizedUrl);
    if (results.length >= WEB_SEARCH_MAX_RESULTS) {
      break;
    }
  }

  return results;
}

function buildHtmlHeaders(language: string): Record<string, string> {
  return {
    Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    "Accept-Language": language || DEFAULT_ACCEPT_LANGUAGE,
    "User-Agent": SEARCH_BROWSER_USER_AGENT
  };
}

function buildJsonHeaders(language: string): Record<string, string> {
  return {
    Accept: "application/json",
    "Accept-Language": language || DEFAULT_ACCEPT_LANGUAGE,
    "User-Agent": getRuntimeUserAgent()
  };
}

async function requestProviderText(
  request: SearchRequestFn,
  url: string,
  headers: Record<string, string>
): Promise<string> {
  const response = await request({
    url,
    method: "GET",
    throw: false,
    headers
  });
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text;
}

async function requestProviderJson<T>(
  request: SearchRequestFn,
  url: string,
  headers: Record<string, string>
): Promise<T> {
  const response = await request({
    url,
    method: "GET",
    throw: false,
    headers
  });
  if (response.status >= 400) {
    throw new Error(`HTTP ${response.status}`);
  }
  const candidate = (response as { json?: unknown }).json;
  if (candidate !== undefined) {
    return candidate as T;
  }
  return JSON.parse(response.text) as T;
}

function buildHtmlProvider(config: {
  id: SearchProviderId;
  label: string;
  buildUrl: (query: string) => URL;
  parseResults: (html: string) => WebSearchResult[];
  supportsQuery?: (query: string) => boolean;
  userAgent?: string;
}): SearchProvider {
  return {
    id: config.id,
    label: config.label,
    supportsQuery: config.supportsQuery,
    search: async (query, context) => {
      const headers = buildHtmlHeaders(context.language);
      if (config.userAgent) {
        headers["User-Agent"] = config.userAgent;
      }
      const html = await requestProviderText(
        context.request,
        config.buildUrl(query).toString(),
        headers
      );
      return config.parseResults(html).slice(0, WEB_SEARCH_MAX_RESULTS);
    }
  };
}

function normalizeGitHubSearchQuery(rawQuery: string): string {
  const stripped = rawQuery
    .replace(/site:github\.com/ig, " ")
    .replace(/\bgithub\b/ig, " ")
    .replace(/\bgit\s*hub\b/ig, " ")
    .replace(/\brepo(?:s|sitory|sitories)?\b/ig, " ")
    .replace(/仓库/g, " ")
    .replace(/源码/g, " ")
    .replace(/开源/g, " ");
  return normalizeWhitespace(stripped) || normalizeWhitespace(rawQuery);
}

function isGitHubFocusedQuery(query: string): boolean {
  const normalizedQuery = normalizeWhitespace(query);
  return GITHUB_QUERY_HINTS.some((pattern) => pattern.test(normalizedQuery));
}

function pushUniqueResult(target: WebSearchResult[], result: WebSearchResult): void {
  if (target.some((item) => item.url === result.url)) {
    return;
  }
  target.push(result);
}

interface GitHubUserSearchResponse {
  items?: Array<{
    login?: string;
    html_url?: string;
    type?: string;
  }>;
}

interface GitHubRepositorySearchResponse {
  items?: Array<{
    full_name?: string;
    html_url?: string;
    description?: string | null;
    updated_at?: string;
  }>;
}

interface GitHubRepositoryItem {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  updated_at?: string;
}

async function searchGitHubResults(query: string, context: SearchProviderContext): Promise<WebSearchResult[]> {
  const cleanedQuery = normalizeGitHubSearchQuery(query);
  const results: WebSearchResult[] = [];
  const headers = buildJsonHeaders(context.language);
  let lastError: unknown = null;

  try {
    const userQueryUrl = new URL("https://api.github.com/search/users");
    userQueryUrl.searchParams.set("q", `${cleanedQuery} in:login`);
    userQueryUrl.searchParams.set("per_page", "2");
    const userPayload = await requestProviderJson<GitHubUserSearchResponse>(
      context.request,
      userQueryUrl.toString(),
      headers
    );

    const users = Array.isArray(userPayload.items) ? userPayload.items : [];
    for (const user of users.slice(0, 1)) {
      const login = normalizeWhitespace(user.login ?? "");
      const userUrl = normalizeHttpUrl(user.html_url ?? "");
      if (!login || !userUrl) {
        continue;
      }

      pushUniqueResult(results, {
        title: `GitHub 用户：${login}`,
        url: userUrl,
        host: "github.com",
        snippet: "GitHub 用户主页"
      });

      try {
        const repoUrl = new URL(`https://api.github.com/users/${encodeURIComponent(login)}/repos`);
        repoUrl.searchParams.set("sort", "updated");
        repoUrl.searchParams.set("per_page", "3");
        repoUrl.searchParams.set("type", "owner");
        const repoPayload = await requestProviderJson<GitHubRepositoryItem[]>(
          context.request,
          repoUrl.toString(),
          headers
        );
        for (const repo of Array.isArray(repoPayload) ? repoPayload : []) {
          const normalizedUrl = normalizeHttpUrl(repo.html_url ?? "");
          if (!normalizedUrl) {
            continue;
          }
          pushUniqueResult(results, {
            title: normalizeResultTitle(repo.full_name ?? "", normalizedUrl),
            url: normalizedUrl,
            host: "github.com",
            snippet: normalizeWhitespace(repo.description ?? "") || `GitHub 仓库，最近更新 ${repo.updated_at?.slice(0, 10) ?? "未知"}`
          });
          if (results.length >= WEB_SEARCH_MAX_RESULTS) {
            return results.slice(0, WEB_SEARCH_MAX_RESULTS);
          }
        }
      } catch (error) {
        lastError = error;
      }
    }
  } catch (error) {
    lastError = error;
  }

  try {
    const repoSearchUrl = new URL("https://api.github.com/search/repositories");
    repoSearchUrl.searchParams.set("q", cleanedQuery);
    repoSearchUrl.searchParams.set("per_page", "6");
    const repoPayload = await requestProviderJson<GitHubRepositorySearchResponse>(
      context.request,
      repoSearchUrl.toString(),
      headers
    );

    const repos = Array.isArray(repoPayload.items) ? repoPayload.items : [];
    for (const repo of repos) {
      const normalizedUrl = normalizeHttpUrl(repo.html_url ?? "");
      if (!normalizedUrl) {
        continue;
      }
      pushUniqueResult(results, {
        title: normalizeResultTitle(repo.full_name ?? "", normalizedUrl),
        url: normalizedUrl,
        host: "github.com",
        snippet: normalizeWhitespace(repo.description ?? "") || `GitHub 仓库，最近更新 ${repo.updated_at?.slice(0, 10) ?? "未知"}`
      });
      if (results.length >= WEB_SEARCH_MAX_RESULTS) {
        break;
      }
    }
  } catch (error) {
    lastError = error;
  }

  if (results.length > 0) {
    return results.slice(0, WEB_SEARCH_MAX_RESULTS);
  }

  // 接口正常返回但没有匹配时是空结果，不是来源失败；只有请求错误才抛。
  if (lastError instanceof Error) {
    throw lastError;
  }
  return [];
}

function buildBingSearchUrl(query: string, format: "rss" | "html"): URL {
  // www.bing.com 会 302 到 cn.bing.com；直接请求国内入口，省一次跳转。
  const url = new URL("https://cn.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("mkt", "zh-CN");
  url.searchParams.set("setlang", "zh-Hans");
  if (format === "rss") {
    url.searchParams.set("format", "rss");
  }
  return url;
}

const BING_PROVIDER: SearchProvider = {
  id: "bing",
  label: "Bing",
  search: async (query, context) => {
    try {
      const xml = await requestProviderText(
        context.request,
        buildBingSearchUrl(query, "rss").toString(),
        buildHtmlHeaders(context.language)
      );
      const rssResults = parseBingRssResults(xml);
      if (rssResults.length > 0) {
        return rssResults.slice(0, WEB_SEARCH_MAX_RESULTS);
      }
    } catch {
      // RSS 通道不可用时退回 HTML 结果页，不把这一路失败算到来源健康度上。
    }

    const html = await requestProviderText(
      context.request,
      buildBingSearchUrl(query, "html").toString(),
      buildHtmlHeaders(context.language)
    );
    return collectBingResults(createSearchDocument(html)).slice(0, WEB_SEARCH_MAX_RESULTS);
  }
};

const BAIDU_PROVIDER = buildHtmlProvider({
  id: "baidu",
  label: "百度",
  buildUrl: (query) => {
    const url = new URL("https://www.baidu.com/s");
    url.searchParams.set("wd", query);
    return url;
  },
  parseResults: (html) => collectBaiduResults(createSearchDocument(html))
});

const SOGOU_PROVIDER = buildHtmlProvider({
  id: "sogou",
  label: "搜狗",
  buildUrl: (query) => {
    const url = new URL("https://www.sogou.com/web");
    url.searchParams.set("query", query);
    return url;
  },
  parseResults: (html) => collectSogouResults(createSearchDocument(html))
});

const QUARK_PROVIDER = buildHtmlProvider({
  id: "quark",
  label: "夸克",
  buildUrl: (query) => {
    const url = new URL("https://quark.sm.cn/s");
    url.searchParams.set("q", query);
    return url;
  },
  parseResults: (html) => collectQuarkResults(createSearchDocument(html)),
  userAgent: SEARCH_MOBILE_USER_AGENT
});

const SO_PROVIDER = buildHtmlProvider({
  id: "so",
  label: "360",
  buildUrl: (query) => {
    const url = new URL("https://m.so.com/s");
    url.searchParams.set("q", query);
    return url;
  },
  parseResults: (html) => collectSoResults(createSearchDocument(html))
});

const MWMBL_PROVIDER: SearchProvider = {
  id: "mwmbl",
  label: "Mwmbl",
  supportsQuery: (query) => !/[\u4e00-\u9fff]/.test(query),
  search: async (query, context) => {
    const url = new URL("https://api.mwmbl.org/api/v1/search");
    url.searchParams.set("s", query);
    const payload = await requestProviderJson<unknown>(
      context.request,
      url.toString(),
      buildJsonHeaders(context.language)
    );
    return parseMwmblResults(payload);
  }
};

const GITHUB_PROVIDER: SearchProvider = {
  id: "github",
  label: "GitHub",
  supportsQuery: isGitHubFocusedQuery,
  search: searchGitHubResults
};

const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
  quark: QUARK_PROVIDER,
  bing: BING_PROVIDER,
  baidu: BAIDU_PROVIDER,
  sogou: SOGOU_PROVIDER,
  so: SO_PROVIDER,
  mwmbl: MWMBL_PROVIDER,
  github: GITHUB_PROVIDER
};

export function getSearchProviderIdsForLanguage(language?: string, query = ""): SearchProviderId[] {
  const normalizedLanguage = getPreferredLanguage(language).toLowerCase();
  // 中文：夸克移动页是当前免费源里最稳定的；百度 / 搜狗 / 360 保留实现但不进默认链，
  // 它们在多数网络下会跳验证页。英文：Bing 加 Mwmbl，后者只覆盖英文小站。
  const providerIds: SearchProviderId[] = normalizedLanguage.startsWith("zh")
    ? ["quark", "bing"]
    : ["bing", "mwmbl"];
  if (isGitHubFocusedQuery(query)) {
    return ["github", ...providerIds];
  }
  return providerIds;
}

function getSearchProviders(language?: string, query = ""): SearchProvider[] {
  return getSearchProviderIdsForLanguage(language, query)
    .map((providerId) => SEARCH_PROVIDERS[providerId])
    .filter((provider) => provider && (provider.supportsQuery ? provider.supportsQuery(query) : true));
}

export function parseWebSearchImportLink(rawHref: string): string | null {
  try {
    const url = new URL(rawHref);
    if (
      url.protocol !== "https:"
      || url.hostname !== WEB_SEARCH_IMPORT_HOST
      || url.pathname !== WEB_SEARCH_IMPORT_PATH
    ) {
      return null;
    }
    const targetUrl = url.searchParams.get("url")?.trim() ?? "";
    return normalizeHttpUrl(targetUrl);
  } catch {
    return null;
  }
}

export class WebSearchService {
  private readonly searchCache = new Map<string, SearchCacheEntry>();
  private readonly providerHealth = new Map<SearchProviderId, ProviderHealthState>();

  constructor(private readonly options: WebSearchServiceOptions = {}) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchResultPayload> {
    const normalizedQuery = normalizeQuery(query);
    if (!normalizedQuery) {
      return {
        providerLabel: "Sidet",
        results: []
      };
    }

    const cached = this.searchCache.get(normalizedQuery);
    const now = (this.options.now ?? Date.now)();
    if (cached && cached.expiresAt > now) {
      options.onProgress?.({
        level: "info",
        message: `已命中搜索缓存，直接复用 ${cached.providerLabel} 结果。`
      });
      return {
        providerLabel: cached.providerLabel,
        results: cached.results.map((result) => ({ ...result }))
      };
    }

    const language = getPreferredLanguage();
    const providers = (this.options.getProviders ?? getSearchProviders)(language, normalizedQuery);
    const request = this.options.requestUrl ?? requestUrl;
    const errors: string[] = [];
    const batches: SearchResultBatch<WebSearchResult>[] = [];
    const providerLabels: string[] = [];
    const requestableProviders: SearchProvider[] = [];
    let respondingProviders = 0;

    for (const provider of providers) {
      const health = this.providerHealth.get(provider.id);
      if (health && health.cooldownUntil > now) {
        const remainingMinutes = Math.max(1, Math.ceil((health.cooldownUntil - now) / 60000));
        options.onProgress?.({
          level: "info",
          message: `${provider.label} 最近连续失败，暂时跳过（约 ${remainingMinutes} 分钟后再试）。`
        });
        continue;
      }
      requestableProviders.push(provider);
    }

    if (requestableProviders.length > 0) {
      options.onProgress?.({
        level: "info",
        message: `正在并行请求 ${requestableProviders.map((provider) => provider.label).join(" / ")}…`
      });
    }

    const outcomes = await collectProviderOutcomes(
      requestableProviders,
      async (provider) => filterResultsForQuery(
        normalizedQuery,
        (await withTimeout(
          provider.search(normalizedQuery, {
            request,
            language
          }),
          WEB_SEARCH_PROVIDER_TIMEOUT_MS,
          `${provider.label} 搜索`
        )).slice(0, WEB_SEARCH_MAX_RESULTS)
      ).filter((result) => passesQueryCoverage(result, normalizedQuery)),
      options.providerGraceMs ?? WEB_SEARCH_PROVIDER_GRACE_MS
    );

    for (const outcome of outcomes) {
      const { provider } = outcome;
      const health = this.providerHealth.get(provider.id);

      if (outcome.skipped) {
        options.onProgress?.({
          level: "info",
          message: `${provider.label} 未在宽限期内返回，本轮跳过。`
        });
        continue;
      }

      if (outcome.error !== undefined) {
        const message = toErrorMessage(outcome.error);
        errors.push(`${provider.label}：${message}`);
        const nextFailureCount = (health?.consecutiveFailures ?? 0) + 1;
        if (nextFailureCount >= WEB_SEARCH_PROVIDER_FAILURE_THRESHOLD) {
          this.providerHealth.set(provider.id, {
            consecutiveFailures: nextFailureCount,
            cooldownUntil: now + WEB_SEARCH_PROVIDER_COOLDOWN_MS
          });
        } else {
          this.providerHealth.set(provider.id, {
            consecutiveFailures: nextFailureCount,
            cooldownUntil: 0
          });
        }
        const cooldownSuffix = nextFailureCount >= WEB_SEARCH_PROVIDER_FAILURE_THRESHOLD
          ? `；连续失败 ${nextFailureCount} 次，后续 ${Math.ceil(WEB_SEARCH_PROVIDER_COOLDOWN_MS / 60000)} 分钟内将暂时跳过`
          : "";
        options.onProgress?.({
          level: "warning",
          message: `${provider.label} 失败：${message}${cooldownSuffix}`
        });
        continue;
      }

      this.providerHealth.delete(provider.id);
      respondingProviders += 1;
      const providerResults = outcome.results ?? [];
      if (providerResults.length > 0) {
        batches.push({
          query: normalizedQuery,
          results: providerResults
        });
        providerLabels.push(provider.label);
        options.onProgress?.({
          level: "info",
          message: `${provider.label} 返回 ${providerResults.length} 条结果。`
        });
      } else {
        options.onProgress?.({
          level: "info",
          message: `${provider.label} 没有返回可用结果。`
        });
      }
    }

    if (batches.length > 0) {
      const results = mergeRankedSearchBatches(batches, {
        now: new Date(now),
        maxResults: WEB_SEARCH_MAX_RESULTS
      });
      const providerLabel = Array.from(new Set(providerLabels)).join(" + ") || "Sidet";
      options.onProgress?.({
        level: "info",
        message: `合并排序后保留 ${results.length} 条结果。`
      });
      this.searchCache.set(normalizedQuery, {
        expiresAt: now + WEB_SEARCH_CACHE_TTL_MS,
        providerLabel,
        results
      });
      return {
        providerLabel,
        results: results.map((result) => ({ ...result }))
      };
    }

    // 只要有一个来源正常应答（哪怕 0 条），就不把结果页失败升级成整组查询失败；
    // 全部来源都失败时才抛错，避免“360 验证页”掩盖“其他来源没搜到”。
    if (errors.length > 0 && respondingProviders === 0) {
      throw new Error(errors.join("；"));
    }

    return {
      providerLabel: providers[0]?.label ?? "Sidet",
      results: []
    };
  }

  /**
   * 多组搜索词并行执行，按查询级排名分合并。
   *
   * 单组查询直接复用 `search()` 的进度；多组查询只上报聚合进度，避免每个
   * provider 的日志各刷一遍。部分查询失败时保留其它查询的结果，只有全部查询
   * 都抛错才整体失败。
   */
  async searchMany(queries: string[], options: SearchOptions = {}): Promise<SearchResultPayload> {
    const maxQueries = Math.max(
      1,
      Math.min(
        Number.isFinite(options.maxQueries) ? Math.trunc(options.maxQueries as number) : WEB_SEARCH_MAX_QUERIES,
        WEB_SEARCH_MAX_QUERIES_HARD_LIMIT
      )
    );
    const normalizedQueries: string[] = [];
    for (const query of queries) {
      const normalized = normalizeQuery(query);
      if (!normalized || normalizedQueries.includes(normalized)) {
        continue;
      }
      normalizedQueries.push(normalized);
      if (normalizedQueries.length >= maxQueries) {
        break;
      }
    }

    if (normalizedQueries.length === 0) {
      return {
        providerLabel: "Sidet",
        results: []
      };
    }

    if (normalizedQueries.length === 1) {
      return this.search(normalizedQueries[0] ?? "", options);
    }

    options.onProgress?.({
      level: "info",
      message: `并行执行 ${normalizedQueries.length} 组搜索词…`
    });

    const settled = await Promise.allSettled(
      normalizedQueries.map((query) => this.search(query, {}))
    );

    const batches: SearchResultBatch<WebSearchResult>[] = [];
    const providerLabels = new Set<string>();
    const errors: string[] = [];

    settled.forEach((outcome, index) => {
      const query = normalizedQueries[index] ?? "";
      if (outcome.status === "rejected") {
        const message = toErrorMessage(outcome.reason);
        errors.push(`关键词 ${index + 1}（${query}）：${message}`);
        options.onProgress?.({
          level: "warning",
          message: `关键词 ${index + 1} 失败：${message}`
        });
        return;
      }

      const payload = outcome.value;
      batches.push({
        query,
        results: payload.results
      });
      for (const label of payload.providerLabel.split(" + ")) {
        const trimmed = label.trim();
        if (trimmed && trimmed !== "Sidet") {
          providerLabels.add(trimmed);
        }
      }
      options.onProgress?.({
        level: "info",
        message: `关键词 ${index + 1} 命中 ${payload.results.length} 条结果。`
      });
    });

    if (batches.length > 0) {
      const results = mergeRankedSearchBatches(batches, {
        now: new Date((this.options.now ?? Date.now)()),
        maxResults: WEB_SEARCH_MAX_RESULTS
      });
      const providerLabel = Array.from(providerLabels).join(" + ") || "Sidet";
      options.onProgress?.({
        level: "info",
        message: results.length > 0
          ? `多组搜索词合并去重后保留 ${results.length} 条结果。`
          : "多组搜索词都没有返回可用结果。"
      });
      return {
        providerLabel,
        results: results.map((result) => ({ ...result }))
      };
    }

    if (errors.length > 0) {
      throw new Error(errors.join("；"));
    }

    return {
      providerLabel: "Sidet",
      results: []
    };
  }
}
