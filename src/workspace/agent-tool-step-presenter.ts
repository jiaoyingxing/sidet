import type { AgentToolStep } from "../agent/tools/agent-tool-loop";
import type { MessageMetaPanel } from "../types";

/**
 * 普通对话工具循环的过程面板与正文分隔。
 *
 * 只做纯展示编排：不读写会话、不依赖 Obsidian；面板沿用现役 step 分组，
 * 通过 `group` / `groupLabel` 交给现有渲染器归组。
 */
export type AgentToolStepPanel = Pick<
  MessageMetaPanel,
  "kind" | "label" | "display" | "group" | "groupLabel"
>;

export interface AgentToolStepPresenterOptions {
  appendPanelText: (panel: AgentToolStepPanel, chunk: string) => void;
  appendVisibleContent: (chunk: string) => void;
}

export interface AgentToolStepPresenter {
  handleStep: (step: AgentToolStep) => void;
  appendVisibleContent: (chunk: string) => void;
}

const AGENT_TOOL_STEP_GROUP = "agent-tool";
const AGENT_TOOL_STEP_GROUP_LABEL = "工具过程";

export function createAgentToolStepPresenter(
  options: AgentToolStepPresenterOptions
): AgentToolStepPresenter {
  let nextStepIndex = 1;
  let pendingStep: { index: number; summary: string } | null = null;
  let needsSeparator = false;
  let hasVisibleContent = false;

  const handleStep = (step: AgentToolStep): void => {
    if (step.status === "running") {
      // 面板 API 只追加文本，running 不写占位，完成时一次性写入结果。
      pendingStep = { index: nextStepIndex, summary: step.summary };
      nextStepIndex += 1;
      return;
    }

    const stepIndex = pendingStep?.summary === step.summary
      ? pendingStep.index
      : nextStepIndex++;
    pendingStep = null;

    const detail = step.detail?.trim();
    const chunk = detail
      ? step.status === "error" ? `失败：${detail}` : detail
      : "完成";
    options.appendPanelText({
      kind: `tool-step-${stepIndex}`,
      label: step.summary,
      display: "step",
      group: AGENT_TOOL_STEP_GROUP,
      groupLabel: AGENT_TOOL_STEP_GROUP_LABEL
    }, chunk);
    needsSeparator = true;
  };

  const appendVisibleContent = (chunk: string): void => {
    if (!chunk) {
      return;
    }
    if (!chunk.trim()) {
      options.appendVisibleContent(chunk);
      return;
    }

    if (needsSeparator && hasVisibleContent) {
      options.appendVisibleContent("\n\n");
    }
    needsSeparator = false;
    hasVisibleContent = true;
    options.appendVisibleContent(chunk);
  };

  return { handleStep, appendVisibleContent };
}
