const CONVERSATION_KNOWLEDGE_COMMAND_ALIASES = [
  "整理到知识库",
  "整理当前对话到知识库",
  "整理这段对话到知识库",
  "把当前对话整理到知识库",
  "把这段对话整理到知识库",
  "保存当前对话到wiki",
  "保存这段对话到wiki"
];

const WIKI_PLAN_CONTINUATION_COMMAND_ALIASES = [
  "按计划推进",
  "按计划执行",
  "继续执行",
  "继续推进",
  "生成写入草稿",
  "按计划落盘",
  "继续落盘",
  "按计划生成写入草稿"
];

function normalizeCommandText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function startsWithAlias(text: string, alias: string): boolean {
  return text.slice(0, alias.length).toLocaleLowerCase() === alias.toLocaleLowerCase();
}

function normalizeDirectKnowledgeBoundary(raw: string): string | undefined {
  const cleaned = raw
    .replace(/^[\s，,。；;:：、—-]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }

  return cleaned.replace(/(?:吧|呀|啊|即可|就行|就好)\s*$/u, "").trim() || undefined;
}

export function parseDirectConversationKnowledgeCommand(text: string): { boundary?: string } | null {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return null;
  }

  for (const alias of CONVERSATION_KNOWLEDGE_COMMAND_ALIASES) {
    if (!startsWithAlias(normalized, alias)) {
      continue;
    }

    const suffix = normalized.slice(alias.length);
    if (!suffix.trim()) {
      return {};
    }

    const boundaryMatch = suffix.match(/^\s*[:：]\s*([\s\S]+)$/u);
    if (!boundaryMatch) {
      return null;
    }

    return {
      boundary: normalizeDirectKnowledgeBoundary(boundaryMatch[1] ?? "")
    };
  }

  return null;
}

export function parseDirectWikiPlanContinuationCommand(text: string): { matched: true } | null {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return null;
  }

  return WIKI_PLAN_CONTINUATION_COMMAND_ALIASES.some((alias) => normalized.toLocaleLowerCase() === alias.toLocaleLowerCase())
    ? { matched: true }
    : null;
}
