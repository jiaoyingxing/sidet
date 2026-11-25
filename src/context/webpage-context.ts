import Defuddle, { type DefuddleOptions } from "defuddle/full";
import { Readability } from "@mozilla/readability";
import { requestUrl } from "obsidian";
import TurndownService from "turndown";
import {
  formatContextBundleBlock,
  trimContextTextToBudget,
  type ContextBundle
} from "../agent/context-bundle";
import { makeId } from "../shared/paths";
import type { WebpageMessageAttachment } from "../types";

export interface WebUrlMatch {
  rawUrl: string;
  normalizedUrl: string;
  host: string;
  start: number;
  end: number;
}

interface ReadableDocumentResult {
  title: string;
  host: string;
  content: string;
  truncated: boolean;
}

interface PageMetadata {
  title: string;
  excerpt: string;
  host: string;
}

interface CachedWebpageAttachmentPayload {
  name: string;
  url: string;
  content: string;
  rawContent?: string;
  truncated: boolean;
  size: number;
}

interface CachedWebpageAttachmentEntry {
  expiresAt: number;
  payload: CachedWebpageAttachmentPayload;
}

type WebpageRequest = (
  request: Parameters<typeof requestUrl>[0]
) => PromiseLike<{ text: string }>;

interface WebpageContextServiceOptions {
  request?: WebpageRequest;
  requestTimeoutMs?: number;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[),.;!?]+$/;
const FALLBACK_ROOT_SELECTORS = [
  "article",
  "[itemprop='articleBody']",
  ".markdown-body",
  ".theme-doc-markdown",
  ".vp-doc",
  ".article-content",
  ".post-content",
  ".entry-content",
  ".doc-content",
  ".content",
  "main",
  "[role='main']",
  "body"
];
const WEIXIN_HOST = "mp.weixin.qq.com";
const WEIXIN_CONTENT_SELECTOR = "#js_content";
const WEBPAGE_ATTACHMENT_CACHE_TTL_MS = 15 * 60 * 1000;
const WEBPAGE_ATTACHMENT_CACHE_MAX_ENTRIES = 24;
const WEBPAGE_REQUEST_TIMEOUT_MS = 15_000;
const WEBPAGE_MAX_RESPONSE_CHARS = 1_000_000;
const WEBPAGE_MAX_CONTENT_CHARS = 24_000;

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`网页请求超时（${Math.ceil(timeoutMs / 1000)} 秒）。`));
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error("网页请求失败。"));
      }
    );
  });
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function extractMetaContent(doc: Document, key: string, attr: "name" | "property"): string {
  return doc.querySelector(`meta[${attr}="${key}"]`)?.getAttribute("content")?.trim() ?? "";
}

function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("当前只支持 http 或 https 网页链接。");
  }
  url.hash = "";
  return url.toString();
}

function stripTrailingUrlPunctuation(rawUrl: string): string {
  return rawUrl.replace(TRAILING_PUNCTUATION, "");
}

function createTurndownService(): TurndownService {
  return new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    preformattedCode: true
  });
}

function buildPageMetadata(doc: Document, normalizedUrl: string): PageMetadata {
  return {
    title:
      extractMetaContent(doc, "og:title", "property")
      || doc.querySelector("title")?.textContent?.trim()
      || doc.querySelector("h1")?.textContent?.trim()
      || new URL(normalizedUrl).hostname,
    excerpt:
      extractMetaContent(doc, "description", "name")
      || extractMetaContent(doc, "og:description", "property"),
    host: new URL(normalizedUrl).hostname
  };
}

function getNormalizedHost(normalizedUrl: string): string {
  return new URL(normalizedUrl).hostname.toLowerCase();
}

function ensureBaseTag(doc: Document, normalizedUrl: string): void {
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement("head"), doc.body ?? null);
  let baseEl = head.querySelector("base");
  if (!baseEl) {
    baseEl = doc.createElement("base");
    head.prepend(baseEl);
  }
  baseEl.setAttribute("href", normalizedUrl);
}

function absolutizeResourceUrls(root: ParentNode, normalizedUrl: string): void {
  const attributes = ["href", "src", "poster"];
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("[href], [src], [poster]"))) {
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute)?.trim();
      if (!value) {
        continue;
      }
      try {
        element.setAttribute(attribute, new URL(value, normalizedUrl).toString());
      } catch {
        continue;
      }
    }
  }
}

function htmlLooksLikeMarkup(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text);
}

function createPageDocument(html: string, normalizedUrl: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  ensureBaseTag(doc, normalizedUrl);
  return doc;
}

function isMeaningfulReadableText(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (normalized.length < 180) {
    return false;
  }

  const paragraphCount = normalized.split(/\n{2,}/).filter((part) => part.trim().length > 0).length;
  return paragraphCount >= 2 || normalized.length >= 420;
}

function stripLeadingDuplicateTitle(content: string, title: string): string {
  const normalizedTitle = normalizeWhitespace(title);
  if (!normalizedTitle) {
    return content;
  }

  const titleHeading = `# ${normalizedTitle}`;
  if (content.startsWith(`${titleHeading}\n`)) {
    return content.slice(titleHeading.length).trimStart();
  }
  if (content.startsWith(`${normalizedTitle}\n`)) {
    return content.slice(normalizedTitle.length).trimStart();
  }
  if (content === normalizedTitle || content === titleHeading) {
    return "";
  }
  return content;
}

function normalizeNoiseCandidate(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/!\[[^\]]*]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^[#>*\-\s]+/gm, "")
  );
}

function isLeadingNoiseBlock(block: string, normalizedHost: string): boolean {
  const normalizedBlock = normalizeNoiseCandidate(block);
  if (!normalizedBlock) {
    return false;
  }

  if (normalizedHost === WEIXIN_HOST) {
    return /在小说阅读器读本章/i.test(normalizedBlock)
      || /^去阅读$/i.test(normalizedBlock)
      || (normalizedBlock.includes("去阅读") && normalizedBlock.length <= 24);
  }

  return false;
}

function stripLeadingNoiseBlocks(content: string, host: string): string {
  const normalizedHost = host.toLowerCase();
  if (normalizedHost !== WEIXIN_HOST) {
    return content;
  }

  const blocks = normalizeMarkdown(content).split(/\n{2,}/);
  let index = 0;
  while (index < blocks.length && isLeadingNoiseBlock(blocks[index] ?? "", normalizedHost)) {
    index += 1;
  }

  if (index === 0) {
    return content;
  }

  return blocks.slice(index).join("\n\n").trimStart();
}

function buildDefuddleOptions(normalizedUrl: string): DefuddleOptions {
  const normalizedHost = getNormalizedHost(normalizedUrl);
  return {
    url: normalizedUrl,
    includeReplies: false,
    removeImages: false,
    separateMarkdown: true,
    useAsync: false,
    ...(normalizedHost === WEIXIN_HOST ? { contentSelector: WEIXIN_CONTENT_SELECTOR } : {})
  };
}

function finalizeReadableMarkdown(
  markdown: string,
  metadata: PageMetadata,
  normalizedUrl: string
): ReadableDocumentResult {
  let content = stripLeadingDuplicateTitle(normalizeMarkdown(markdown), metadata.title);
  content = stripLeadingNoiseBlocks(content, metadata.host);

  const fallbackExcerpt = stripLeadingNoiseBlocks(normalizeMarkdown(metadata.excerpt), metadata.host);
  if ((!content.trim() || !isMeaningfulReadableText(content)) && fallbackExcerpt) {
    content = fallbackExcerpt;
  }

  if (!content.trim()) {
    content = metadata.title || normalizedUrl;
  }
  const trimmed = trimContextTextToBudget(
    content,
    WEBPAGE_MAX_CONTENT_CHARS,
    "[网页正文过长，已截断]"
  );
  return {
    title: metadata.title,
    host: metadata.host,
    content: trimmed.text,
    truncated: trimmed.truncated
  };
}

function collectFallbackLines(root: ParentNode): string[] {
  const lines: string[] = [];
  const nodes = root.querySelectorAll("h1, h2, h3, p, li, blockquote, pre");

  for (const node of Array.from(nodes)) {
    const text = normalizeWhitespace(node.textContent ?? "");
    if (!text) {
      continue;
    }

    if (node.matches("h1")) {
      lines.push(`# ${text}`);
      continue;
    }
    if (node.matches("h2")) {
      lines.push(`## ${text}`);
      continue;
    }
    if (node.matches("h3")) {
      lines.push(`### ${text}`);
      continue;
    }
    if (node.matches("li")) {
      lines.push(`- ${text}`);
      continue;
    }
    if (node.matches("blockquote")) {
      lines.push(`> ${text}`);
      continue;
    }
    if (node.matches("pre")) {
      lines.push(`\`\`\`\n${text}\n\`\`\``);
      continue;
    }

    lines.push(text);
  }

  return lines;
}

function buildFallbackMarkdown(doc: Document, normalizedUrl: string, title: string, excerpt: string): string {
  let bestText = "";
  let bestScore = 0;

  for (const selector of FALLBACK_ROOT_SELECTORS) {
    for (const root of Array.from(doc.querySelectorAll(selector))) {
      const candidate = normalizeMarkdown(collectFallbackLines(root).join("\n\n"));
      if (!candidate) {
        continue;
      }
      const paragraphCount = candidate.split(/\n{2,}/).filter((part) => part.trim().length > 0).length;
      const score = candidate.length + paragraphCount * 32;
      if (score > bestScore) {
        bestScore = score;
        bestText = candidate;
      }
    }
  }

  let markdown = bestText || normalizeWhitespace(doc.body?.textContent ?? "");
  markdown = stripLeadingDuplicateTitle(markdown, title);

  if (!markdown.trim()) {
    markdown = excerpt || title || normalizedUrl;
  }

  return markdown;
}

function extractSiteSpecificMarkdown(doc: Document, normalizedUrl: string): string {
  const normalizedHost = getNormalizedHost(normalizedUrl);
  if (normalizedHost !== WEIXIN_HOST) {
    return "";
  }

  const contentRoot = doc.querySelector(WEIXIN_CONTENT_SELECTOR);
  if (!(contentRoot instanceof HTMLElement)) {
    return "";
  }

  absolutizeResourceUrls(contentRoot, normalizedUrl);
  return normalizeMarkdown(createTurndownService().turndown(contentRoot));
}

function extractDefuddleMarkdown(doc: Document, normalizedUrl: string): ReadableDocumentResult | null {
  const metadata = buildPageMetadata(doc, normalizedUrl);

  try {
    const result = new Defuddle(doc, buildDefuddleOptions(normalizedUrl)).parse();

    const rawMarkdown = result.contentMarkdown?.trim() ?? "";
    const rawContent = result.content?.trim() ?? "";
    let markdown = normalizeMarkdown(rawMarkdown);

    if (!markdown && rawContent) {
      if (htmlLooksLikeMarkup(rawContent)) {
        const contentDoc = createPageDocument(rawContent, normalizedUrl);
        ensureBaseTag(contentDoc, normalizedUrl);
        absolutizeResourceUrls(contentDoc, normalizedUrl);
        markdown = normalizeMarkdown(createTurndownService().turndown(contentDoc.body));
      } else {
        markdown = normalizeMarkdown(rawContent);
      }
    }

    const candidateMetadata: PageMetadata = {
      title: result.title?.trim() || metadata.title,
      excerpt: result.description?.trim() || metadata.excerpt,
      host: result.domain?.trim() || metadata.host
    };

    if (!isMeaningfulReadableText(markdown)) {
      return null;
    }

    return finalizeReadableMarkdown(markdown, candidateMetadata, normalizedUrl);
  } catch (error) {
    console.warn("Sidet：Defuddle 网页正文抽取失败，回退到 Readability。", error);
    return null;
  }
}

function extractReadableMarkdown(html: string, normalizedUrl: string): ReadableDocumentResult {
  const doc = createPageDocument(html, normalizedUrl);
  const defuddled = extractDefuddleMarkdown(doc, normalizedUrl);
  if (defuddled) {
    return defuddled;
  }

  const metadata = buildPageMetadata(doc, normalizedUrl);
  const siteSpecificMarkdown = extractSiteSpecificMarkdown(doc, normalizedUrl);
  if (isMeaningfulReadableText(siteSpecificMarkdown)) {
    return finalizeReadableMarkdown(siteSpecificMarkdown, metadata, normalizedUrl);
  }

  const readableDoc = doc.cloneNode(true) as Document;
  const article = new Readability<HTMLElement>(readableDoc, {
    charThreshold: 120,
    keepClasses: false,
    serializer: (node) => node as HTMLElement
  }).parse();

  let markdown = "";
  const title = article?.title?.trim() || metadata.title;
  const excerpt = article?.excerpt?.trim() || metadata.excerpt;

  const articleRoot = article?.content;
  if (articleRoot instanceof HTMLElement) {
    absolutizeResourceUrls(articleRoot, normalizedUrl);
    markdown = normalizeMarkdown(createTurndownService().turndown(articleRoot));
  }

  if (!isMeaningfulReadableText(markdown)) {
    markdown = buildFallbackMarkdown(doc, normalizedUrl, title, excerpt);
  }

  return finalizeReadableMarkdown(
    markdown,
    {
      title,
      excerpt,
      host: metadata.host
    },
    normalizedUrl
  );
}

function buildWebpageContextBundle(
  title: string,
  normalizedUrl: string,
  host: string,
  content: string,
  truncated: boolean
): ContextBundle {
  return {
    kind: "webpage",
    title: "引用网页：",
    sections: [
      {
        metadata: [
          { label: "标题", value: title },
          { label: "来源", value: normalizedUrl },
          { label: "站点", value: host },
          truncated ? { label: "说明", value: "已截断" } : { label: "说明", value: "" }
        ],
        content
      }
    ],
    truncated
  };
}

export function extractWebUrlMatches(text: string): WebUrlMatch[] {
  const matches: WebUrlMatch[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const rawMatch = match[0];
    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }

    const sanitizedUrl = stripTrailingUrlPunctuation(rawMatch);
    if (!sanitizedUrl) {
      continue;
    }

    try {
      const normalizedUrl = normalizeUrl(sanitizedUrl);
      matches.push({
        rawUrl: sanitizedUrl,
        normalizedUrl,
        host: new URL(normalizedUrl).hostname,
        start,
        end: start + sanitizedUrl.length
      });
    } catch {
      continue;
    }
  }

  return matches;
}

export class WebpageContextService {
  private readonly attachmentCache = new Map<string, CachedWebpageAttachmentEntry>();

  constructor(private readonly options: WebpageContextServiceOptions = {}) {}

  private pruneAttachmentCache(now: number): void {
    for (const [url, entry] of this.attachmentCache) {
      if (entry.expiresAt <= now) {
        this.attachmentCache.delete(url);
      }
    }
  }

  private cacheAttachment(
    normalizedUrl: string,
    payload: CachedWebpageAttachmentPayload
  ): void {
    const now = Date.now();
    this.pruneAttachmentCache(now);
    while (
      !this.attachmentCache.has(normalizedUrl)
      && this.attachmentCache.size >= WEBPAGE_ATTACHMENT_CACHE_MAX_ENTRIES
    ) {
      const oldestUrl = this.attachmentCache.keys().next().value;
      if (!oldestUrl) {
        break;
      }
      this.attachmentCache.delete(oldestUrl);
    }
    this.attachmentCache.set(normalizedUrl, {
      expiresAt: now + WEBPAGE_ATTACHMENT_CACHE_TTL_MS,
      payload
    });
  }

  async buildWebpageAttachment(rawUrl: string): Promise<WebpageMessageAttachment> {
    const normalizedUrl = normalizeUrl(rawUrl);
    const now = Date.now();
    this.pruneAttachmentCache(now);
    const cached = this.attachmentCache.get(normalizedUrl);
    if (cached && cached.expiresAt > now) {
      return {
        id: makeId("attachment"),
        type: "webpage",
        ...cached.payload
      };
    }

    let responseText = "";
    try {
      const request = this.options.request ?? requestUrl;
      // 透传真实 UA 作为请求头（非 OS 检测，Platform API 无 UA 等价物）；
      // obsidianmd/platform 仅字面匹配 navigator.userAgent / window.navigator.userAgent，经局部引用读取。
      const runtimeNavigator = navigator;
      const response = await withTimeout(
        request({
          url: normalizedUrl,
          method: "GET",
          headers: {
            Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
            "Accept-Language": navigator.language || "zh-CN,zh;q=0.9,en;q=0.8",
            "User-Agent": runtimeNavigator.userAgent
          }
        }),
        this.options.requestTimeoutMs ?? WEBPAGE_REQUEST_TIMEOUT_MS
      );
      responseText = response.text;
    } catch (error) {
      const message = error instanceof Error ? error.message : "网页请求失败。";
      throw new Error(`读取网页失败：${message}`);
    }

    if (!responseText.trim()) {
      throw new Error("网页返回为空，暂时没有可引用的内容。");
    }
    if (responseText.length > WEBPAGE_MAX_RESPONSE_CHARS) {
      throw new Error("网页响应过大，已停止读取。");
    }

    const { title, host, content, truncated } = extractReadableMarkdown(responseText, normalizedUrl);
    const bundle = buildWebpageContextBundle(title, normalizedUrl, host, content, truncated);
    const payload: CachedWebpageAttachmentPayload = {
      name: title,
      url: normalizedUrl,
      content: formatContextBundleBlock(bundle),
      rawContent: content,
      truncated,
      size: responseText.length
    };
    this.cacheAttachment(normalizedUrl, payload);
    return {
      id: makeId("attachment"),
      type: "webpage",
      ...payload
    };
  }
}
