import { formatFileDatePrefix } from "../../shared/time";
import {
  buildWikiConceptPageTemplateWith,
  buildWikiIndexTemplateWith,
  buildWikiSchemaGuidanceLines
} from "./wiki-note-schema-templates";

export const WIKI_NOTE_KIND_KNOWLEDGE_CARD = "knowledge-card";
export const WIKI_NOTE_KIND_CONCEPT_PAGE = "concept-page";
export const WIKI_NOTE_KIND_SUPPORTING_NOTE = "supporting-note";
export const WIKI_NOTE_KIND_KNOWLEDGE_BASE = "knowledge-base";
export const WIKI_INDEX_FILE_NAME = "Index.md";

export type WikiNoteKind =
  | typeof WIKI_NOTE_KIND_KNOWLEDGE_CARD
  | typeof WIKI_NOTE_KIND_CONCEPT_PAGE
  | typeof WIKI_NOTE_KIND_SUPPORTING_NOTE
  | typeof WIKI_NOTE_KIND_KNOWLEDGE_BASE;

export interface WikiNoteSchemaFields {
  kind: WikiNoteKind;
  summary: string;
  aliases?: string[];
  keywords?: string[];
  parents?: string[];
  children?: string[];
  related?: string[];
  sources?: string[];
  status?: string;
  updatedAt?: string;
}

interface WikiNoteBuildOptions {
  title: string;
  body: string;
  fields: WikiNoteSchemaFields;
}

export interface NormalizedWikiDraft {
  title: string;
  body: string;
  fields: Partial<WikiNoteSchemaFields>;
}

interface BuildNormalizedWikiOptions {
  defaultKind?: WikiNoteKind;
  updatedAt?: string;
  preserveUpdatedAt?: boolean;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd();
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function normalizeFrontmatterStringList(value: unknown): string[] {
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

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && (
      (trimmed.startsWith("\"") && trimmed.endsWith("\""))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    )
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function pushYamlStringArray(lines: string[], key: string, values: string[]): void {
  if (values.length === 0) {
    lines.push(`${key}: []`);
    return;
  }
  lines.push(`${key}:`);
  for (const value of values) {
    lines.push(`  - ${quoteYaml(value)}`);
  }
}

function pushOptionalYamlStringArray(lines: string[], key: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }
  pushYamlStringArray(lines, key, values);
}

function stripFrontmatter(markdown: string): string {
  const normalized = normalizeText(markdown);
  return normalized.startsWith("---")
    ? normalized.replace(/^---[\s\S]*?---/, "").trim()
    : normalized;
}

function stripFirstHeading(markdown: string): string {
  const body = stripFrontmatter(markdown);
  const lines = body.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex < 0) {
    return body;
  }

  if (/^#{1,2}\s+/.test(lines[firstContentIndex].trim())) {
    lines.splice(firstContentIndex, 1);
  }
  return lines.join("\n").trim();
}

function normalizeTitleForCompare(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

function titlesEquivalent(left: string, right: string): boolean {
  return normalizeTitleForCompare(left) === normalizeTitleForCompare(right);
}

function fileStem(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lastSegment = normalized.split("/").pop() ?? "";
  return lastSegment.replace(/\.md$/i, "").trim();
}

function stripLeadingTitleHeading(markdown: string, title: string): string {
  const body = stripFrontmatter(markdown);
  const lines = body.split("\n");

  while (true) {
    const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
    if (firstContentIndex < 0) {
      return "";
    }

    const match = lines[firstContentIndex]?.trim().match(/^#{1,2}\s+(.+)$/);
    if (!match || !titlesEquivalent(match[1] ?? "", title)) {
      break;
    }

    lines.splice(firstContentIndex, 1);
  }

  return lines.join("\n").trim();
}

function extractLeadingWikiTitle(markdown: string): string | null {
  const lines = stripFrontmatter(normalizeText(markdown)).split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^#?\s*[A-Za-z_][\w-]*\s*:/.test(line)) {
      continue;
    }

    const headingMatch = line.match(/^#{1,2}\s+(.+)$/);
    return headingMatch?.[1]?.trim() ?? null;
  }

  return null;
}

function hasSecondLevelHeading(body: string): boolean {
  return /^##\s+.+$/m.test(body);
}

interface ParsedWikiSections {
  preface: string[];
  sections: Array<{
    title: string;
    lines: string[];
  }>;
}

function normalizeScaffoldSection(sectionTitle: string, contentLines: string[]): string {
  const normalizedLines = contentLines
    .map((line) => line.trimEnd())
    .filter((line, index, lines) => {
      if (line.trim().length > 0) {
        return true;
      }
      const previous = lines[index - 1]?.trim().length ?? 0;
      const next = lines[index + 1]?.trim().length ?? 0;
      return previous > 0 && next > 0;
    });

  const body = normalizedLines.join("\n").trim();
  return body.length > 0
    ? `## ${sectionTitle}\n${body}`
    : `## ${sectionTitle}`;
}

function parseSecondLevelSections(body: string): ParsedWikiSections {
  const lines = normalizeText(body).split("\n");
  const preface: string[] = [];
  const sections: Array<{ title: string; lines: string[] }> = [];
  let currentSection: { title: string; lines: string[] } | null = null;

  for (const line of lines) {
    const sectionMatch = line.trim().match(/^##\s+(.+)$/);
    if (sectionMatch) {
      if (currentSection) {
        sections.push(currentSection);
      }
      currentSection = {
        title: sectionMatch[1]?.trim() || "",
        lines: []
      };
      continue;
    }

    if (currentSection) {
      currentSection.lines.push(line);
      continue;
    }

    preface.push(line);
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  return {
    preface,
    sections
  };
}

function mergeSectionLines(
  existingLines: string[] | undefined,
  incomingLines: string[],
  prepend = false
): string[] {
  const existing = existingLines ?? [];
  if (incomingLines.length === 0) {
    return [...existing];
  }

  if (existing.length === 0) {
    return [...incomingLines];
  }

  return prepend
    ? [...incomingLines, "", ...existing]
    : [...existing, "", ...incomingLines];
}

function formatRelatedLine(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("[[") || /^https?:\/\//i.test(trimmed) || /^\[.+\]\(.+\)$/.test(trimmed)) {
    return `- ${trimmed}`;
  }

  return `- [[${trimmed.replace(/\.md$/i, "")}]]`;
}

function formatSourceLine(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `- ${trimmed}` : "";
}

function buildBulletLines(values: string[], formatter: (value: string) => string): string[] {
  return values
    .map((value) => formatter(value))
    .filter(Boolean);
}

function hasMeaningfulSectionContent(lines: string[] | undefined): boolean {
  return (lines ?? []).some((line) => line.trim().length > 0);
}

function buildRequiredWikiSections(
  kind: WikiNoteKind,
  summary: string,
  fallbackBody: string,
  related: string[],
  sources: string[]
): Array<{ title: string; lines: string[] }> {
  const relatedLines = buildBulletLines(related, formatRelatedLine);
  const sourceLines = buildBulletLines(sources, formatSourceLine);

  switch (kind) {
    case WIKI_NOTE_KIND_KNOWLEDGE_BASE:
    case WIKI_NOTE_KIND_CONCEPT_PAGE:
      return [
        {
          title: "概要",
          lines: summary ? [`- ${summary}`] : ["- 待补一句范围和职责。"]
        },
        {
          title: "先读",
          lines: []
        },
        {
          title: "主题",
          lines: fallbackBody ? [fallbackBody] : ["- 待补主题入口。"]
        },
        {
          title: "相关",
          lines: relatedLines
        }
      ];
    case WIKI_NOTE_KIND_SUPPORTING_NOTE:
      return [
        {
          title: "概要",
          lines: summary ? [`- ${summary}`] : ["- 待补一句概要。"]
        },
        {
          title: "正文",
          lines: fallbackBody ? [fallbackBody] : ["- 待补正文。"]
        },
        {
          title: "来源",
          lines: sourceLines
        },
        {
          title: "相关",
          lines: relatedLines
        }
      ];
    case WIKI_NOTE_KIND_KNOWLEDGE_CARD:
    default:
      return [
        {
          title: "判断",
          lines: fallbackBody ? [fallbackBody] : ["- 待补充。"]
        },
        {
          title: "相关",
          lines: relatedLines
        },
        {
          title: "来源",
          lines: sourceLines
        }
      ];
  }
}

function buildStructuredWikiScaffoldBody(
  kind: WikiNoteKind,
  body: string,
  summary: string,
  related: string[],
  sources: string[]
): string {
  const trimmed = normalizeText(body);
  const requiredSections = buildRequiredWikiSections(kind, summary, "", related, sources);
  if (!hasSecondLevelHeading(trimmed)) {
    return requiredSections
      .map((section) => normalizeScaffoldSection(section.title, section.lines))
      .join("\n\n")
      .trim();
  }

  const parsed = parseSecondLevelSections(trimmed);
  const requiredTitles = new Set(requiredSections.map((section) => section.title));
  const sectionMap = new Map<string, string[]>();
  const extraSectionOrder: string[] = [];

  for (const section of parsed.sections) {
    const existing = sectionMap.get(section.title);
    sectionMap.set(section.title, mergeSectionLines(existing, section.lines));
    if (!requiredTitles.has(section.title) && !extraSectionOrder.includes(section.title)) {
      extraSectionOrder.push(section.title);
    }
  }

  const normalizedPreface = normalizeText(parsed.preface.join("\n"));
  if (normalizedPreface) {
    const targetTitle = kind === WIKI_NOTE_KIND_KNOWLEDGE_CARD ? "判断" : "概要";
    const existing = sectionMap.get(targetTitle);
    sectionMap.set(targetTitle, mergeSectionLines(existing, [normalizedPreface], true));
  }

  const normalizedSections = requiredSections.map((section) => {
    const existingLines = sectionMap.get(section.title);
    return normalizeScaffoldSection(
      section.title,
      hasMeaningfulSectionContent(existingLines) ? existingLines ?? [] : section.lines
    );
  });

  for (const title of extraSectionOrder) {
    normalizedSections.push(normalizeScaffoldSection(title, sectionMap.get(title) ?? []));
  }

  return normalizedSections.join("\n\n").trim();
}

function normalizeWikiBodyForKind(
  kind: WikiNoteKind,
  body: string,
  summary: string,
  related: string[],
  sources: string[]
): string {
  switch (kind) {
    case WIKI_NOTE_KIND_KNOWLEDGE_BASE:
    case WIKI_NOTE_KIND_CONCEPT_PAGE:
    case WIKI_NOTE_KIND_SUPPORTING_NOTE:
    case WIKI_NOTE_KIND_KNOWLEDGE_CARD:
    default:
      return buildStructuredWikiScaffoldBody(kind, body, summary, related, sources);
  }
}

function resolveWikiSummary(summary: string | undefined, body: string): string {
  return summary?.trim() || inferWikiSummary(body) || "待补充摘要。";
}

function normalizeWikiKind(value: string): WikiNoteKind | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === WIKI_NOTE_KIND_KNOWLEDGE_CARD || normalized === "knowledge") {
    return WIKI_NOTE_KIND_KNOWLEDGE_CARD;
  }
  if (normalized === WIKI_NOTE_KIND_KNOWLEDGE_BASE || normalized === "knowledge-base-root" || normalized === "index") {
    return WIKI_NOTE_KIND_KNOWLEDGE_BASE;
  }
  if (normalized === WIKI_NOTE_KIND_CONCEPT_PAGE || normalized === "concept") {
    return WIKI_NOTE_KIND_CONCEPT_PAGE;
  }
  if (normalized === WIKI_NOTE_KIND_SUPPORTING_NOTE || normalized === "supporting") {
    return WIKI_NOTE_KIND_SUPPORTING_NOTE;
  }
  return undefined;
}

function parseInlineStringList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") {
    return [];
  }

  const content = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;

  return unique(
    content
      .split(/[，,、;；\n]/g)
      .map((item) => unquoteScalar(item))
      .filter(Boolean)
  );
}

function mergeWikiFieldPatch(
  base: Partial<WikiNoteSchemaFields>,
  patch: Partial<WikiNoteSchemaFields>
): Partial<WikiNoteSchemaFields> {
  return {
    kind: patch.kind ?? base.kind,
    summary: patch.summary?.trim() || base.summary,
    status: patch.status?.trim() || base.status,
    updatedAt: patch.updatedAt?.trim() || base.updatedAt,
    aliases: unique([...(base.aliases ?? []), ...(patch.aliases ?? [])]),
    keywords: unique([...(base.keywords ?? []), ...(patch.keywords ?? [])]),
    parents: unique([...(base.parents ?? []), ...(patch.parents ?? [])]),
    children: unique([...(base.children ?? []), ...(patch.children ?? [])]),
    related: unique([...(base.related ?? []), ...(patch.related ?? [])]),
    sources: unique([...(base.sources ?? []), ...(patch.sources ?? [])])
  };
}

function applyFieldValue(
  fields: Partial<WikiNoteSchemaFields>,
  key: string,
  value: string | string[]
): Partial<WikiNoteSchemaFields> {
  const normalizedKey = key.trim().toLowerCase();
  switch (normalizedKey) {
    case "sidet_type":
    case "type": {
      const kind = normalizeWikiKind(Array.isArray(value) ? value.join(", ") : value);
      return kind ? mergeWikiFieldPatch(fields, { kind }) : fields;
    }
    case "summary":
      return mergeWikiFieldPatch(fields, { summary: Array.isArray(value) ? value.join(", ") : unquoteScalar(value) });
    case "status":
      return mergeWikiFieldPatch(fields, { status: Array.isArray(value) ? value.join(", ") : unquoteScalar(value) });
    case "updatedat":
      return mergeWikiFieldPatch(fields, { updatedAt: Array.isArray(value) ? value.join(", ") : unquoteScalar(value) });
    case "aliases":
      return mergeWikiFieldPatch(fields, {
        aliases: Array.isArray(value) ? unique(value.map((item) => unquoteScalar(item)).filter(Boolean)) : parseInlineStringList(value)
      });
    case "keywords":
      return mergeWikiFieldPatch(fields, {
        keywords: Array.isArray(value) ? unique(value.map((item) => unquoteScalar(item)).filter(Boolean)) : parseInlineStringList(value)
      });
    case "parents":
      return mergeWikiFieldPatch(fields, {
        parents: Array.isArray(value) ? unique(value.map((item) => unquoteScalar(item)).filter(Boolean)) : parseInlineStringList(value)
      });
    case "children":
      return mergeWikiFieldPatch(fields, {
        children: Array.isArray(value) ? unique(value.map((item) => unquoteScalar(item)).filter(Boolean)) : parseInlineStringList(value)
      });
    case "related":
      return mergeWikiFieldPatch(fields, {
        related: Array.isArray(value) ? unique(value.map((item) => unquoteScalar(item)).filter(Boolean)) : parseInlineStringList(value)
      });
    case "sources":
      return mergeWikiFieldPatch(fields, {
        sources: Array.isArray(value) ? unique(value.map((item) => unquoteScalar(item)).filter(Boolean)) : parseInlineStringList(value)
      });
    default:
      return fields;
  }
}

export function parseSimpleFrontmatterFields(markdown: string): { body: string; fields: Partial<WikiNoteSchemaFields> } {
  const normalized = normalizeText(markdown);
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) {
    return { body: normalized, fields: {} };
  }

  const lines = (match[1] ?? "").split("\n");
  let fields: Partial<WikiNoteSchemaFields> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const keyMatch = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!keyMatch) {
      continue;
    }

    const key = keyMatch[1] ?? "";
    const rawValue = keyMatch[2] ?? "";
    if (!rawValue.trim()) {
      const listValues: string[] = [];
      let nextIndex = index + 1;
      while (nextIndex < lines.length) {
        const listMatch = (lines[nextIndex] ?? "").match(/^\s*-\s+(.+)$/);
        if (!listMatch) {
          break;
        }
        listValues.push(unquoteScalar(listMatch[1] ?? ""));
        nextIndex += 1;
      }
      fields = applyFieldValue(fields, key, listValues);
      index = nextIndex - 1;
      continue;
    }

    fields = applyFieldValue(fields, key, rawValue);
  }

  return {
    body: normalized.slice(match[0].length).trim(),
    fields
  };
}

function stripLeadingBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && !lines[start]?.trim()) {
    start += 1;
  }
  return lines.slice(start);
}

function consumePseudoFieldBlock(lines: string[]): { lines: string[]; fields: Partial<WikiNoteSchemaFields> } | null {
  const working = stripLeadingBlankLines(lines);
  let index = 0;
  let consumed = false;
  let fields: Partial<WikiNoteSchemaFields> = {};

  while (index < working.length) {
    const line = working[index]?.trim() ?? "";
    if (!line) {
      const nextNonEmptyIndex = working.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.trim().length > 0);
      if (nextNonEmptyIndex < 0) {
        index = working.length;
        break;
      }

      const nextLine = working[nextNonEmptyIndex]?.trim() ?? "";
      if (!/^#?\s*[A-Za-z_][\w-]*\s*:/.test(nextLine)) {
        break;
      }

      index = nextNonEmptyIndex;
      continue;
    }

    const match = line.match(/^#?\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) {
      break;
    }

    fields = applyFieldValue(fields, match[1] ?? "", match[2] ?? "");
    consumed = true;
    index += 1;
  }

  if (!consumed) {
    return null;
  }

  return {
    lines: working.slice(index),
    fields
  };
}

export function normalizeWikiDraftMarkdown(markdown: string, fallbackTitle = "Sidet Wiki 记忆"): NormalizedWikiDraft {
  const normalized = normalizeText(markdown);
  const frontmatter = parseSimpleFrontmatterFields(normalized);
  let fields = frontmatter.fields;
  let lines = frontmatter.body.split("\n");
  const title = fallbackTitle.trim() || "Sidet Wiki 记忆";

  while (true) {
    const trimmedLines = stripLeadingBlankLines(lines);
    const pseudoFields = consumePseudoFieldBlock(trimmedLines);
    if (pseudoFields) {
      fields = mergeWikiFieldPatch(fields, pseudoFields.fields);
      lines = pseudoFields.lines;
      continue;
    }

    const firstContentIndex = trimmedLines.findIndex((line) => line.trim().length > 0);
    if (firstContentIndex < 0) {
      lines = [];
      break;
    }

    const headingMatch = trimmedLines[firstContentIndex]?.trim().match(/^#{1,2}\s+(.+)$/);
    if (!headingMatch || !titlesEquivalent(headingMatch[1] ?? "", title)) {
      lines = trimmedLines;
      break;
    }

    trimmedLines.splice(firstContentIndex, 1);
    lines = trimmedLines;
  }

  return {
    title,
    body: lines.join("\n").trim(),
    fields
  };
}

export function deriveWikiTitleFromPath(path: string, fallbackTitle = "Sidet Wiki 记忆"): string {
  return fileStem(path) || fallbackTitle.trim() || "Sidet Wiki 记忆";
}

export function isWikiNotePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  return normalized === "Sidet/Wiki"
    || normalized.startsWith("Sidet/Wiki/");
}

export function isWikiIndexPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim().toLowerCase();
  return normalized === WIKI_INDEX_FILE_NAME.toLowerCase()
    || normalized.endsWith(`/${WIKI_INDEX_FILE_NAME}`.toLowerCase());
}

export function isWikiKnowledgeBaseRootPath(path: string): boolean {
  return isWikiIndexPath(path);
}

function inferWikiDefaultKindFromPath(path: string): WikiNoteKind {
  return isWikiIndexPath(path)
    ? WIKI_NOTE_KIND_KNOWLEDGE_BASE
    : WIKI_NOTE_KIND_KNOWLEDGE_CARD;
}

export function inferWikiSummary(markdown: string, maxChars = 140): string {
  const body = stripFirstHeading(markdown);
  const paragraph = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^[-*#>`]/.test(line) && !line.startsWith("![["))
    ?? body.split("\n").map((line) => line.trim()).find(Boolean)
    ?? "";

  return clipText(paragraph.replace(/\s+/g, " "), maxChars);
}

export function buildWikiFrontmatter(fields: WikiNoteSchemaFields): string {
  const lines = [
    "---",
    `sidet_type: ${quoteYaml(fields.kind)}`,
    `summary: ${quoteYaml(fields.summary.trim())}`,
    `status: ${quoteYaml(fields.status?.trim() || "active")}`,
    `updatedAt: ${quoteYaml(fields.updatedAt?.trim() || formatFileDatePrefix(Date.now()))}`
  ];

  pushOptionalYamlStringArray(lines, "related", unique(fields.related ?? []));
  pushOptionalYamlStringArray(lines, "sources", unique(fields.sources ?? []));
  pushOptionalYamlStringArray(lines, "aliases", unique(fields.aliases ?? []));
  pushOptionalYamlStringArray(lines, "keywords", unique(fields.keywords ?? []));
  pushOptionalYamlStringArray(lines, "parents", unique(fields.parents ?? []));
  pushOptionalYamlStringArray(lines, "children", unique(fields.children ?? []));
  lines.push("---");
  return lines.join("\n");
}

export function buildWikiNoteMarkdown(options: WikiNoteBuildOptions): string {
  const title = normalizeText(options.title);
  const body = stripLeadingTitleHeading(options.body, title);
  return [
    buildWikiFrontmatter(options.fields),
    "",
    `# ${title}`,
    "",
    body
  ].join("\n").trim() + "\n";
}

export function buildNormalizedWikiMarkdown(
  markdown: string,
  fallbackTitle: string,
  fieldOverrides: Partial<WikiNoteSchemaFields> = {},
  options: BuildNormalizedWikiOptions = {}
): string {
  const title = extractLeadingWikiTitle(markdown) || fallbackTitle.trim() || "Sidet Wiki 记忆";
  const normalizedDraft = normalizeWikiDraftMarkdown(markdown, title);
  const mergedFields = mergeWikiFieldPatch(normalizedDraft.fields, fieldOverrides);
  const kind = mergedFields.kind ?? options.defaultKind ?? WIKI_NOTE_KIND_KNOWLEDGE_CARD;
  const summary = resolveWikiSummary(mergedFields.summary, normalizedDraft.body);
  const updatedAt = options.updatedAt?.trim()
    || (options.preserveUpdatedAt ? mergedFields.updatedAt?.trim() : "")
    || formatFileDatePrefix(Date.now());
  const related = unique(mergedFields.related ?? []);
  const sources = unique(mergedFields.sources ?? []);
  const normalizedBody = normalizeWikiBodyForKind(kind, normalizedDraft.body, summary, related, sources);

  return buildWikiNoteMarkdown({
    title: normalizedDraft.title,
    body: normalizedBody,
    fields: {
      kind,
      summary,
      aliases: unique(mergedFields.aliases ?? []),
      keywords: unique(mergedFields.keywords ?? []),
      parents: unique(mergedFields.parents ?? []),
      children: unique(mergedFields.children ?? []),
      related,
      sources,
      status: mergedFields.status?.trim(),
      updatedAt
    }
  });
}

export function buildNormalizedWikiMarkdownFromPath(
  targetPath: string,
  markdown: string,
  fieldOverrides: Partial<WikiNoteSchemaFields> = {},
  options: BuildNormalizedWikiOptions = {}
): string {
  return buildNormalizedWikiMarkdown(
    markdown,
    deriveWikiTitleFromPath(targetPath),
    fieldOverrides,
    {
      ...options,
      defaultKind: options.defaultKind ?? inferWikiDefaultKindFromPath(targetPath)
    }
  );
}

export function buildWikiKnowledgeCardMarkdown(
  title: string,
  body: string,
  fieldOverrides: Partial<WikiNoteSchemaFields> = {}
): string {
  const cleanBody = stripLeadingTitleHeading(body, title);
  const summary = resolveWikiSummary(fieldOverrides.summary, cleanBody);
  const related = unique(fieldOverrides.related ?? []);
  const sources = unique(fieldOverrides.sources ?? []);
  return buildWikiNoteMarkdown({
    title,
    body: normalizeWikiBodyForKind(
      fieldOverrides.kind ?? WIKI_NOTE_KIND_KNOWLEDGE_CARD,
      cleanBody,
      summary,
      related,
      sources
    ),
    fields: {
      kind: fieldOverrides.kind ?? WIKI_NOTE_KIND_KNOWLEDGE_CARD,
      summary,
      aliases: unique(fieldOverrides.aliases ?? []),
      keywords: unique(fieldOverrides.keywords ?? []),
      parents: unique(fieldOverrides.parents ?? []),
      children: unique(fieldOverrides.children ?? []),
      related,
      sources,
      status: fieldOverrides.status?.trim(),
      updatedAt: fieldOverrides.updatedAt?.trim()
    }
  });
}

export function buildWikiConceptPageTemplate(title = "概念页标题"): string {
  return buildWikiConceptPageTemplateWith(buildWikiNoteMarkdown, WIKI_NOTE_KIND_CONCEPT_PAGE, title);
}

export function buildWikiIndexTemplate(title = "Index"): string {
  return buildWikiIndexTemplateWith(buildWikiNoteMarkdown, WIKI_NOTE_KIND_KNOWLEDGE_BASE, title);
}

export function buildWikiSchemaGuidance(): string[] {
  return buildWikiSchemaGuidanceLines();
}

export function isWikiKnowledgeBaseFrontmatter(frontmatter: Record<string, unknown> | null): boolean {
  const kind = typeof frontmatter?.sidet_type === "string"
    ? frontmatter.sidet_type
    : typeof frontmatter?.type === "string"
      ? frontmatter.type
      : "";
  const aliases = normalizeFrontmatterStringList(frontmatter?.aliases);
  const summary = typeof frontmatter?.summary === "string" ? frontmatter.summary.trim() : "";

  return normalizeWikiKind(kind) === WIKI_NOTE_KIND_KNOWLEDGE_BASE
    && aliases.length > 0
    && summary.length > 0;
}
