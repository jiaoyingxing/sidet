import {
  MAX_AGENT_BUILT_IN_SKILLS,
  MAX_AGENT_ROUTER_CONTEXT_CHARS
} from "../constants";
import type { MessageAttachment } from "../types";
import { findRelevantBuiltInSkills } from "./skills/builtin-skills";
import { formatContextBundleBlock, trimContextTextToBudget } from "./context-bundle";
import { buildAgentRouterContextBundle } from "./prompts/router-context-prompts";

export interface VaultAgentPreSendContextResult {
  requestContext: string | null;
}

/**
 * 发送前只注入内置 Skill 卡。
 *
 * 用户 Skill 库、Wiki 记忆与知识库范围检索已退场；这里保留硬编码的领域提示，
 * 不再读取 `Sidet/Skills`、`Sidet/Wiki` 或叶子上的知识库选择。
 */
export class VaultAgentRouterContextBuilder {
  async build(
    text: string,
    attachments: MessageAttachment[]
  ): Promise<VaultAgentPreSendContextResult> {
    const skillCards = findRelevantBuiltInSkills(text, attachments, MAX_AGENT_BUILT_IN_SKILLS);
    if (skillCards.length === 0) {
      return { requestContext: null };
    }

    const skillRouteLines = skillCards.flatMap((card, index) => {
      const lines = [
        `${index + 1}. ${card.name}`,
        `适用：${card.useWhen}`,
        `边界：${card.constraints.join("；")}`
      ];
      if (card.protocol?.length) {
        lines.push(`协议：${card.protocol.join("；")}`);
      }
      lines.push(`来源：${card.sourcePath ? `${card.source} · [[${card.sourcePath}]]` : card.source}`);
      return lines;
    });

    const bundle = buildAgentRouterContextBundle({
      skillRouteLines,
      truncated: false
    });

    return {
      requestContext: trimContextTextToBudget(
        formatContextBundleBlock(bundle),
        MAX_AGENT_ROUTER_CONTEXT_CHARS
      ).text
    };
  }
}
