import type { ContextBundle, ContextBundleSection } from "../context-bundle";
import { ALL_KNOWLEDGE_BASES_DISPLAY_NAME } from "../../constants";

interface AgentRouterContextBundleInput {
  skillRouteLines: string[];
  knowledgeBaseRouteLines: string[];
  selectedKnowledgeBaseNote?: string | null;
  wikiRouteLines: string[];
  wikiSections: ContextBundleSection[];
  truncated: boolean;
}

export function buildAgentRouterContextBundle(input: AgentRouterContextBundleInput): ContextBundle {
  const sections: ContextBundleSection[] = [];

  if (input.skillRouteLines.length > 0) {
    sections.push({
      heading: "Skill 路由：",
      notes: input.skillRouteLines
    });
  }

  if (input.knowledgeBaseRouteLines.length > 0) {
    sections.push({
      heading: "已识别知识库：",
      notes: input.knowledgeBaseRouteLines
    });
  }

  if (input.selectedKnowledgeBaseNote?.trim()) {
    sections.push({
      heading: "当前知识库选择：",
      notes: [input.selectedKnowledgeBaseNote.trim()]
    });
  }

  if (input.wikiRouteLines.length > 0) {
    sections.push({
      heading: "相关 Wiki 路由：",
      notes: input.wikiRouteLines
    });
  }

  sections.push(...input.wikiSections);

  return {
    kind: "agent-router-context",
    title: "Sidet 轻智能体上下文（发送前自动选择）：",
    description: [
      "说明：以下内容只作为本次请求的辅助上下文，不会写入对话记录，也不会自动修改 vault。",
      "说明：Wiki 先按摘要、大纲和链接做轻路由；Skill 只提供索引、边界和操作协议。"
    ],
    sections,
    footer: [
      "使用要求：",
      "- 先判断上下文是否与用户问题相关；不相关就忽略。",
      "- 回答涉及库内事实时，优先引用已给出的路径或双链。",
      "- 任何写文件、新建文件或修改文件的建议，都必须走 Sidet 的预览确认链。",
      "- 不要声称读取了未提供全文的文件。",
      `- 选择“${ALL_KNOWLEDGE_BASES_DISPLAY_NAME}”时，也只在已识别知识库范围内做轻路由。`
    ],
    truncated: input.truncated
  };
}
