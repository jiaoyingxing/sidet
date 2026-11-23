import { Notice, TFile, setIcon, setTooltip } from "obsidian";
import type { MessageKnowledgeBaseRoutingInfo } from "../types";
import type { WorkspaceController } from "./workspace-controller";

interface RenderKnowledgeBaseRoutingOptions {
  controller: WorkspaceController;
}

export function renderMessageKnowledgeBaseRouting(
  parentEl: HTMLElement,
  routing: MessageKnowledgeBaseRoutingInfo | undefined,
  options: RenderKnowledgeBaseRoutingOptions
): void {
  if (!routing || routing.status === "searching") {
    return;
  }
  if (routing.status !== "error" && routing.hits.length === 0) {
    return;
  }

  const containerEl = parentEl.createDiv({ cls: "sidet-message-routing-hint" });
  if (routing.status === "error") {
    containerEl.createDiv({
      cls: "sidet-message-routing-hint-note",
      text: "知识库检索失败，请重新发送"
    });
    return;
  }

  const hitsEl = containerEl.createDiv({ cls: "sidet-message-routing-hits" });
  for (const hit of routing.hits) {
    const buttonEl = hitsEl.createEl("button", {
      cls: "sidet-message-routing-hit"
    });
    buttonEl.type = "button";
    buttonEl.setAttribute("aria-label", `打开命中笔记：${hit.basename}`);
    setTooltip(buttonEl, `${hit.kindLabel} · ${hit.path}`);
    const hitIconEl = buttonEl.createSpan({ cls: "sidet-message-routing-hit-icon" });
    hitIconEl.setAttribute("aria-hidden", "true");
    setIcon(hitIconEl, "file-text");
    buttonEl.createSpan({
      cls: "sidet-message-routing-hit-label",
      text: hit.basename
    });
    buttonEl.addEventListener("click", () => {
      void openKnowledgeBaseHit(hit.path, options.controller);
    });
  }
}

async function openKnowledgeBaseHit(path: string, controller: WorkspaceController): Promise<void> {
  const app = controller.getApp();
  const target = app.vault.getAbstractFileByPath(path);
  if (!(target instanceof TFile)) {
    new Notice("目标笔记不存在。", 1800);
    return;
  }

  const leaf = app.workspace.getLeaf("tab");
  if (!leaf) {
    new Notice("无法打开命中笔记。", 1800);
    return;
  }

  await leaf.openFile(target);
}
