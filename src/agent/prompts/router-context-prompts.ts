import type { ContextBundle } from "../context-bundle";

interface AgentRouterContextBundleInput {
  skillRouteLines: string[];
  truncated: boolean;
}

export function buildAgentRouterContextBundle(input: AgentRouterContextBundleInput): ContextBundle {
  if (input.skillRouteLines.length === 0) {
    return {
      kind: "agent-router-context",
      title: "Sidet 轻智能体上下文（发送前自动选择）：",
      description: ["说明：本轮没有命中可注入的 Skill。"],
      sections: [],
      footer: [],
      truncated: input.truncated
    };
  }

  return {
    kind: "agent-router-context",
    title: "Sidet 轻智能体上下文（发送前自动选择）：",
    description: [
      "说明：以下内容只作为本次请求的辅助上下文，不会写入对话记录，也不会自动修改 vault。",
      "说明：Skill 只提供索引、边界和操作协议。"
    ],
    sections: [
      {
        heading: "Skill 路由：",
        notes: input.skillRouteLines
      }
    ],
    footer: [
      "使用要求：",
      "- 先判断上下文是否与用户问题相关；不相关就忽略。",
      "- 回答涉及库内事实时，优先引用已给出的路径或双链。",
      "- 写文件、新建文件或修改文件的建议直接输出 sidet-action 进入预览确认链；卡片本身是确认入口，不要先在聊天里追问用户是否确认。",
      "- 不要声称读取了未提供全文的文件。"
    ],
    truncated: input.truncated
  };
}
