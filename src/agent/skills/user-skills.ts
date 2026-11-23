import { App, TFile } from "obsidian";
import { DEFAULT_AGENT_SKILL_FOLDER } from "../../constants";
import type { MessageAttachment } from "../../types";
import type { BuiltInSkill } from "./builtin-skills";
import {
  extractSkillFirstParagraph,
  extractSkillHeading,
  extractSkillInlineValue,
  extractSkillListUnderHeading,
  parseSkillFrontmatter,
  resolveSkillDisplayName,
  stripSkillFrontmatter
} from "./skill-markdown";

interface ScoredUserSkill {
  card: BuiltInSkill;
  score: number;
}

interface ParsedUserSkillCacheEntry {
  mtime: number;
  card: BuiltInSkill | null;
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
  "sidet",
  "skill",
  "wiki",
  "obsidian",
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
  "技能",
  "卡片"
]);

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd();
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function extractTerms(text: string, limit = 32): string[] {
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

function buildQuery(text: string, attachments: MessageAttachment[]): string {
  const attachmentText = attachments.map((attachment) => {
    if (attachment.type === "markdown") {
      return `${attachment.name}\n${attachment.path}\n${attachment.content.slice(0, 1000)}`;
    }
    if (attachment.type === "webpage") {
      return `${attachment.name}\n${attachment.url}\n${attachment.content.slice(0, 1000)}`;
    }
    return `${attachment.name}\n${attachment.mimeType}`;
  }).join("\n");
  return `${text}\n${attachmentText}`;
}

function stripFrontmatter(markdown: string): string {
  return stripSkillFrontmatter(markdown);
}

function isSkillEntryFile(file: TFile, prefix: string): boolean {
  if (!file.path.startsWith(prefix)) {
    return false;
  }

  const relativePath = file.path.slice(prefix.length);
  return /^([^/]+)\/SKILL\.md$/i.test(relativePath);
}

function splitTerms(value: string): string[] {
  return unique(value.split(/[，,、/;；\s]+/g).map((item) => item.trim()).filter(Boolean));
}

function scoreSkill(card: BuiltInSkill, queryTerms: string[], queryText: string): number {
  const target = [
    card.name,
    card.useWhen,
    card.triggerTerms.join("\n"),
    card.constraints.join("\n"),
    card.protocol?.join("\n") ?? ""
  ].join("\n").toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    if (target.includes(term.toLowerCase())) {
      score += 1;
    }
  }

  for (const term of card.triggerTerms) {
    if (queryText.includes(term.toLowerCase())) {
      score += 4;
    }
  }

  return score;
}

function parseSkillEntry(file: TFile, markdown: string): BuiltInSkill | null {
  const body = stripFrontmatter(markdown);
  const frontmatter = parseSkillFrontmatter(markdown);
  const displayName = resolveSkillDisplayName(file);
  const name = frontmatter.get("name")?.trim()
    || extractSkillHeading(body)
    || displayName;
  const triggerTerms = splitTerms(
    extractSkillInlineValue(body, ["触发词", "触发", "trigger", "triggers"])
      || frontmatter.get("triggers")?.trim()
      || frontmatter.get("trigger")?.trim()
      || ""
  );
  const useWhen = extractSkillInlineValue(body, ["适用", "使用场景", "when to use", "use when"])
    || frontmatter.get("description")?.trim()
    || extractSkillFirstParagraph(body)
    || clipText(body.split("\n").find((line) => line.trim() && !line.startsWith("#")) ?? "", 180);
  const constraints = extractSkillListUnderHeading(body, ["边界", "约束", "限制", "不做", "constraints", "boundaries"]);
  const protocol = extractSkillListUnderHeading(body, ["操作协议", "协议", "protocol", "steps"]);

  if (!name.trim() || !useWhen.trim()) {
    return null;
  }

  return {
    id: `user:${file.path}`,
    name,
    triggerTerms: triggerTerms.length > 0 ? triggerTerms : extractTerms(`${name}\n${useWhen}`, 12),
    useWhen,
    constraints: constraints.length > 0
      ? constraints.slice(0, 5)
      : ["只作为本次回答的路由提示，不自动修改 vault。"],
    protocol: protocol.length > 0 ? protocol.slice(0, 5) : undefined,
    source: "用户 Skill",
    sourcePath: file.path
  };
}

export class UserSkillIndex {
  private readonly parsedSkillCache = new Map<string, ParsedUserSkillCacheEntry>();

  constructor(private readonly app: App) {}

  async findRelevantSkills(
    text: string,
    attachments: MessageAttachment[],
    maxCards: number
  ): Promise<BuiltInSkill[]> {
    const query = buildQuery(text, attachments);
    const queryText = query.toLowerCase();
    const queryTerms = extractTerms(query);
    if (queryTerms.length === 0) {
      return [];
    }

    const prefix = DEFAULT_AGENT_SKILL_FOLDER.endsWith("/")
      ? DEFAULT_AGENT_SKILL_FOLDER
      : `${DEFAULT_AGENT_SKILL_FOLDER}/`;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => isSkillEntryFile(file, prefix))
      .sort((left, right) => right.stat.mtime - left.stat.mtime);
    this.pruneParsedSkillCache(files);

    const cards = await Promise.all(files.map(async (file) => ({
      file,
      card: await this.readSkillCard(file)
    })));

    const scored: ScoredUserSkill[] = [];
    for (const { card } of cards) {
      if (!card) {
        continue;
      }

      const score = scoreSkill(card, queryTerms, queryText);
      if (score > 0) {
        scored.push({ card, score });
      }
    }

    return scored
      .sort((left, right) => right.score - left.score)
      .slice(0, maxCards)
      .map((item) => item.card);
  }

  private pruneParsedSkillCache(files: TFile[]): void {
    const activePaths = new Set(files.map((file) => file.path));
    for (const path of Array.from(this.parsedSkillCache.keys())) {
      if (!activePaths.has(path)) {
        this.parsedSkillCache.delete(path);
      }
    }
  }

  private async readSkillCard(file: TFile): Promise<BuiltInSkill | null> {
    const cachedEntry = this.parsedSkillCache.get(file.path);
    if (cachedEntry && cachedEntry.mtime === file.stat.mtime) {
      return cachedEntry.card;
    }

    const raw = await this.app.vault.cachedRead(file);
    const card = parseSkillEntry(file, raw);
    this.parsedSkillCache.set(file.path, {
      mtime: file.stat.mtime,
      card
    });
    return card;
  }
}
