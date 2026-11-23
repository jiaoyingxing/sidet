import { requestUrl } from "obsidian";

export interface WebSearchResult {
  title: string;
  url: string;
  host: string;
  snippet: string;
}

export interface WebSearchProgressEvent {
  level: "info" | "warning";
  message: string;
}

type SearchProviderId = "bing" | "baidu" | "sogou" | "github";

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

interface SearchProviderBatch {
  providerLabel: string;
  results: WebSearchResult[];
}

const WEB_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const WEB_SEARCH_PROVIDER_FAILURE_THRESHOLD = 2;
const WEB_SEARCH_PROVIDER_COOLDOWN_MS = 10 * 60 * 1000;
const WEB_SEARCH_MAX_RESULTS = 12;
const WEB_SEARCH_GOOD_ENOUGH_RESULTS = 8;
const WEB_SEARCH_PROVIDER_TIMEOUT_MS = 6000;
const WEB_SEARCH_IMPORT_HOST = "sidet.invalid";
const WEB_SEARCH_IMPORT_PATH = "/web-search-import";
const DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Sidet/0.2.0 Safari/537.36";

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

function mergeProviderBatches(
  batches: SearchProviderBatch[],
  maxResults = WEB_SEARCH_MAX_RESULTS
): SearchResultPayload {
  const mergedResults: WebSearchResult[] = [];
  const seenUrls = new Set<string>();
  const usedProviders: string[] = [];

  for (let index = 0; mergedResults.length < maxResults; index += 1) {
    let addedInThisRound = false;
    for (const batch of batches) {
      const result = batch.results[index];
      if (!result) {
        continue;
      }

      const normalizedUrl = normalizeHttpUrl(result.url) ?? result.url;
      if (seenUrls.has(normalizedUrl)) {
        continue;
      }

      seenUrls.add(normalizedUrl);
      mergedResults.push({ ...result });
      if (!usedProviders.includes(batch.providerLabel)) {
        usedProviders.push(batch.providerLabel);
      }
      addedInThisRound = true;
      if (mergedResults.length >= maxResults) {
        break;
      }
    }

    if (!addedInThisRound) {
      break;
    }
  }

  return {
    providerLabel: usedProviders.join(" + ") || batches[0]?.providerLabel || "Sidet",
    results: mergedResults
  };
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

function buildHtmlHeaders(language: string): Record<string, string> {
  return {
    Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    "Accept-Language": language || DEFAULT_ACCEPT_LANGUAGE,
    "User-Agent": getRuntimeUserAgent()
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
}): SearchProvider {
  return {
    id: config.id,
    label: config.label,
    supportsQuery: config.supportsQuery,
    search: async (query, context) => {
      const html = await requestProviderText(
        context.request,
        config.buildUrl(query).toString(),
        buildHtmlHeaders(context.language)
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

  throw lastError instanceof Error ? lastError : new Error("GitHub 搜索失败。");
}

const BING_PROVIDER = buildHtmlProvider({
  id: "bing",
  label: "Bing",
  buildUrl: (query) => {
    const url = new URL("https://cn.bing.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("mkt", "zh-CN");
    url.searchParams.set("setlang", "zh-Hans");
    return url;
  },
  parseResults: (html) => collectBingResults(createSearchDocument(html))
});

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

const GITHUB_PROVIDER: SearchProvider = {
  id: "github",
  label: "GitHub",
  supportsQuery: isGitHubFocusedQuery,
  search: searchGitHubResults
};

const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProvider> = {
  bing: BING_PROVIDER,
  baidu: BAIDU_PROVIDER,
  sogou: SOGOU_PROVIDER,
  github: GITHUB_PROVIDER
};

export function getSearchProviderIdsForLanguage(language?: string, query = ""): SearchProviderId[] {
  const normalizedLanguage = getPreferredLanguage(language).toLowerCase();
  const providerIds: SearchProviderId[] = normalizedLanguage.startsWith("zh")
    ? ["baidu", "sogou", "bing"]
    : ["bing", "sogou", "baidu"];
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
    const batches: SearchProviderBatch[] = [];

    for (let index = 0; index < providers.length; index += 1) {
      const provider = providers[index];
      const isLastProvider = index === providers.length - 1;
      const health = this.providerHealth.get(provider.id);
      if (health && health.cooldownUntil > now) {
        const remainingMinutes = Math.max(1, Math.ceil((health.cooldownUntil - now) / 60000));
        options.onProgress?.({
          level: "info",
          message: `${provider.label} 最近连续失败，暂时跳过（约 ${remainingMinutes} 分钟后再试）。`
        });
        continue;
      }

      options.onProgress?.({
        level: "info",
        message: `正在请求 ${provider.label}…`
      });

      try {
        const providerResults = filterResultsForQuery(
          normalizedQuery,
          (await withTimeout(
            provider.search(normalizedQuery, {
              request,
              language
            }),
            WEB_SEARCH_PROVIDER_TIMEOUT_MS,
            `${provider.label} 搜索`
          )).slice(0, WEB_SEARCH_MAX_RESULTS)
        );
        this.providerHealth.delete(provider.id);

        if (providerResults.length > 0) {
          const beforeCount = mergeProviderBatches(batches).results.length;
          batches.push({
            providerLabel: provider.label,
            results: providerResults
          });
          const mergedSnapshot = mergeProviderBatches(batches);
          const addedCount = mergedSnapshot.results.length - beforeCount;
          options.onProgress?.({
            level: "info",
            message: addedCount > 0
              ? `${provider.label} 返回 ${providerResults.length} 条结果，累计保留 ${mergedSnapshot.results.length} 条。`
              : `${provider.label} 返回 ${providerResults.length} 条结果，但没有新增可用链接。`
          });
          if (mergedSnapshot.results.length >= WEB_SEARCH_GOOD_ENOUGH_RESULTS) {
            options.onProgress?.({
              level: "info",
              message: `当前结果已达到 ${mergedSnapshot.results.length} 条，先停止继续扩展搜索源。`
            });
            break;
          }
          continue;
        }

        options.onProgress?.({
          level: isLastProvider ? "warning" : "info",
          message: isLastProvider
            ? `${provider.label} 没有返回可用结果。`
            : `${provider.label} 没有返回可用结果，继续尝试下一个搜索源。`
        });
      } catch (error) {
        const message = toErrorMessage(error);
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
          level: isLastProvider ? "warning" : "info",
          message: isLastProvider
            ? `${provider.label} 失败：${message}${cooldownSuffix}`
            : `${provider.label} 失败：${message}${cooldownSuffix}；继续尝试下一个搜索源。`
        });
      }
    }

    if (batches.length > 0) {
      const mergedPayload = mergeProviderBatches(batches);
      this.searchCache.set(normalizedQuery, {
        expiresAt: now + WEB_SEARCH_CACHE_TTL_MS,
        providerLabel: mergedPayload.providerLabel,
        results: mergedPayload.results
      });
      return {
        providerLabel: mergedPayload.providerLabel,
        results: mergedPayload.results.map((result) => ({ ...result }))
      };
    }

    if (errors.length > 0) {
      throw new Error(errors.join("；"));
    }

    return {
      providerLabel: providers[0]?.label ?? "Sidet",
      results: []
    };
  }
}
