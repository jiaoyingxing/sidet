const INTERNAL_PROCESS_TEXT_PATTERN = /[`]|sidet-|协议|系统规则|内部协议|联网能力|web_search|query\d*|pick\d*|reasoning/i;
const MALFORMED_SEARCH_BLOCK_PATTERN = /```sidet-search/i;
const MALFORMED_WEB_PROTOCOL_ATTEMPT_PATTERN = /(?:^|\n)\s*(?:```)?sidet-(?:search|fetch|direct)\b/i;
const SEARCH_REQUEST_FILLER_PATTERNS: RegExp[] = [
  /我想知道/gi,
  /我想了解/gi,
  /我想看/gi,
  /我想查/gi,
  /我想搜/gi,
  /你帮我/gi,
  /帮我/gi,
  /帮忙/gi,
  /麻烦你/gi,
  /请你?/gi,
  /请问/gi,
  /可以帮我/gi,
  /可以/gi,
  /能不能/gi,
  /能否/gi,
  /告诉我/gi,
  /帮(?:我)?(?:查|搜|搜索|找|看)(?:一下|一找|一搜|一查)?/gi,
  /(?:查|搜|搜索|找|看)(?:一下|一找|一搜|一查)?/gi
];
const SEARCH_QUESTION_FILLER_PATTERNS: RegExp[] = [
  /有哪些/gi,
  /有什么/gi,
  /是哪些/gi,
  /是什么/gi,
  /有关的?/gi,
  /相关的?/gi,
  /有啥/gi,
  /是啥/gi,
  /怎么回事/gi,
  /怎么样/gi,
  /如何/gi,
  /怎么/gi,
  /为什么/gi,
  /多少/gi,
  /几号/gi,
  /一下/gi,
  /啊/gi,
  /呀/gi,
  /吗/gi,
  /呢/gi,
  /吧/gi,
  /么/gi,
  /的/gi
];
const SEARCH_COMPOUND_SUFFIXES = [
  "新闻",
  "公告",
  "产品",
  "官网",
  "文档",
  "教程",
  "接口",
  "价格",
  "股票",
  "版本",
  "发布",
  "更新",
  "模型",
  "插件",
  "资料",
  "项目",
  "公司",
  "作者",
  "人物",
  "事件",
  "时间",
  "地点"
];
const SEARCH_STOPWORDS = new Set([
  "什么",
  "哪个",
  "哪些",
  "一下",
  "一下子",
  "一条",
  "一些",
  "这个",
  "那个",
  "这里",
  "那里",
  "请问",
  "帮我",
  "你帮我",
  "告诉我",
  "可以",
  "能否",
  "能不能",
  "以及",
  "有关",
  "相关"
]);
const MINIMAL_QUERY_FILLER_TOKENS = new Set([
  "从网上",
  "网上",
  "联网",
  "上网",
  "搜索",
  "搜一下",
  "查一下",
  "看一下",
  "找一下",
  "一下"
]);

function normalizeSearchToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) {
    return "";
  }
  const relatedMatch = trimmed.match(/^[跟和与](.+?)(有关|相关)$/);
  if (relatedMatch?.[1]) {
    return relatedMatch[1].trim();
  }
  return trimmed;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function formatDateToken(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function addDays(date: Date, offset: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + offset);
  return next;
}

function extractRelativeDateTokens(text: string, now = new Date()): string[] {
  const tokens: string[] = [];
  if (/今天|今日/i.test(text)) {
    tokens.push(formatDateToken(now));
  }
  if (/昨天|昨日/i.test(text)) {
    tokens.push(formatDateToken(addDays(now, -1)));
  }
  if (/明天|明日/i.test(text)) {
    tokens.push(formatDateToken(addDays(now, 1)));
  }
  if (/最新/i.test(text)) {
    tokens.push("最新");
  }
  if (/最近/i.test(text)) {
    tokens.push("最近");
  }
  return Array.from(new Set(tokens));
}

function extractSiteTokens(text: string): string[] {
  const tokens: string[] = [];
  if (/github|git\s*hub/i.test(text)) {
    tokens.push("GitHub");
  }
  if (/官网|官方网站/i.test(text)) {
    tokens.push("官网");
  }
  return Array.from(new Set(tokens));
}

function normalizeLatinToken(token: string): string {
  if (/^github$/i.test(token)) {
    return "GitHub";
  }
  return token.trim();
}

function splitCompoundCjkSegment(segment: string): string[] {
  const trimmed = segment.trim();
  if (!trimmed) {
    return [];
  }
  for (const suffix of SEARCH_COMPOUND_SUFFIXES) {
    if (!trimmed.endsWith(suffix) || trimmed.length <= suffix.length + 1) {
      continue;
    }
    const head = trimmed.slice(0, -suffix.length).trim();
    if (head.length < 2) {
      continue;
    }
    return [head, suffix];
  }
  return [trimmed];
}

function normalizeCjkTokens(text: string): string[] {
  const tokens: string[] = [];
  const matches = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const segment of matches) {
    for (const token of splitCompoundCjkSegment(segment)) {
      const normalized = token.trim();
      if (normalized.length < 2 || SEARCH_STOPWORDS.has(normalized)) {
        continue;
      }
      tokens.push(normalized);
    }
  }
  return tokens;
}

function buildSearchKeywordVariants(rawQuery: string, now = new Date()): string[] {
  const normalized = normalizeWhitespace(rawQuery)
    .replace(/github/gi, " GitHub ")
    .replace(/git\s*hub/gi, " GitHub ")
    .replace(/官方网站/g, " 官网 ")
    .replace(/[“”"'`]/g, " ")
    .replace(/[，,。！？!?、:：；;（）()[\]【】<>《》]/g, " ");

  const dateTokens = extractRelativeDateTokens(normalized, now);
  const siteTokens = extractSiteTokens(normalized);

  let working = normalized
    .replace(/今天|今日|昨天|昨日|明天|明日/gi, " ")
    .replace(/\bGitHub\b/g, " ")
    .replace(/官网/g, " ");

  for (const pattern of SEARCH_REQUEST_FILLER_PATTERNS) {
    working = working.replace(pattern, " ");
  }
  for (const pattern of SEARCH_QUESTION_FILLER_PATTERNS) {
    working = working.replace(pattern, " ");
  }

  working = normalizeWhitespace(working);

  const keywordTokens: string[] = [];
  const seenTokens = new Set<string>();
  for (const match of working.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]*|[\u4e00-\u9fff]{2,}/g)) {
    const rawToken = match[0];
    const nextTokens = /[\u4e00-\u9fff]/.test(rawToken)
      ? normalizeCjkTokens(rawToken)
      : [normalizeLatinToken(rawToken)];
    for (const token of nextTokens) {
      if (!token || seenTokens.has(token)) {
        continue;
      }
      seenTokens.add(token);
      keywordTokens.push(token);
    }
  }
  const fullTokens = Array.from(new Set([...dateTokens, ...siteTokens, ...keywordTokens]));
  const variants: string[] = [];
  const primary = fullTokens.join(" ").trim();
  const secondary = keywordTokens.join(" ").trim();
  if (primary) {
    variants.push(primary);
  }
  if (secondary && secondary !== primary) {
    variants.push(secondary);
  }
  return variants;
}

export function normalizeSearchQueries(
  queries: string[],
  options: {
    limit?: number;
  } = {}
): string[] {
  const limit = options.limit ?? 3;
  const normalizedQueries: string[] = [];

  for (const query of queries) {
    const normalized = normalizeWhitespace(query)
      .replace(/[“”"'`]/g, " ")
      .replace(/[，,。！？!?、:：；;（）()[\]【】<>《》]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      continue;
    }

    const tokens = normalized
      .split(" ")
      .map((token) => normalizeSearchToken(token))
      .filter(Boolean);
    const filteredTokens = tokens.filter((token) => !MINIMAL_QUERY_FILLER_TOKENS.has(token));
    const nextQuery = normalizeWhitespace((filteredTokens.length > 0 ? filteredTokens : tokens).join(" "));
    if (!nextQuery || normalizedQueries.includes(nextQuery)) {
      continue;
    }
    normalizedQueries.push(nextQuery);
    if (normalizedQueries.length >= limit) {
      return normalizedQueries.slice(0, limit);
    }
  }

  return normalizedQueries.slice(0, limit);
}

function ensureSentenceEnding(text: string): string {
  if (/[。！？!?…]$/.test(text)) {
    return text;
  }
  return `${text}。`;
}

export function pickVisibleProcessNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim();
  if (!trimmed) {
    return null;
  }
  if (INTERNAL_PROCESS_TEXT_PATTERN.test(trimmed)) {
    return null;
  }
  const collapsed = trimmed.replace(/\s+/g, " ");
  const shortened = collapsed.length > 160 ? `${collapsed.slice(0, 160).trimEnd()}…` : collapsed;
  return ensureSentenceEnding(shortened);
}

export function shouldRecoverMalformedSearchRouting(routingReplyContent: string): boolean {
  return MALFORMED_SEARCH_BLOCK_PATTERN.test(routingReplyContent) || isMalformedWebSearchProtocolReply(routingReplyContent);
}

export function isMalformedWebSearchProtocolReply(replyContent: string): boolean {
  const trimmed = replyContent.trim();
  if (!trimmed) {
    return false;
  }
  return MALFORMED_WEB_PROTOCOL_ATTEMPT_PATTERN.test(trimmed);
}

export function buildFallbackSearchQueries(originalQuery: string): string[] {
  const variants = buildSearchKeywordVariants(originalQuery, new Date());
  if (variants.length > 0) {
    return variants.slice(0, 3);
  }
  return normalizeSearchQueries([originalQuery], { limit: 3 });
}
