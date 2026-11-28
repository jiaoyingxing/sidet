import { normalizeAgentActionTargetPath, type AgentActionPreview } from "./agent-action";
import { buildNormalizedWikiMarkdownFromPath, isWikiNotePath } from "../wiki/wiki-note-schema";
import {
  buildSidetFileToolContext as buildSidetFileToolPrompt,
  buildSidetFileToolSummaryContext as buildSidetFileToolSummaryPrompt
} from "../prompts/tool-action-prompt";

type SidetToolKind = "create_note" | "append_note" | "replace_note";

interface SidetToolAction {
  tool: SidetToolKind;
  targetPath: string;
  title?: string;
  reason?: string;
  content: string;
}

interface ActionBlockMatch {
  content: string;
  index: number;
  end: number;
}

/**
 * 新协议用四个反引号包住 sidet-action，正文里的三反引号代码块因此不会提前
 * 结束动作块；旧消息仍用三反引号，解析时优先新协议、再回退旧协议。
 */
const ACTION_BLOCK_PATTERN = /(?<!`)````sidet-action[ \t]*\r?\n([\s\S]*?)````(?!`)/i;

function extractActionBlock(markdown: string): ActionBlockMatch | null {
  const fourFenceMatch = markdown.match(ACTION_BLOCK_PATTERN);
  if (fourFenceMatch?.index !== undefined && fourFenceMatch[1] !== undefined) {
    return {
      content: fourFenceMatch[1],
      index: fourFenceMatch.index,
      end: fourFenceMatch.index + fourFenceMatch[0].length
    };
  }
  return extractLegacyActionBlock(markdown);
}

/**
 * 旧三反引号外层不能只用正则收尾：正文里的代码块也可能用三反引号，甚至模型
 * 会漏写外层闭合围栏。按行扫描围栏层级：外层三反引号在没有内层代码块时结束；
 * 找不到外层闭合时按“动作块在回复最后”取到消息末尾。
 */
function extractLegacyActionBlock(markdown: string): ActionBlockMatch | null {
  const opener = markdown.match(/(?<!`)```sidet-action[ \t]*\r?\n/i);
  if (!opener || opener.index === undefined) {
    return null;
  }
  const contentStart = opener.index + opener[0].length;
  const body = markdown.slice(contentStart);
  const fenceLinePattern = /^[ \t]{0,3}(`{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  let inFence: string | null = null;
  let match: RegExpExecArray | null;
  const bareThreeFences: Array<{ index: number; end: number }> = [];

  while ((match = fenceLinePattern.exec(body))) {
    const fence = match[1] ?? "";
    const info = (match[2] ?? "").trim();
    if (inFence) {
      if (fence === inFence && info === "") {
        inFence = null;
      }
      continue;
    }
    if (fence.length >= 4) {
      inFence = fence;
      continue;
    }
    if (fence.length === 3) {
      if (info === "") {
        bareThreeFences.push({
          index: match.index,
          end: match.index + match[0].length
        });
      } else {
        inFence = fence;
      }
    }
  }

  // 外层三反引号闭合要求此前出现奇数个裸三反引号：成对的是正文里的
  // 代码块，最后一个是外层闭合。全成对说明模型漏写了外层闭合，取到末尾；
  // 不能再用「第一个裸三反引号」当闭合，否则正文里不带语言标记的代码块
  // 会把笔记截断，并让消息文本被永久裁掉。
  if (bareThreeFences.length % 2 === 1) {
    const closing = bareThreeFences[bareThreeFences.length - 1];
    return {
      content: body.slice(0, closing.index),
      index: opener.index,
      end: contentStart + closing.end
    };
  }
  return {
    content: body,
    index: opener.index,
    end: markdown.length
  };
}

export function buildSidetFileToolContext(): string {
  return buildSidetFileToolPrompt();
}

export function buildSidetFileToolSummaryContext(): string {
  return buildSidetFileToolSummaryPrompt();
}

export function parseSidetToolActionPreview(
  markdown: string,
  sourceLabel: string,
  options: { updatedAt?: string } = {}
): AgentActionPreview | null {
  const action = parseSidetToolAction(markdown);
  if (!action) {
    return null;
  }

  const isCreate = action.tool === "create_note";
  const isReplace = action.tool === "replace_note";
  const normalizedTargetPath = normalizeAgentActionTargetPath(action.targetPath);
  if (!normalizedTargetPath) {
    return null;
  }
  const normalizedContent = (isCreate || isReplace) && isWikiNotePath(normalizedTargetPath)
    ? buildNormalizedWikiMarkdownFromPath(normalizedTargetPath, action.content, {}, {
      preserveUpdatedAt: false,
      // 用消息创建时间而不是每次解析时的当前分钟：签名、卡片状态和持久化的
      // agentAction 必须跨分钟稳定，否则重渲染会退回待确认并允许重复写入。
      updatedAt: options.updatedAt
    })
    : action.content;

  return {
    kind: isCreate ? "create-note" : isReplace ? "replace-note" : "append-note",
    title: action.title || (isCreate ? "创建笔记" : isReplace ? "覆盖现有笔记" : "追加到笔记"),
    targetPath: normalizedTargetPath,
    content: normalizedContent,
    sourceLabel,
    riskNotes: [
      "这是 AI 在对话中请求的文件动作，只有确认后才会执行。",
      isCreate
        ? "将创建一篇新的 Markdown 笔记；目标路径已存在时会拒绝覆盖。"
        : isReplace
          ? "将覆盖目标 Markdown 笔记的现有内容；目标不存在或不是 Markdown 时会拒绝。"
          : "将追加到已有 Markdown 笔记末尾；目标不存在或不是 Markdown 时会拒绝。",
      action.reason ? `AI 理由：${action.reason}` : "确认前请检查目标路径和写入内容。"
    ],
    confirmLabel: isCreate ? "确认创建" : isReplace ? "确认覆盖" : "确认追加",
    successMessage: isCreate ? "已创建笔记" : isReplace ? "已覆盖笔记" : "已追加到笔记",
    targetPathEditable: isReplace ? false : undefined
  };
}

function splitActionHeaderAndContent(rawBlock: string): {
  headerText: string;
  content: string;
} | null {
  // header 可能来自 CRLF 消息；`.` 不匹配 `\r`，不先拆掉会让整段 header 校验失败。
  const lines = rawBlock.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "---") {
      continue;
    }
    const headerLines = lines.slice(0, index).filter((line) => line.trim().length > 0);
    if (headerLines.length === 0) {
      continue;
    }
    // 分隔线之前的非空行必须全部是 header 字段；正文里的水平线、Wiki YAML
    // 或标题不会满足这个条件，避免从任意 `---` 兜底切分把正文截掉半段。
    if (!headerLines.every((line) => /^[A-Za-z][\w-]*\s*:\s*.*$/.test(line))) {
      continue;
    }
    const content = lines.slice(index + 1).join("\n").trim();
    if (!content) {
      return null;
    }
    return {
      headerText: headerLines.join("\n"),
      content
    };
  }
  return null;
}

/**
 * 旧三反引号外层里出现代码块时，模型有时会漏写外层闭合围栏；此时动作正文的
 * 三反引号数量为奇数。补一个闭合围栏，避免写入一篇代码块未闭合的笔记。
 */
function balanceFencedCodeBlocks(content: string): string {
  const fenceCount = (content.match(/```/g) ?? []).length;
  return fenceCount % 2 === 1 ? `${content}\n\`\`\`` : content;
}

function parseSidetToolAction(markdown: string): SidetToolAction | null {
  const block = extractActionBlock(markdown);
  if (!block) {
    return null;
  }

  const rawBlock = block.content.trim();
  const split = splitActionHeaderAndContent(rawBlock);
  if (!split) {
    return null;
  }

  const content = balanceFencedCodeBlocks(split.content);
  const fields = parseHeaderFields(split.headerText);
  const tool = fields.tool as SidetToolKind | undefined;
  const targetPath = fields.targetpath || fields.target_path || fields.target || fields.path || "";
  if (tool !== "create_note" && tool !== "append_note" && tool !== "replace_note") {
    return null;
  }
  if (!targetPath.trim()) {
    return null;
  }

  return {
    tool,
    targetPath: targetPath.trim(),
    title: fields.title?.trim(),
    reason: fields.reason?.trim(),
    content
  };
}

function parseHeaderFields(headerText: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }
    const rawValue = (match[2] ?? "").trim();
    // 模型常给路径加引号；引号不应进入实际目标路径。
    fields[match[1].toLowerCase()] = rawValue.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
  }
  return fields;
}

/**
 * 界面 / 复制 / 检索只保留动作块之前的说明文字。旧消息可能把“请确认 / 确认后
 * 我再创建”写在了动作块后面；卡片已经承载确认，这些尾巴不应再露给用户。
 */
export function stripSidetActionAndFollowing(markdown: string): string {
  const block = extractActionBlock(markdown);
  if (!block) {
    return markdown.trim();
  }
  return markdown.slice(0, block.index).trim();
}

/**
 * 文件动作协议要求 sidet-action 是回复的最后内容；模型仍可能在本该结束的卡片块
 * 后面补一句“请确认/是否创建”。卡片本身就是确认入口，这里在消息落库前裁掉
 * 块后的多余文字，保证用户只看到块前说明与卡片，不出现第二次确认。
 * 只处理解析成功的完整动作块；没有动作块或块不完整时原样返回。
 */
export function trimTextAfterSidetActionBlock(markdown: string): string {
  if (!parseSidetToolAction(markdown)) {
    return markdown;
  }
  const block = extractActionBlock(markdown);
  if (!block) {
    return markdown;
  }
  return markdown.slice(0, block.end).trimEnd();
}
