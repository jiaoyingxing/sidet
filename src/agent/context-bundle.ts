export type ContextBundleKind =
  | "current-note"
  | "current-selection"
  | "markdown-file"
  | "webpage"
  | "memory-candidate"
  | "draft-note-preview"
  | "agent-router-context";

export interface ContextBundleMetadata {
  label: string;
  value: string;
}

export interface ContextBundleSection {
  heading?: string;
  metadata?: ContextBundleMetadata[];
  notes?: string[];
  content?: string;
  codeFenceLanguage?: string;
}

export interface ContextBundle {
  kind: ContextBundleKind;
  title: string;
  description?: string[];
  metadata?: ContextBundleMetadata[];
  sections?: ContextBundleSection[];
  footer?: string[];
  truncated: boolean;
  noteCount?: number;
}

export interface ContextDraftResult {
  block: string;
  draft: string;
  truncated: boolean;
  noteCount?: number;
}

function pushMetadata(lines: string[], metadata: ContextBundleMetadata[] | undefined): void {
  for (const item of metadata ?? []) {
    const value = item.value.trim();
    if (!value) {
      continue;
    }
    lines.push(`${item.label}：${value}`);
  }
}

function pushLooseLines(lines: string[], looseLines: string[] | undefined): void {
  for (const line of looseLines ?? []) {
    if (!line.trim()) {
      continue;
    }
    lines.push(line);
  }
}

export function formatContextBundleBlock(bundle: ContextBundle): string {
  const lines = [bundle.title];

  pushLooseLines(lines, bundle.description);
  pushMetadata(lines, bundle.metadata);

  for (const section of bundle.sections ?? []) {
    lines.push("");
    if (section.heading) {
      lines.push(section.heading);
    }
    pushMetadata(lines, section.metadata);
    pushLooseLines(lines, section.notes);
    if (section.content !== undefined) {
      lines.push(
        `\`\`\`${section.codeFenceLanguage ?? "markdown"}`,
        section.content,
        "```"
      );
    }
  }

  if (bundle.footer?.some((line) => line.trim().length > 0)) {
    lines.push("");
    pushLooseLines(lines, bundle.footer);
  }

  return lines.join("\n").trim();
}

export function buildContextDraftResult(
  bundle: ContextBundle,
  questionPrompt: string | null = "问题："
): ContextDraftResult {
  const block = formatContextBundleBlock(bundle);
  return {
    block,
    draft: questionPrompt === null ? block : `${block}\n\n${questionPrompt}`,
    truncated: bundle.truncated,
    noteCount: bundle.noteCount
  };
}

export function trimContextTextToBudget(
  text: string,
  maxChars: number,
  truncatedNote = "[已截断，库内候选上下文过长]"
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false
    };
  }

  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n${truncatedNote}`,
    truncated: true
  };
}
