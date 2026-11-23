import type { TFile } from "obsidian";

interface SplitFrontmatterResult {
  body: string;
  frontmatterLines: string[];
  hasFrontmatter: boolean;
}

function splitFrontmatter(markdown: string): SplitFrontmatterResult {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized.startsWith("---\n")) {
    return {
      body: normalized,
      frontmatterLines: [],
      hasFrontmatter: false
    };
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex < 0) {
    return {
      body: normalized,
      frontmatterLines: [],
      hasFrontmatter: false
    };
  }

  return {
    frontmatterLines: normalized.slice(4, endIndex).split("\n"),
    body: normalized.slice(endIndex + "\n---\n".length).trim(),
    hasFrontmatter: true
  };
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value.trim());
}

function stringifyMarkdownList(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

export function normalizeSkillMarkdownText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function parseSkillFrontmatter(markdown: string): Map<string, string> {
  const { frontmatterLines, hasFrontmatter } = splitFrontmatter(markdown);
  const fields = new Map<string, string>();
  if (!hasFrontmatter) {
    return fields;
  }

  for (const line of frontmatterLines) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    fields.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return fields;
}

export function stripSkillFrontmatter(markdown: string): string {
  return splitFrontmatter(markdown).body;
}

export function extractSkillHeading(markdown: string): string | null {
  return stripSkillFrontmatter(markdown).match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim() ?? null;
}

export function extractSkillInlineValue(markdown: string, labels: string[]): string {
  const body = stripSkillFrontmatter(markdown);
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = body.match(new RegExp(`^\\s*(?:[-*]\\s*)?${escaped}\\s*[:：]\\s*(.+)$`, "im"));
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return "";
}

export function extractSkillListUnderHeading(markdown: string, headings: string[]): string[] {
  const lines = stripSkillFrontmatter(markdown).split("\n");
  const headingPattern = new RegExp(
    `^#{2,6}\\s+(${headings.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*$`,
    "i"
  );
  const startIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (startIndex < 0) {
    return [];
  }

  const result: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (/^#{2,6}\s+/.test(line)) {
      break;
    }

    const listItem = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/)?.[1]?.trim();
    if (listItem) {
      result.push(listItem);
    }
  }
  return result;
}

export function extractSkillFirstParagraph(markdown: string): string {
  const lines = stripSkillFrontmatter(markdown).split("\n");
  const buffer: string[] = [];
  let inFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (!line) {
      if (buffer.length > 0) {
        break;
      }
      continue;
    }
    if (
      /^#{1,6}\s+/.test(line)
      || /^>/.test(line)
      || /^(?:[-*]|\d+[.)])\s+/.test(line)
    ) {
      if (buffer.length > 0) {
        break;
      }
      continue;
    }
    buffer.push(line);
  }

  return buffer.join(" ").trim();
}

export function resolveSkillDisplayName(file: TFile): string {
  if (file.basename !== "SKILL") {
    return file.basename;
  }

  const parts = file.path.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return parts[parts.length - 2] ?? file.basename;
  }
  return file.basename;
}

export function ensureSkillMarkdownShape(markdown: string, fallbackName: string): {
  content: string;
  description: string;
  name: string;
} {
  const normalized = normalizeSkillMarkdownText(markdown);
  const frontmatter = parseSkillFrontmatter(normalized);
  const { body, frontmatterLines, hasFrontmatter } = splitFrontmatter(normalized);
  const name = frontmatter.get("name") || extractSkillHeading(body) || fallbackName;
  const description = frontmatter.get("description")
    || extractSkillInlineValue(body, ["适用", "使用场景", "when to use", "use when"])
    || extractSkillFirstParagraph(body)
    || "待补充说明。";
  const hasHeading = Boolean(extractSkillHeading(body));
  const normalizedBody = hasHeading ? body : [`# ${name}`, body].filter(Boolean).join("\n\n").trim();

  if (!hasFrontmatter) {
    return {
      name,
      description,
      content: [
        "---",
        `name: ${quoteYamlString(name)}`,
        `description: ${quoteYamlString(description)}`,
        "---",
        "",
        normalizedBody
      ].join("\n").trim() + "\n"
    };
  }

  const mergedFrontmatterLines = [...frontmatterLines];
  if (!frontmatter.get("name")) {
    mergedFrontmatterLines.push(`name: ${quoteYamlString(name)}`);
  }
  if (!frontmatter.get("description")) {
    mergedFrontmatterLines.push(`description: ${quoteYamlString(description)}`);
  }

  return {
    name,
    description,
    content: [
      "---",
      ...mergedFrontmatterLines,
      "---",
      "",
      normalizedBody
    ].join("\n").trim() + "\n"
  };
}

export function splitSkillTerms(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[，,、/;；\s]+/g)
      .map((item) => item.trim())
      .filter(Boolean)
  ));
}

export interface ParsedSkillDraft {
  name: string;
  description: string;
  useWhen: string;
  triggerTerms: string[];
  constraints: string[];
  protocol: string[];
  notWrite: string[];
}

export function parseSkillDraft(markdown: string, fallbackName: string): ParsedSkillDraft {
  const shaped = ensureSkillMarkdownShape(markdown, fallbackName);
  const frontmatter = parseSkillFrontmatter(shaped.content);
  const body = stripSkillFrontmatter(shaped.content);
  const useWhenItems = extractSkillListUnderHeading(body, ["什么时候用", "适用", "使用场景", "when to use", "use when"]);
  const triggerItems = extractSkillListUnderHeading(body, ["触发词", "trigger terms", "triggers"]);

  return {
    name: shaped.name,
    description: shaped.description,
    useWhen: useWhenItems[0]
      || extractSkillInlineValue(body, ["适用", "使用场景", "when to use", "use when"])
      || frontmatter.get("description")
      || shaped.description,
    triggerTerms: triggerItems.length > 0
      ? triggerItems
      : splitSkillTerms(
        extractSkillInlineValue(body, ["触发词", "触发", "trigger", "triggers"])
          || frontmatter.get("triggers")
          || frontmatter.get("trigger")
          || ""
      ),
    constraints: extractSkillListUnderHeading(body, ["边界", "约束", "限制", "不做", "constraints", "boundaries"]),
    protocol: extractSkillListUnderHeading(body, ["操作协议", "协议", "protocol", "steps"]),
    notWrite: extractSkillListUnderHeading(body, ["不写入", "不落盘", "do not write", "not write"])
  };
}

export function buildFullSkillMarkdown(options: {
  name: string;
  description: string;
  triggerTerms?: string[];
  useWhen?: string;
  constraints?: string[];
  protocol?: string[];
  notWrite?: string[];
}): string {
  const name = options.name.trim();
  const description = options.description.trim();
  const triggerTerms = options.triggerTerms?.filter(Boolean) ?? [];
  const useWhen = options.useWhen?.trim() || description;
  const constraints = options.constraints?.filter(Boolean) ?? [];
  const protocol = options.protocol?.filter(Boolean) ?? [];
  const notWrite = options.notWrite?.filter(Boolean) ?? [];

  return [
    "---",
    `name: ${quoteYamlString(name)}`,
    `description: ${quoteYamlString(description)}`,
    "---",
    "",
    `# ${name}`,
    "",
    "## 什么时候用",
    useWhen ? `- ${useWhen}` : "- 待补充。",
    "",
    "## 触发词",
    triggerTerms.length > 0 ? stringifyMarkdownList(triggerTerms) : "- 待补充。",
    "",
    "## 边界",
    constraints.length > 0 ? stringifyMarkdownList(constraints) : "- 待补充。",
    "",
    "## 操作协议",
    protocol.length > 0 ? stringifyMarkdownList(protocol) : "- 待补充。",
    "",
    "## 不写入",
    notWrite.length > 0 ? stringifyMarkdownList(notWrite) : "- 待补充。"
  ].join("\n").trim() + "\n";
}
