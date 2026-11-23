import {
  DEFAULT_AGENT_DRAFT_FOLDER,
  DEFAULT_AGENT_MEMORY_FOLDER,
  DEFAULT_AGENT_SKILL_FOLDER,
  DEFAULT_AGENT_WIKI_FOLDER,
  DEFAULT_WEB_CLIPPING_FOLDER
} from "../../constants";
import { buildWikiSchemaGuidance } from "../wiki/wiki-note-schema";

export function buildSidetFileToolSummaryContext(): string {
  return [
    "Sidet 文件动作能力：",
    "- 如果对方明确要求把内容保存成笔记、写入知识库、追加到现有笔记或更新现有笔记，你可以后续请求单条 sidet-action。",
    "- Sidet 只会在用户确认后执行；不要声称已经写入文件。",
    "- 如果当前消息没有明确写入要求，就先正常回答，不要主动输出 sidet-action。",
    "- 不要请求删除、移动、批量改名或无确认覆盖。"
  ].join("\n");
}

export function buildSidetFileToolContext(): string {
  return [
    "Sidet 文件动作协议：",
    "- 只有当用户明确要求保存、写入、整理成笔记、整理到知识库、创建 Skill 或更新已有笔记时，才使用 sidet-action。",
    "- Sidet 只会在用户确认后执行；不要声称已经写入文件。",
    "- 可用工具：create_note / append_note / replace_note。",
    "- 一次最多输出一个动作；不要请求删除、移动、批量改名或无确认改写。",
    `- 默认路径：Wiki -> ${DEFAULT_AGENT_WIKI_FOLDER}；Skill -> ${DEFAULT_AGENT_SKILL_FOLDER}；草稿 -> ${DEFAULT_AGENT_DRAFT_FOLDER}；记忆候选 -> ${DEFAULT_AGENT_MEMORY_FOLDER}；网页剪藏 -> ${DEFAULT_WEB_CLIPPING_FOLDER}。`,
    "- 如果用户明确指定路径，优先使用用户路径。",
    "- 如果目标已经明确且应整体更新，优先 replace_note；不要平行新建近名文件。",
    `- 写入 ${DEFAULT_AGENT_WIKI_FOLDER} 时，内容必须是标准 Wiki Markdown：YAML frontmatter -> 唯一标题 -> 正文。`,
    `- 写入 ${DEFAULT_AGENT_WIKI_FOLDER}/Index.md 时，它只做知识库根页，不承接长正文。`,
    "- 不要写 #sidet_type: 这种伪属性行，也不要重复写同一个标题。",
    ...buildWikiSchemaGuidance(),
    "- sidet-action 格式：",
    "```sidet-action",
    "tool: replace_note",
    "targetPath: Sidet/Wiki/示例.md",
    "title: 覆盖现有笔记",
    "reason: 为什么建议直接更新这个目标",
    "---",
    "---",
    "sidet_type: \"knowledge-base\"",
    "summary: \"一句话摘要\"",
    "status: \"active\"",
    "---",
    "# 笔记标题",
    "Markdown 正文",
    "```"
  ].join("\n");
}
