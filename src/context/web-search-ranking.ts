/**
 * 联网搜索结果的纯排序与合并规则。
 *
 * 这里不发起请求、不读写状态；WebSearchService 负责并发执行与缓存，
 * 本模块只回答“同一批结果里哪些更值得先给模型”。
 *
 * 排序由三部分组成：
 * - 排名分：结果在来源列表里的位置分，同一 URL 被多组搜索词命中时累加；
 * - 相关度：搜索词 token 是否出现在标题 / 摘要里；
 * - 时效：只在搜索词带“最新 / 最近 / 发布”等意图时，按结果里的可见日期加分。
 *
 * 站点多样性先按 host 限流；如果结果不足，再放开限流补足，避免单一站点
 * 把整页结果挤掉。
 */

export interface RankableWebSearchResult {
  title: string;
  url: string;
  host: string;
  snippet: string;
}

export interface SearchResultBatch<T extends RankableWebSearchResult = RankableWebSearchResult> {
  query: string;
  results: T[];
}

export interface MergeRankedSearchBatchesOptions {
  now?: Date;
  maxResults?: number;
  perHostLimit?: number;
}

const DEFAULT_MAX_RESULTS = 12;
const DEFAULT_PER_HOST_LIMIT = 3;
const MAX_RELEVANCE_SCORE = 6;

const FRESHNESS_INTENT_PATTERN =
  /最新|最近|今日|今天|昨天|本周|这周|本月|今年|刚刚|实时|新闻|快讯|发布|更新|上线|版本|价格|股价|比分|赛况|动态|进展/i;

/**
 * 站点质量只做“明显该排除 / 明显该优先”的粗判，不替代相关度。
 *
 * 搜索源是 Bing / 百度 / 搜狗的公开结果页，软件下载站和 App 介绍页在中文
 * 查询里占位很重；官方 / 文档 / 代码站则值得先读。规则按查询意图生效：
 * 用户明确要下载 App 时，不惩罚下载站。
 */
const DOWNLOAD_INTENT_PATTERN = /下载|安装|客户端|软件|app|apk|ipa|应用商店|应用市场/i;
const DOWNLOAD_HOST_PATTERNS: RegExp[] = [
  /(^|\.)pc6\.com$/,
  /(^|\.)cr173\.com$/,
  /(^|\.)ddooo\.com$/,
  /(^|\.)duote\.com$/,
  /(^|\.)onlinedown\.net$/,
  /(^|\.)xiazaizhijia\.com$/,
  /(^|\.)pcsoft\.com\.cn$/,
  /(^|\.)mydown\.com$/,
  /(^|\.)wandoujia\.com$/,
  /(^|\.)appchina\.com$/,
  /(^|\.)hiapk\.com$/,
  /(^|\.)apkpure\.com$/,
  /(^|\.)apkmirror\.com$/,
  /(^|\.)softonic\.com$/,
  /(^|\.)download\.com$/,
  /(^|\.)filehippo\.com$/,
  /(^|\.)majorgeeks\.com$/,
  /(^|\.)app\.mi\.com$/,
  /(^|\.)appgallery\.huawei\.com$/,
  /(^|\.)apps\.apple\.com$/,
  /(^|\.)play\.google\.com$/,
  /^download\./
];
const DOWNLOAD_TEXT_PATTERN = /下载|安装包|客户端|官方版|免费版|破解版|绿色版|apk|ipa/i;
const TECH_AUTHORITY_HOST_PATTERNS: RegExp[] = [
  /(^|\.)github\.com$/,
  /(^|\.)developer\.mozilla\.org$/,
  /(^|\.)wikipedia\.org$/,
  /(^|\.)docs\.python\.org$/,
  /(^|\.)nodejs\.org$/
];

const TRACKING_QUERY_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ref_src",
  "ref_url",
  "rsv_spt",
  "scm",
  "share_source",
  "share_token",
  "spm",
  "usg",
  "yclid"
]);

const DEDUPE_IGNORED_QUERY_PARAMS = new Set([
  ...TRACKING_QUERY_PARAMS,
  "eqid",
  "from",
  "from_source",
  "ref",
  "refer",
  "referrer",
  "sa",
  "source",
  "ved"
]);

function shouldDropQueryParam(key: string, forDedupe: boolean): boolean {
  const normalizedKey = key.toLowerCase();
  return normalizedKey.startsWith("utm_")
    || (forDedupe
      ? DEDUPE_IGNORED_QUERY_PARAMS.has(normalizedKey)
      : TRACKING_QUERY_PARAMS.has(normalizedKey));
}

function toHttpUrl(rawUrl: string): URL | null {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * 展示用 URL：保留站点自己的查询参数，只去掉 hash 和常见跟踪参数。
 */
export function normalizeSearchResultUrl(rawUrl: string): string | null {
  const url = toHttpUrl(rawUrl);
  if (!url) {
    return null;
  }
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (shouldDropQueryParam(key, false)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

/**
 * 去重键：host 去掉 `www.`、丢弃跟踪 / 来源参数、参数排序，避免同一篇文章
 * 因分享参数不同被当成两条结果。
 */
export function canonicalizeSearchResultUrl(rawUrl: string): string | null {
  const url = toHttpUrl(rawUrl);
  if (!url) {
    return null;
  }
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (shouldDropQueryParam(key, true)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname || "/";
  const search = url.searchParams.toString();
  return `${url.protocol}//${host}${path}${search ? `?${search}` : ""}`;
}

export function hasFreshnessIntent(query: string): boolean {
  return FRESHNESS_INTENT_PATTERN.test(query);
}

function buildLocalDate(year: number, month: number, day: number): number | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

/**
 * 从标题 / 摘要里解析可见日期。解析不到返回 null，不猜测。
 */
export function parseSearchResultDate(text: string, now: Date = new Date()): number | null {
  const fullDateMatch = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
  if (fullDateMatch) {
    return buildLocalDate(
      Number.parseInt(fullDateMatch[1] ?? "", 10),
      Number.parseInt(fullDateMatch[2] ?? "", 10),
      Number.parseInt(fullDateMatch[3] ?? "", 10)
    );
  }

  const monthDayMatch = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (monthDayMatch) {
    const month = Number.parseInt(monthDayMatch[1] ?? "", 10);
    const day = Number.parseInt(monthDayMatch[2] ?? "", 10);
    const currentYear = now.getFullYear();
    let timestamp = buildLocalDate(currentYear, month, day);
    if (timestamp !== null && timestamp > now.getTime() + 24 * 60 * 60 * 1000) {
      timestamp = buildLocalDate(currentYear - 1, month, day);
    }
    return timestamp;
  }

  const relativeMatch = text.match(/(\d{1,3})\s*(分钟|小时|天)\s*前/);
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1] ?? "", 10);
    const unit = relativeMatch[2] ?? "";
    const unitMs = unit === "分钟"
      ? 60 * 1000
      : unit === "小时"
        ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
    return now.getTime() - amount * unitMs;
  }

  if (/今天|今日/.test(text)) {
    return now.getTime();
  }
  if (/昨天|昨日/.test(text)) {
    return now.getTime() - 24 * 60 * 60 * 1000;
  }

  return null;
}

/**
 * 时效加分只在搜索词明确要“新东西”时生效；普通知识型问题不按时效重排。
 */
export function scoreSearchResultFreshness(
  result: Pick<RankableWebSearchResult, "title" | "snippet"> & { publishedAt?: string },
  query: string,
  now: Date = new Date()
): number {
  if (!hasFreshnessIntent(query)) {
    return 0;
  }
  const timestamp = parseSearchResultDate(
    `${result.publishedAt ?? ""} ${result.title} ${result.snippet}`,
    now
  );
  if (timestamp === null) {
    return 0;
  }
  const ageDays = (now.getTime() - timestamp) / (24 * 60 * 60 * 1000);
  if (ageDays <= 1) {
    return 2.2;
  }
  if (ageDays <= 7) {
    return 1.4;
  }
  if (ageDays <= 30) {
    return 0.6;
  }
  if (ageDays <= 365) {
    return 0.15;
  }
  return 0;
}

function containsLatinToken(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function collectQueryTokens(query: string): { latin: string[]; cjk: string[] } {
  const normalized = query.toLowerCase();
  const latin = Array.from(normalized.matchAll(/[a-z0-9][a-z0-9._+-]*/g))
    .map((match) => match[0])
    .filter((token) => token.length >= 2);
  const cjk = Array.from(normalized.matchAll(/[\u4e00-\u9fff]{2,}/g))
    .map((match) => match[0]);
  return {
    latin: Array.from(new Set(latin)),
    cjk: Array.from(new Set(cjk))
  };
}

function collectCjkBigrams(segment: string): string[] {
  if (segment.length < 4) {
    return [];
  }
  const bigrams: string[] = [];
  for (let index = 0; index < segment.length - 1; index += 1) {
    bigrams.push(segment.slice(index, index + 2));
  }
  return bigrams;
}

/**
 * 相关度是“标题命中 > 摘要命中”；中文长词额外用二元片段补召回。
 */
export function scoreSearchResultRelevance(
  result: Pick<RankableWebSearchResult, "title" | "snippet">,
  query: string
): number {
  const { latin, cjk } = collectQueryTokens(query);
  if (latin.length === 0 && cjk.length === 0) {
    return 0;
  }

  const title = result.title.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  let score = 0;

  for (const token of latin) {
    if (containsLatinToken(title, token)) {
      score += 2.5;
    } else if (containsLatinToken(snippet, token)) {
      score += 1;
    }
  }

  for (const segment of cjk) {
    if (title.includes(segment)) {
      score += 3;
    } else if (snippet.includes(segment)) {
      score += 1.5;
    } else {
      for (const bigram of collectCjkBigrams(segment)) {
        if (title.includes(bigram)) {
          score += 0.2;
        } else if (snippet.includes(bigram)) {
          score += 0.1;
        }
      }
    }
  }

  return Math.min(MAX_RELEVANCE_SCORE, score);
}

/**
 * 查询覆盖率闸门：结果必须在标题 / 摘要里真正覆盖查询的一部分。
 *
 * 搜索源在“没有结果”时经常返回别的热门页或词典页，而不是空列表；
 * 只看非空会把整批无关结果当成证据。这里用查询里的英文词与中文二元片段
 * 计覆盖率，低于阈值的结果不进入候选。
 */
const COVERAGE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "best", "top",
  "new", "how", "what", "why", "latest", "about", "into", "your"
]);
/** 时间 / 程度类中文词不单独作为必中片段，否则“最近”“重大”会把正常结果挡掉。 */
const COVERAGE_CJK_STOPWORDS = new Set([
  "最近", "最新", "今日", "今天", "昨日", "昨天", "本周", "这周",
  "本月", "今年", "目前", "重大", "重要", "相关", "热门", "全面"
]);

function collectCoverageRuns(query: string): string[][] {
  const runs: string[][] = [];
  for (const segment of query.toLowerCase().match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (COVERAGE_CJK_STOPWORDS.has(segment)) {
      continue;
    }
    if (segment.length === 2) {
      runs.push([segment]);
      continue;
    }
    const bigrams: string[] = [];
    for (let index = 0; index < segment.length - 1; index += 1) {
      bigrams.push(segment.slice(index, index + 2));
    }
    runs.push(bigrams);
  }
  return runs;
}

function collectCoverageLatinTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const match of query.toLowerCase().matchAll(/[a-z][a-z0-9._+-]*/g)) {
    const token = match[0];
    if (token.length >= 2 && !COVERAGE_STOPWORDS.has(token)) {
      terms.add(token);
    }
  }
  return Array.from(terms);
}

/**
 * 查询覆盖率闸门：结果必须在标题 / 摘要里真正覆盖查询的一部分。
 *
 * - 每个中文片段单独要求命中：地名页不能因为只提到地名就冒充“天气”答案；
 * - 长片段至少命中两个二元片段，避免只命中“开源”一个泛词；
 * - 英文词整体要求过半命中。
 *
 * 搜索源在“没有结果”时经常返回别的热门页或词典页，而不是空列表；
 * 这里把“无关但非空”挡在候选之外。
 */
export function passesQueryCoverage(
  result: Pick<RankableWebSearchResult, "title" | "snippet">,
  query: string
): boolean {
  const text = `${result.title} ${result.snippet}`.toLowerCase();
  const runs = collectCoverageRuns(query);
  const latinTerms = collectCoverageLatinTerms(query);
  if (runs.length === 0 && latinTerms.length === 0) {
    return true;
  }

  if (runs.length > 0) {
    const longestRunSize = Math.max(...runs.map((run) => run.length));
    let matchedRuns = 0;
    let longestRunMatched = false;

    for (const run of runs) {
      let matched = 0;
      for (const term of run) {
        if (text.includes(term)) {
          matched += 1;
        }
      }
      const required = run.length >= 5 ? 2 : 1;
      if (matched < required) {
        continue;
      }
      matchedRuns += 1;
      if (run.length === longestRunSize) {
        longestRunMatched = true;
      }
    }

    // 两段查询要求两段都命中（如「地名 + 天气」）；更多段时至少过半，
    // 且最长的一段必须命中，避免只命中泛词或地点。
    const requiredRuns = runs.length === 1
      ? 1
      : Math.max(2, Math.ceil(runs.length / 2));
    if (matchedRuns < requiredRuns || !longestRunMatched) {
      return false;
    }
  }

  if (latinTerms.length > 0) {
    let matchedLatin = 0;
    for (const term of latinTerms) {
      if (containsLatinToken(text, term)) {
        matchedLatin += 1;
      }
    }
    if (matchedLatin < Math.max(1, Math.ceil(latinTerms.length / 2))) {
      return false;
    }
  }

  return true;
}

function resolveResultHost(result: Pick<RankableWebSearchResult, "host" | "url">): string {
  const normalizedHost = result.host?.trim().toLowerCase();
  if (normalizedHost) {
    return normalizedHost;
  }
  try {
    return new URL(result.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * 站点质量分：没有下载意图时下载站降权，官方与文档站加权。
 *
 * 只影响同一批结果的先后，不改变返回数量；用户明确要下载 App 时不做降权。
 */
export function scoreSearchResultSourceQuality(
  result: Pick<RankableWebSearchResult, "title" | "snippet" | "host" | "url">,
  query: string
): number {
  const host = resolveResultHost(result).replace(/^www\./, "");
  const text = `${result.title} ${result.snippet}`;
  const wantsDownload = DOWNLOAD_INTENT_PATTERN.test(query);
  let score = 0;

  if (!wantsDownload) {
    const isDownloadHost = DOWNLOAD_HOST_PATTERNS.some((pattern) => pattern.test(host));
    if (isDownloadHost) {
      score -= 4;
    } else if (DOWNLOAD_TEXT_PATTERN.test(text)) {
      score -= 1.5;
    }
  }

  if (/(^|\.)gov\.cn$|(^|\.)edu\.cn$/.test(host)) {
    score += 1.5;
  }
  if (TECH_AUTHORITY_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    score += 1;
  }

  return score;
}

/**
 * 标题去重键：去掉站点后缀、大小写、空白和标点。
 *
 * 同一篇报道常被多个站点用同一标题转载；不分来源地排在一起会挤掉
 * 真正不同的信息。只对足够长的标题生效，避免“首页”“新闻”这类短标题误合并。
 */
function normalizeTitleKey(title: string): string {
  const withoutSiteSuffix = title.split(/\s+[-|_–—]\s+/)[0] ?? title;
  return withoutSiteSuffix
    .toLowerCase()
    .replace(/[\s\-_|–—·:：,，.。!！?？、;；()（）[\]【】"'“”]+/g, "")
    .replace(/(?:官网|官方网站|首页)$/g, "");
}

const MIN_DUPLICATE_TITLE_KEY_LENGTH = 10;

function isNearDuplicateTitle(title: string, seenTitleKeys: Set<string>): boolean {
  const key = normalizeTitleKey(title);
  if (key.length < MIN_DUPLICATE_TITLE_KEY_LENGTH) {
    return false;
  }
  if (seenTitleKeys.has(key)) {
    return true;
  }
  seenTitleKeys.add(key);
  return false;
}

function selectWithHostDiversity<T extends RankableWebSearchResult>(
  entries: Array<{ result: T; score: number; order: number }>,
  maxResults: number,
  perHostLimit: number
): T[] {
  const selected: Array<{ result: T; score: number; order: number }> = [];
  const remaining: Array<{ result: T; score: number; order: number }> = [];
  const hostCounts = new Map<string, number>();
  const titleKeys = new Set<string>();

  for (const entry of entries) {
    if (isNearDuplicateTitle(entry.result.title, titleKeys)) {
      continue;
    }
    const host = resolveResultHost(entry.result);
    const count = hostCounts.get(host) ?? 0;
    if (count < perHostLimit) {
      selected.push(entry);
      hostCounts.set(host, count + 1);
      if (selected.length >= maxResults) {
        return selected.map((item) => item.result);
      }
    } else {
      remaining.push(entry);
    }
  }

  for (const entry of remaining) {
    selected.push(entry);
    if (selected.length >= maxResults) {
      break;
    }
  }

  return selected.map((item) => item.result);
}

/**
 * 把多组“已按来源排好”的结果合并成一份：同一 URL 只留一条，多组命中累加分；
 * 分数高者在前，再用站点限流保证首屏不全是同一个站。
 */
export function mergeRankedSearchBatches<T extends RankableWebSearchResult>(
  batches: Array<SearchResultBatch<T>>,
  options: MergeRankedSearchBatchesOptions = {}
): T[] {
  const now = options.now ?? new Date();
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const perHostLimit = Math.max(1, options.perHostLimit ?? DEFAULT_PER_HOST_LIMIT);
  const merged = new Map<string, { result: T; score: number; order: number }>();
  let nextOrder = 0;

  for (const batch of batches) {
    const query = batch.query;
    batch.results.forEach((result, rank) => {
      const key = canonicalizeSearchResultUrl(result.url) ?? `raw:${result.url}`;
      const rankScore = 1 / (rank + 1);
      const score = rankScore
        + scoreSearchResultRelevance(result, query)
        + scoreSearchResultFreshness(result, query, now)
        + scoreSearchResultSourceQuality(result, query);
      const existing = merged.get(key);
      if (existing) {
        existing.score += score;
        if (result.snippet.length > existing.result.snippet.length) {
          existing.result = result;
        }
        return;
      }
      merged.set(key, {
        result,
        score,
        order: nextOrder
      });
      nextOrder += 1;
    });
  }

  const sorted = Array.from(merged.values()).sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.order - right.order;
  });

  return selectWithHostDiversity(sorted, maxResults, perHostLimit);
}
