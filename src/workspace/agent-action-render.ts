/**
 * 写入提案的共享绘制件：卡片与调整弹窗共用同一套差异 / 新内容 DOM。
 * 只负责结构，颜色、间距和滚动由 `styles.css` 的同名类承担。
 */
import {
  splitAgentActionFrontmatter,
  type AgentActionDiff
} from "../agent/actions/agent-action-diff";

export function renderAgentActionDiff(parentEl: HTMLElement, diff: AgentActionDiff): void {
  const diffEl = parentEl.createDiv({ cls: "sidet-agent-action-diff" });
  for (const entry of diff.entries) {
    if (entry.kind === "gap") {
      diffEl.createDiv({
        cls: "sidet-agent-action-gap",
        text: entry.label ?? `… 中间 ${entry.skipped} 行未变 …`
      });
      continue;
    }
    const lineEl = diffEl.createDiv({
      cls: `sidet-agent-action-diff-line is-${entry.line.type}`
    });
    lineEl.createSpan({
      cls: "sidet-agent-action-diff-sign",
      text: entry.line.type === "add" ? "+" : entry.line.type === "remove" ? "−" : ""
    });
    lineEl.createSpan({
      cls: "sidet-agent-action-diff-text",
      text: entry.line.text || " "
    });
  }
}

export function renderAgentActionNewContent(
  parentEl: HTMLElement,
  content: string,
  renderMarkdown: (parentEl: HTMLElement, markdown: string) => void
): void {
  const previewEl = parentEl.createDiv({
    cls: "sidet-agent-action-preview markdown-rendered"
  });
  const parts = splitAgentActionFrontmatter(content);
  renderMarkdown(previewEl, parts.body);
}
